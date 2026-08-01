import {parseProxy} from "./proxy-store.js";
import {normalizeRemoteStatus} from "./status.js";

const pollIntervalMs = 2000;
const cleanupTimeoutMs = 5000;

class RunTimeoutError extends Error {}

function sleep(ms) {
  let timer;
  const wait = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  wait.cancel = () => clearTimeout(timer);
  return wait;
}

function timestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function profileId(payload) {
  return payload?.profile_id ?? payload?.id ?? payload?.data?.profile_id ?? payload?.data?.id ?? null;
}

function remoteRunId(payload) {
  return payload?.run_id ?? payload?.id ?? payload?.data?.run_id ?? payload?.data?.id ?? null;
}

function proxyValue(proxy) {
  return `${proxy.scheme}://${proxy.host}:${proxy.port}${proxy.username === null ? "" : `:${proxy.username}:${proxy.password}`}`;
}

export class RunService {
  constructor({gemloginClient, proxyStore, runStore, clock = () => new Date(), sleep: sleepImpl = sleep, runTimeoutSeconds = 300, cleanupTimeout = cleanupTimeoutMs}) {
    Object.assign(this, {gemloginClient, proxyStore, runStore, clock, sleep: sleepImpl, runTimeoutSeconds, cleanupTimeout});
    this.tasks = new Set();
  }

  validate(input) {
    if (!String(input?.workflow_id || "").trim()) throw new Error("workflow_id is required");
    if (!["existing", "new"].includes(input.profile_mode)) throw new Error("profile_mode must be existing or new");
    if (input.profile_mode === "existing") {
      if (input.profile_id == null || input.profile_id === "") throw new Error("profile_id is required");
      if (input.cleanup_requested) throw new Error("cleanup is only available for new profiles");
    } else {
      if (!String(input.profile_name || "").trim()) throw new Error("profile_name is required");
      if (input.group_id == null || input.group_id === "") throw new Error("group_id is required");
      const proxyMode = input.proxy_mode ?? "none";
      if (!["none", "manual", "random"].includes(proxyMode)) throw new Error("proxy_mode must be none, manual, or random");
      if (proxyMode === "manual") parseProxy(input.raw_proxy);
    }
  }

  async start(input) {
    this.validate(input);
    if (this.runStore.findActive()) throw new Error("an active run already exists");
    const run = this.runStore.create({
      workflow_id: String(input.workflow_id), workflow_name: input.workflow_name ?? null,
      profile_mode: input.profile_mode, profile_id: input.profile_mode === "existing" ? String(input.profile_id) : null,
      cleanup_requested: Boolean(input.cleanup_requested), status: "queued", started_at: timestamp(this.clock),
      cleanup_status: input.cleanup_requested ? "pending" : "not_requested"
    });
    const task = this.execute(run.id, input).catch(() => {});
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    return this.get(run.id);
  }

  get(runId) {
    const run = this.runStore.get(runId);
    return run && {...run};
  }

  async drain() { await Promise.all([...this.tasks]); }

  async pollStatus(workflowId, profileId, deadline) {
    return this.runWithDeadline(deadline, (signal) => this.gemloginClient.checkScriptStatus(workflowId, profileId, {signal})).then(normalizeRemoteStatus);
  }

  async runWithDeadline(deadline, operation) {
    const remaining = deadline - new Date(timestamp(this.clock)).getTime();
    if (remaining <= 0) throw new RunTimeoutError();
    const controller = new AbortController();
    const timeout = this.sleep(remaining);
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)).then((value) => ({value}), (error) => ({error})),
        Promise.resolve(timeout).then(() => ({timedOut: true}))
      ]);
      if (result.timedOut) {
        controller.abort();
        throw new RunTimeoutError();
      }
      if (result.error) throw result.error;
      return result.value;
    } finally {
      timeout.cancel?.();
    }
  }

  async execute(runId, input) {
    let run = this.runStore.get(runId);
    const deadline = new Date(run.started_at).getTime() + this.runTimeoutSeconds * 1000;
    try {
      let currentProfileId = run.profile_id;
      if (run.profile_mode === "new") {
        let proxy;
        if (input.proxy_mode === "random") {
          proxy = this.proxyStore.pickRandomEnabled();
          if (!proxy) throw new Error("no enabled proxy available");
          run = this.runStore.update(runId, {proxy_id: proxy.id});
        } else if (input.proxy_mode === "manual") {
          proxy = parseProxy(input.raw_proxy);
        }
        const created = await this.runWithDeadline(deadline, (signal) => this.gemloginClient.createProfile({name: input.profile_name, group_id: String(input.group_id), ...(proxy ? {proxy: proxyValue(proxy)} : {})}, {signal}));
        currentProfileId = profileId(created);
        if (currentProfileId == null) throw new Error("profile creation failed");
        run = this.runStore.update(runId, {created_profile_id: String(currentProfileId)});
        await this.runWithDeadline(deadline, (signal) => this.gemloginClient.startProfile(currentProfileId, {signal}));
        await this.runWithDeadline(deadline, (signal) => this.gemloginClient.refreshProfileList({signal}));
      }
      const execute = run.profile_mode === "new" ? this.gemloginClient.executeLocal.bind(this.gemloginClient) : this.gemloginClient.executeCloud.bind(this.gemloginClient);
      const submitted = await this.runWithDeadline(deadline, (signal) => execute({
        profileId: currentProfileId, workflowId: run.workflow_id, parameter: input.parameter ?? {},
        closeBrowser: run.profile_mode === "new" && run.cleanup_requested
      }, {signal}));
      run = this.runStore.update(runId, {status: "submitted", remote_run_id: run.profile_mode === "new" ? null : remoteRunId(submitted)});
      let observedRunning = false;
      const startupDeadline = Math.min(deadline, new Date(timestamp(this.clock)).getTime() + 15000);
      while (true) {
        const status = await this.pollStatus(run.workflow_id, currentProfileId, deadline);
        if (status === "running") observedRunning = true;
        if (status === "success") return this.finish(runId, "success", null, deadline);
        if (status === "failed") return this.finish(runId, "failed", "remote workflow failed", deadline);
        if (status === "not_running" && observedRunning) return this.finish(runId, "success", null, deadline);
        if (status === "not_running" && new Date(timestamp(this.clock)).getTime() >= startupDeadline) {
          return this.finish(runId, "failed", "workflow did not start", deadline);
        }
        if (status === "timeout" || new Date(timestamp(this.clock)).getTime() >= deadline) return this.finish(runId, "timeout", "workflow timed out", deadline);
        run = this.runStore.update(runId, {status: "running"});
        await this.sleep(pollIntervalMs);
      }
    } catch (error) {
      return this.finish(runId, error instanceof RunTimeoutError ? "timeout" : "failed", error instanceof RunTimeoutError ? "workflow timed out" : "workflow execution failed", deadline);
    }
  }

  async finish(runId, status, errorMessage, deadline) {
    const run = this.runStore.get(runId);
    const terminal = this.runStore.update(runId, {
      status, error_message: errorMessage, cleanup_status: run.cleanup_requested ? "pending" : "not_requested"
    });
    let cleanupStatus = terminal.cleanup_status;
    try { cleanupStatus = await this.cleanup(terminal, Math.max(deadline, new Date(timestamp(this.clock)).getTime()) + this.cleanupTimeout); }
    catch { cleanupStatus = "failed"; }
    return this.runStore.update(runId, {status: "done", cleanup_status: cleanupStatus, finished_at: timestamp(this.clock)});
  }

  async cleanup(run, deadline) {
    if (!run.cleanup_requested || !run.created_profile_id) return run.cleanup_status === "pending" ? "failed" : run.cleanup_status;
    let failed = false;
    let deleted = false;
    try { await this.runWithDeadline(deadline, (signal) => this.gemloginClient.closeProfile(run.created_profile_id, {signal})); } catch { failed = true; }
    try { await this.runWithDeadline(deadline, (signal) => this.gemloginClient.deleteProfile(run.created_profile_id, {signal})); deleted = true; }
    catch {
      try { await this.runWithDeadline(deadline, (signal) => this.gemloginClient.deleteProfile(run.created_profile_id, {signal})); deleted = true; } catch { failed = true; }
    }
    if (deleted) try { await this.runWithDeadline(deadline, (signal) => this.gemloginClient.refreshProfileList({signal})); } catch {}
    return failed ? "failed" : "done";
  }

  async recover() {
    let run;
    const find = this.runStore.findRecoverable?.bind(this.runStore) ?? this.runStore.findActive.bind(this.runStore);
    while ((run = find())) {
      const active = ["queued", "submitted", "running"].includes(run.status);
      const recoverable = active ? this.runStore.update(run.id, {status: "failed", error_message: "run interrupted by restart"}) : run;
      const cleanupStatus = await this.cleanup(recoverable, new Date(timestamp(this.clock)).getTime() + this.cleanupTimeout);
      this.runStore.update(run.id, {status: "done", cleanup_status: cleanupStatus, finished_at: timestamp(this.clock)});
    }
  }
}
