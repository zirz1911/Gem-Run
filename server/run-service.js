import {parseProxy} from "./proxy-store.js";
import {normalizeRemoteStatus} from "./status.js";

const pollIntervalMs = 2000;

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
  constructor({gemloginClient, proxyStore, runStore, clock = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), runTimeoutSeconds = 300}) {
    Object.assign(this, {gemloginClient, proxyStore, runStore, clock, sleep, runTimeoutSeconds});
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
      cleanup_requested: Boolean(input.cleanup_requested), status: "queued",
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

  async execute(runId, input) {
    let run = this.runStore.update(runId, {started_at: timestamp(this.clock)});
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
        const created = await this.gemloginClient.createProfile({name: input.profile_name, group_id: String(input.group_id), ...(proxy ? {proxy: proxyValue(proxy)} : {})});
        currentProfileId = profileId(created);
        if (currentProfileId == null) throw new Error("profile creation failed");
        run = this.runStore.update(runId, {created_profile_id: String(currentProfileId)});
      }
      const submitted = await this.gemloginClient.executeCloud({
        profileId: currentProfileId, workflowId: run.workflow_id, parameter: input.parameter ?? {},
        closeBrowser: run.profile_mode === "new" && run.cleanup_requested
      });
      run = this.runStore.update(runId, {status: "submitted", remote_run_id: remoteRunId(submitted)});
      const deadline = new Date(run.started_at).getTime() + this.runTimeoutSeconds * 1000;
      while (true) {
        const status = normalizeRemoteStatus(await this.gemloginClient.checkScriptStatus(run.workflow_id, currentProfileId));
        if (status === "success") return this.finish(runId, null);
        if (status === "failed") return this.finish(runId, "remote workflow failed");
        if (status === "timeout" || new Date(timestamp(this.clock)).getTime() >= deadline) return this.finish(runId, "workflow timed out");
        run = this.runStore.update(runId, {status: "running"});
        await this.sleep(pollIntervalMs);
      }
    } catch {
      return this.finish(runId, "workflow execution failed");
    }
  }

  async finish(runId, errorMessage) {
    const run = this.runStore.update(runId, {status: "done", error_message: errorMessage, finished_at: timestamp(this.clock)});
    await this.cleanup(run);
  }

  async cleanup(run) {
    if (!run.cleanup_requested || !run.created_profile_id) return;
    let failed = false;
    try { await this.gemloginClient.closeProfile(run.created_profile_id); } catch { failed = true; }
    try { await this.gemloginClient.deleteProfile(run.created_profile_id); }
    catch {
      try { await this.gemloginClient.deleteProfile(run.created_profile_id); } catch { failed = true; }
    }
    this.runStore.update(run.id, {cleanup_status: failed ? "failed" : "done"});
  }

  async recover() {
    let run;
    while ((run = this.runStore.findActive())) {
      const failed = this.runStore.update(run.id, {status: "failed", error_message: "run interrupted by restart", finished_at: timestamp(this.clock)});
      await this.cleanup(failed);
    }
  }
}
