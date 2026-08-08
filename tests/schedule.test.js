import assert from "node:assert/strict";
import test from "node:test";
import {randomBytes} from "node:crypto";
import {openDatabase} from "../server/database.js";
import {ScheduleStore} from "../server/schedule-store.js";
import {nextOccurrence, randomProfileCount, validateScheduleInput} from "../server/schedule.js";
import {Scheduler} from "../server/scheduler.js";

const base = {name: "Morning", timezone: "Asia/Bangkok", type: "daily", time: "09:30", weekdays: []};
const run = {workflow_id: "wf-1", profile_mode: "new", profile_name: "Temp", group_id: "7", proxy_mode: "none", profile_count: 5, profile_count_mode: "random"};

test("validates schedule recurrence and calculates local time", () => {
  validateScheduleInput(base);
  assert.equal(nextOccurrence(base, new Date("2026-08-08T00:00:00Z")), "2026-08-08T02:30:00.000Z");
  assert.throws(() => validateScheduleInput({...base, timezone: "Not/AZone"}), /timezone/);
  assert.throws(() => validateScheduleInput({...base, time: "9:30"}), /HH:mm/);
});

test("weekly schedule chooses a future selected weekday", () => {
  assert.equal(nextOccurrence({...base, type: "weekly", weekdays: [1]}, new Date("2026-08-08T00:00:00Z")), "2026-08-10T02:30:00.000Z");
});

test("random profile count is inclusive and bounded", () => {
  assert.equal(randomProfileCount(5, () => 0), 1);
  assert.equal(randomProfileCount(5, () => 0.999999), 5);
  assert.throws(() => randomProfileCount(0), /profile_count/);
});

test("schedule store encrypts payload and keeps per-schedule history", () => {
  const db = openDatabase(":memory:");
  const store = new ScheduleStore(db, randomBytes(32), () => new Date("2026-08-08T00:00:00Z"));
  const created = store.create({...base, run});
  assert.equal(store.get(created.id).name, "Morning");
  assert.deepEqual(store.getWithPayload(created.id).run, run);
  assert.equal(db.prepare("SELECT payload_ciphertext FROM schedules WHERE id=?").get(created.id).payload_ciphertext.includes("workflow_id"), false);
  const claim = store.claimDue(new Date("2026-08-08T03:00:00Z"));
  assert.equal(claim.id, created.id);
  store.markStarted(created.id);
  store.finish(created.id, {status: "success"});
  assert.equal(store.get(created.id).last_status, "success");
});

test("one-time schedule stays recoverable while claimed and disables after completion", () => {
  const db = openDatabase(":memory:");
  const clock = () => new Date("2026-08-08T00:00:00Z");
  const store = new ScheduleStore(db, randomBytes(32), clock);
  const created = store.create({...base, type: "once", date: "2026-08-08", run});
  const claim = store.claimDue(new Date("2026-08-08T03:00:00Z"));
  assert.equal(claim.id, created.id);
  assert.equal(store.get(created.id).enabled, true);
  assert.equal(store.get(created.id).dispatch_state, "claimed");
  store.finish(created.id, {status: "success"});
  assert.equal(store.get(created.id).enabled, false);
  assert.equal(store.get(created.id).next_run_at, null);
});

test("scheduler pauses for Manual runs, then resumes with a random batch", async () => {
  const db = openDatabase(":memory:");
  const clock = () => new Date("2026-08-08T03:00:00Z");
  const scheduleStore = new ScheduleStore(db, randomBytes(32), () => new Date("2026-08-08T00:00:00Z"));
  const schedule = scheduleStore.create({...base, run});
  const records = new Map();
  const runStore = {
    findActive() { return [...records.values()].find(({status}) => ["queued", "running"].includes(status)) ?? null; },
    listByScheduleExecution(id) { return [...records.values()].filter((run) => run.schedule_execution_id === id); },
    listBySchedule(id) { return [...records.values()].filter((run) => run.schedule_id === id); },
    get(id) { return records.get(id); }
  };
  records.set("manual", {id: "manual", source: "manual", status: "running"});
  const calls = [];
  const runService = {async start(payload, source) {
    calls.push({payload, source});
    const record = {id: "scheduled-1", ...source, status: "done", schedule_execution_id: "execution-1", schedule_id: source.scheduleId, error_message: null};
    records.set(record.id, record);
    return record;
  }};
  const scheduler = new Scheduler({scheduleStore, runService, runStore, clock, random: () => 0.8, sleep: async () => {}});
  assert.deepEqual(await scheduler.tick(), {state: "paused_manual"});
  records.delete("manual");
  await scheduler.tick();
  assert.equal(calls[0].payload.repeat_count, 5);
  assert.equal(calls[0].source.source, "schedule");
  assert.equal(scheduleStore.get(schedule.id).last_status, "success");
});
