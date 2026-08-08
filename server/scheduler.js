import {randomProfileCount} from "./schedule.js";

const terminalStatuses = new Set(["done"]);

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function terminalResult(runs) {
  if (!runs.length || runs.some((run) => !terminalStatuses.has(run.status))) return null;
  const failed = runs.find((run) => run.error_message || ["failed", "timeout", "cancelled"].includes(run.status));
  return failed ? {status: failed.status === "done" ? "failed" : failed.status, error: failed.error_message} : {status: "success", error: null};
}

export class Scheduler {
  constructor({scheduleStore, runService, runStore, clock = () => new Date(), intervalMs = 15000, sleep = wait, random = Math.random}) {
    Object.assign(this, {scheduleStore, runService, runStore, clock, intervalMs, sleep, random});
    this.timer = null;
    this.task = null;
    this.stopped = false;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drain();
  }

  async drain() { if (this.task) await this.task; }

  async tick() {
    if (this.stopped || this.task) return {state: "busy"};
    const active = this.runStore.findActive();
    if (active) return {state: active.source === "manual" ? "paused_manual" : "paused_active"};
    const claim = this.scheduleStore.claimDue(this.clock());
    if (!claim) return {state: "idle"};
    this.task = this.executeClaim(claim).finally(() => { this.task = null; });
    await this.task;
    return {state: "finished", schedule_id: claim.id};
  }

  async runNow(scheduleId) {
    if (this.runStore.findActive()) throw new Error("an active run already exists");
    const claim = this.scheduleStore.claimById?.(scheduleId, this.clock());
    if (!claim) throw new Error("schedule is not active or not found");
    if (this.task) throw new Error("an active scheduled run exists");
    this.task = this.executeClaim(claim).finally(() => { this.task = null; });
    return this.scheduleStore.get(scheduleId);
  }

  async executeClaim(claim) {
    const configured = claim.run.profile_mode === "new" ? Number(claim.run.profile_count ?? claim.run.repeat_count ?? 1) : 1;
    const mode = claim.run.profile_mode === "new" ? (claim.run.profile_count_mode ?? "fixed") : "fixed";
    const actual = mode === "random" ? randomProfileCount(configured, this.random) : configured;
    const payload = {...claim.run};
    delete payload.profile_count;
    delete payload.profile_count_mode;
    if (payload.profile_mode === "new") {
      payload.repeat_count = actual;
      payload.max_concurrency ??= 1;
      payload.execution_mode ??= Number(payload.max_concurrency) > 1 ? "parallel" : "sequential";
    }
    try {
      const started = await this.runService.start(payload, {
        source: "schedule", scheduleId: claim.id, scheduleName: claim.name,
        configuredProfileCount: configured, profileCountMode: mode, actualProfileCount: actual
      });
      this.scheduleStore.markStarted(claim.id, {status: "queued"});
      const executionId = started.runs?.[0]?.schedule_execution_id || started.runs?.[0]?.scheduleExecutionId;
      await this.waitForCompletion(executionId, started);
      const runs = executionId ? this.runStore.listByScheduleExecution(executionId) : this.runStore.listBySchedule(claim.id).slice(0, 1);
      const result = terminalResult(runs) ?? {status: "success", error: null};
      this.scheduleStore.finish(claim.id, result);
    } catch (error) {
      this.scheduleStore.failClaim(claim.id, error);
    }
  }

  async waitForCompletion(executionId, started) {
    if (!executionId) {
      const ids = started.runs?.map(({id}) => id) ?? [started.id];
      while (ids.some((id) => !terminalStatuses.has(this.runStore.get(id)?.status))) await this.sleep(250);
      return;
    }
    while (true) {
      const runs = this.runStore.listByScheduleExecution(executionId);
      if (runs.length && runs.every((run) => terminalStatuses.has(run.status))) return;
      await this.sleep(250);
    }
  }
}
