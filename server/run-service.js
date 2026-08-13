import {randomUUID} from "node:crypto";
import {parseProxy} from "./proxy-store.js";
import {normalizeRemoteStatus} from "./status.js";

const pollIntervalMs = 2000;
const cleanupTimeoutMs = 5000;

class RunTimeoutError extends Error {}
class RunCancelledError extends Error {}

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

function profileName(name, index, total) {
  return total === 1 ? name : `${name}-${String(index + 1).padStart(2, "0")}`;
}

function closeBrowserRequested(run) { return Boolean(run.close_browser ?? run.cleanup_requested); }
function deleteProfileRequested(run) { return Boolean(run.delete_profile ?? run.cleanup_requested); }

export class RunService {
  constructor({gemloginClient, proxyStore, runStore, clock = () => new Date(), sleep: sleepImpl = sleep, runTimeoutSeconds = 300, cleanupTimeout = cleanupTimeoutMs, gemloginExecutionMode = "cloud"}) {
    Object.assign(this, {gemloginClient, proxyStore, runStore, clock, sleep: sleepImpl, runTimeoutSeconds, cleanupTimeout, gemloginExecutionMode});
    this.tasks = new Set();
    this.refreshLock = Promise.resolve();
    this.cancelled = new Set();
    this.controllers = new Map();
  }

  validate(input) {
    if (!String(input?.workflow_id || "").trim()) throw new Error("workflow_id is required");
    if (!["existing", "new"].includes(input.profile_mode)) throw new Error("profile_mode must be existing or new");
    for (const field of ["cleanup_requested", "close_browser", "delete_profile"]) {
      if (input[field] !== undefined && typeof input[field] !== "boolean") throw new Error(`${field} must be a boolean`);
    }
    const deleteProfile = input.delete_profile ?? input.cleanup_requested ?? false;
    if (input.profile_mode === "existing") {
      const profileIds = input.profile_ids ?? [input.profile_id];
      if (!Array.isArray(profileIds) || !profileIds.length || profileIds.some((id) => !["string", "number"].includes(typeof id) || !String(id).trim()) || new Set(profileIds.map(String)).size !== profileIds.length) throw new Error("profile_ids are invalid");
      if (deleteProfile) throw new Error(input.cleanup_requested ? "cleanup is only available for new profiles" : "delete_profile is only available for new profiles");
    } else {
      if (input.profile_ids !== undefined) throw new Error("profile_ids are only available for existing profiles");
      if (!String(input.profile_name || "").trim()) throw new Error("profile_name is required");
      if (input.group_id == null || input.group_id === "") throw new Error("group_id is required");
      const proxyMode = input.proxy_mode ?? "none";
      if (!["none", "manual", "random"].includes(proxyMode)) throw new Error("proxy_mode must be none, manual, or random");
      if (proxyMode === "manual") parseProxy(input.raw_proxy);
    }
    const repeatCount = Number(input.repeat_count ?? 1);
    if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 500) throw new Error("repeat_count must be between 1 and 500");
    if (input.profile_mode === "existing" && repeatCount !== 1) throw new Error("repeat_count is only available for new profiles");
    const executionMode = input.execution_mode ?? "sequential";
    if (!["sequential", "parallel"].includes(executionMode)) throw new Error("execution_mode must be sequential or parallel");
    const maxConcurrency = Number(input.max_concurrency ?? (executionMode === "parallel" ? 2 : 1));
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 500) throw new Error("max_concurrency must be between 1 and 500");
    const batchSize = input.profile_mode === "existing" ? (input.profile_ids ?? [input.profile_id]).length : repeatCount;
    if (maxConcurrency > batchSize) throw new Error("max_concurrency cannot exceed profile count");
  }

  async start(input, source = {}) {
    this.validate(input);
    if (this.runStore.findActive()) throw new Error("an active run already exists");
    const profileIds = input.profile_mode === "existing" ? (input.profile_ids ?? [input.profile_id]) : [];
    const repeatCount = input.profile_mode === "existing" ? profileIds.length : Number(input.repeat_count ?? 1);
    const executionMode = input.execution_mode ?? "sequential";
    const deleteProfile = input.delete_profile ?? input.cleanup_requested ?? false;
    const maxConcurrency = Number(input.max_concurrency ?? (executionMode === "parallel" ? 2 : 1));
    const batchId = repeatCount > 1 ? randomUUID() : null;
    const scheduleExecutionId = source.source === "schedule" ? (source.scheduleExecutionId ?? randomUUID()) : null;
    const assignedProxies = this.assignProxies(input, repeatCount);
    const runs = Array.from({length: repeatCount}, (_, index) => this.runStore.create({
      workflow_id: String(input.workflow_id), workflow_name: input.workflow_name ?? null,
      profile_mode: input.profile_mode, profile_id: input.profile_mode === "existing" ? String(profileIds[index]) : null,
      proxy_id: assignedProxies[index]?.id ?? null, cleanup_requested: Boolean(deleteProfile),
      close_browser: Boolean(input.close_browser ?? input.cleanup_requested ?? false), delete_profile: Boolean(deleteProfile), status: "queued",
      started_at: null, cleanup_status: deleteProfile ? "pending" : "not_requested", source: source.source ?? "manual",
      schedule_id: source.scheduleId ?? null, schedule_name: source.scheduleName ?? null,
      configured_profile_count: source.configuredProfileCount ?? null, profile_count_mode: source.profileCountMode ?? null,
      actual_profile_count: source.actualProfileCount ?? (source.source === "schedule" ? repeatCount : null), schedule_execution_id: scheduleExecutionId,
      batch_id: batchId, batch_index: batchId ? index + 1 : null, batch_total: batchId ? repeatCount : null
    }));
    const task = this.executeBatch(runs, input, assignedProxies, executionMode, maxConcurrency).catch(() => {}).finally(() => runs.forEach(({id}) => this.cancelled.delete(String(id))));
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    if (!batchId) return this.get(runs[0].id);
    return {batch_id: batchId, execution_mode: executionMode, max_concurrency: maxConcurrency, runs: runs.map(({id}) => this.get(id))};
  }

  assignProxies(input, count) {
    if (input.profile_mode !== "new" || input.proxy_mode !== "random") return Array(count).fill(null);
    const assigned = [];
    const used = [];
    for (let index = 0; index < count; index += 1) {
      const proxy = this.proxyStore.pickRandomEnabled(used);
      if (!proxy || used.includes(proxy.id)) throw new Error("not enough enabled proxies for batch");
      assigned.push(proxy);
      used.push(proxy.id);
    }
    return assigned;
  }

  async executeBatch(runs, input, assignedProxies, executionMode, maxConcurrency) {
    if (executionMode === "sequential") {
      for (const [index, run] of runs.entries()) await this.execute(run.id, input, assignedProxies[index]);
      return;
    }
    let next = 0;
    const worker = async () => {
      while (next < runs.length) {
        const index = next++;
        await this.execute(runs[index].id, input, assignedProxies[index]);
      }
    };
    await Promise.all(Array.from({length: Math.min(maxConcurrency, runs.length)}, worker));
  }

  get(runId) {
    const run = this.runStore.get(runId);
    return run && {...run};
  }

  async drain() { await Promise.all([...this.tasks]); }

  cancel(runId) {
    const run = this.runStore.get(runId);
    if (!run) throw new Error("run not found");
    if (!["queued", "submitted", "running", "cancelling"].includes(run.status)) throw new Error("run is not active");
    const runs = run.batch_id ? (this.runStore.listBatch?.(run.batch_id) ?? [run]) : [run];
    for (const target of runs) {
      if (!["queued", "submitted", "running", "cancelling"].includes(target.status)) continue;
      const id = String(target.id);
      this.cancelled.add(id);
      this.runStore.update(target.id, {status: "cancelling", error_message: "run cancellation requested"});
      for (const controller of this.controllers.get(id) ?? []) controller.abort();
    }
    return this.get(runId);
  }

  refreshProfileList(options = {}) {
    const refresh = this.refreshLock.then(() => this.gemloginClient.refreshProfileList(options));
    this.refreshLock = refresh.catch(() => {});
    return refresh;
  }

  async pollStatus(workflowId, profileId, deadline, runId) {
    return this.runWithDeadline(deadline, (signal) => this.gemloginClient.checkScriptStatus(workflowId, profileId, {signal}), runId).then(normalizeRemoteStatus);
  }

  async runWithDeadline(deadline, operation, runId = null, allowCancelled = false) {
    const key = runId == null ? null : String(runId);
    if (key && !allowCancelled && this.cancelled.has(key)) throw new RunCancelledError();
    const remaining = deadline - new Date(timestamp(this.clock)).getTime();
    if (remaining <= 0) throw new RunTimeoutError();
    const controller = new AbortController();
    if (key) {
      const controllers = this.controllers.get(key) ?? new Set();
      controllers.add(controller);
      this.controllers.set(key, controllers);
    }
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
      if (key && !allowCancelled && this.cancelled.has(key)) throw new RunCancelledError();
      if (result.error) throw result.error;
      return result.value;
    } finally {
      timeout.cancel?.();
      if (key) {
        const controllers = this.controllers.get(key);
        controllers?.delete(controller);
        if (controllers?.size === 0) this.controllers.delete(key);
      }
    }
  }

  async execute(runId, input, assignedProxy = null) {
    let run = this.runStore.update(runId, {started_at: timestamp(this.clock)});
    const deadline = new Date(run.started_at).getTime() + this.runTimeoutSeconds * 1000;
    try {
      if (this.cancelled.has(String(runId))) throw new RunCancelledError();
      let currentProfileId = run.profile_id;
      if (run.profile_mode === "new") {
        let proxy = assignedProxy;
        if (!proxy && input.proxy_mode === "random") {
          proxy = this.proxyStore.pickRandomEnabled();
          if (!proxy) throw new Error("no enabled proxy available");
          run = this.runStore.update(runId, {proxy_id: proxy.id});
        } else if (input.proxy_mode === "manual") {
          proxy = parseProxy(input.raw_proxy);
        }
        const created = await this.runWithDeadline(deadline, (signal) => this.gemloginClient.createProfile({
          profile_name: profileName(input.profile_name, (run.batch_index ?? 1) - 1, run.batch_total ?? 1),
          group_id: String(input.group_id),
          ...(proxy ? {raw_proxy: proxyValue(proxy)} : {}),
          os: {type: "macOS", version: "macos13"},
          country: "Thailand"
        }, {signal}), runId);
        currentProfileId = profileId(created);
        if (currentProfileId == null) throw new Error("profile creation failed");
        run = this.runStore.update(runId, {created_profile_id: String(currentProfileId)});
        await this.runWithDeadline(deadline, (signal) => this.gemloginClient.startProfile(currentProfileId, {signal}), runId);
        await this.runWithDeadline(deadline, (signal) => this.refreshProfileList({signal}), runId);
      }
      const executeWorkflow = this.gemloginExecutionMode === "local"
        ? this.gemloginClient.executeLocal.bind(this.gemloginClient)
        : this.gemloginClient.executeCloud.bind(this.gemloginClient);
      const submitted = await this.runWithDeadline(deadline, (signal) => executeWorkflow({
        profileId: currentProfileId, workflowId: run.workflow_id, parameter: input.parameter ?? {},
        closeBrowser: closeBrowserRequested(run) || (run.profile_mode === "new" && deleteProfileRequested(run))
      }, {signal}), runId);
      run = this.runStore.update(runId, {status: "submitted", remote_run_id: remoteRunId(submitted)});
      let observedRunning = false;
      const startupDeadline = Math.min(deadline, new Date(timestamp(this.clock)).getTime() + 15000);
      while (true) {
        const status = await this.pollStatus(run.workflow_id, currentProfileId, deadline, runId);
        if (status === "running") observedRunning = true;
        if (status === "success") return this.finish(runId, "success", null, deadline);
        if (status === "failed") return this.finish(runId, "failed", "remote workflow failed", deadline);
        if (status === "not_running" && observedRunning) return this.finish(runId, "success", null, deadline);
        if (this.gemloginExecutionMode !== "local" && status === "not_running" && new Date(timestamp(this.clock)).getTime() >= startupDeadline) {
          return this.finish(runId, "failed", "workflow did not start", deadline);
        }
        if (status === "timeout" || new Date(timestamp(this.clock)).getTime() >= deadline) return this.finish(runId, "timeout", "workflow timed out", deadline);
        run = this.runStore.update(runId, {status: "running"});
        await this.sleep(pollIntervalMs);
      }
    } catch (error) {
      return this.finish(runId, error instanceof RunCancelledError ? "cancelled" : error instanceof RunTimeoutError ? "timeout" : "failed",
        error instanceof RunCancelledError ? "run cancelled" : error instanceof RunTimeoutError ? "workflow timed out" : error?.message || "workflow execution failed", deadline);
    }
  }

  async finish(runId, status, errorMessage, deadline) {
    const run = this.runStore.get(runId);
    const terminal = this.runStore.update(runId, {
      status, error_message: errorMessage, cleanup_status: deleteProfileRequested(run) ? "pending" : "not_requested"
    });
    let cleanupStatus = terminal.cleanup_status;
    try { cleanupStatus = await this.cleanup(terminal, Math.max(deadline, new Date(timestamp(this.clock)).getTime()) + this.cleanupTimeout); }
    catch { cleanupStatus = "failed"; }
    return this.runStore.update(runId, {status: "done", cleanup_status: cleanupStatus, finished_at: timestamp(this.clock)});
  }

  async cleanup(run, deadline) {
    if (!deleteProfileRequested(run) || !run.created_profile_id) return run.cleanup_status === "pending" ? "failed" : run.cleanup_status;
    let failed = false;
    let deleted = false;
    try { await this.runWithDeadline(deadline, (signal) => this.gemloginClient.closeProfile(run.created_profile_id, {signal}), run.id, true); } catch { failed = true; }
    try { await this.runWithDeadline(deadline, (signal) => this.gemloginClient.deleteProfile(run.created_profile_id, {signal}), run.id, true); deleted = true; }
    catch {
      try { await this.runWithDeadline(deadline, (signal) => this.gemloginClient.deleteProfile(run.created_profile_id, {signal}), run.id, true); deleted = true; } catch { failed = true; }
    }
    if (deleted) try { await this.runWithDeadline(deadline, (signal) => this.refreshProfileList({signal}), run.id, true); } catch {}
    return failed ? "failed" : "done";
  }

  async recover() {
    let run;
    const find = this.runStore.findRecoverable?.bind(this.runStore) ?? this.runStore.findActive.bind(this.runStore);
    while ((run = find())) {
      const active = ["queued", "submitted", "running", "cancelling"].includes(run.status);
      const recoverable = active ? this.runStore.update(run.id, {status: "failed", error_message: "run interrupted by restart"}) : run;
      const cleanupStatus = await this.cleanup(recoverable, new Date(timestamp(this.clock)).getTime() + this.cleanupTimeout);
      this.runStore.update(run.id, {status: "done", cleanup_status: cleanupStatus, finished_at: timestamp(this.clock)});
    }
  }
}
