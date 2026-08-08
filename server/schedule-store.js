import {decryptSecret, encryptSecret} from "./crypto.js";
import {nextOccurrence, normalizeScheduleInput, scheduleSummary} from "./schedule.js";

function now() { return new Date().toISOString(); }

function rowWithWeekdays(row) {
  return {...row, enabled: Boolean(row.enabled), weekdays: JSON.parse(row.weekdays || "[]")};
}

export class ScheduleStore {
  constructor(db, key, clock = () => new Date()) { this.db = db; this.key = key; this.clock = clock; }

  create(input) {
    const schedule = normalizeScheduleInput(input);
    const timestamp = this.clock().toISOString();
    const next = schedule.enabled ? nextOccurrence(schedule, new Date(timestamp)) : null;
    const encrypted = encryptSecret(JSON.stringify(schedule.run), this.key);
    const result = this.db.prepare(`INSERT INTO schedules (name, enabled, timezone, schedule_type, run_date, run_time, weekdays,
      payload_ciphertext, payload_iv, payload_auth_tag, next_run_at, created_at, updated_at)
      VALUES (@name, @enabled, @timezone, @schedule_type, @run_date, @run_time, @weekdays, @payload_ciphertext, @payload_iv,
      @payload_auth_tag, @next_run_at, @created_at, @updated_at)`).run({
      name: schedule.name, enabled: schedule.enabled ? 1 : 0, timezone: schedule.timezone, schedule_type: schedule.type,
      run_date: schedule.date ?? null, run_time: schedule.time, weekdays: JSON.stringify(schedule.weekdays), payload_ciphertext: encrypted.ciphertext,
      payload_iv: encrypted.iv, payload_auth_tag: encrypted.auth_tag,
      next_run_at: next, created_at: timestamp, updated_at: timestamp
    });
    return this.get(result.lastInsertRowid);
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id);
    return row ? scheduleSummary(rowWithWeekdays(row)) : null;
  }

  getWithPayload(id) {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id);
    if (!row) return null;
    const parsed = rowWithWeekdays(row);
    return {...parsed, run: JSON.parse(decryptSecret({iv: row.payload_iv, auth_tag: row.payload_auth_tag, ciphertext: row.payload_ciphertext}, this.key))};
  }

  list() { return this.db.prepare("SELECT * FROM schedules ORDER BY id DESC").all().map((row) => scheduleSummary(rowWithWeekdays(row))); }

  update(id, patch) {
    const current = this.getWithPayload(id);
    if (!current) return null;
    const merged = {...current, ...patch, run: patch.run ?? current.run, type: patch.type ?? current.schedule_type, date: patch.date ?? current.run_date, time: patch.time ?? current.run_time, weekdays: patch.weekdays ?? current.weekdays};
    const schedule = normalizeScheduleInput(merged);
    const encrypted = encryptSecret(JSON.stringify(schedule.run), this.key);
    const timestamp = this.clock().toISOString();
    const next = schedule.enabled ? nextOccurrence(schedule, new Date(timestamp)) : current.next_run_at;
    this.db.prepare(`UPDATE schedules SET name=@name, enabled=@enabled, timezone=@timezone, schedule_type=@schedule_type,
      run_date=@run_date, run_time=@run_time, weekdays=@weekdays, payload_ciphertext=@payload_ciphertext, payload_iv=@payload_iv,
      payload_auth_tag=@payload_auth_tag, next_run_at=@next_run_at, dispatch_state='idle', claimed_at=NULL, updated_at=@updated_at WHERE id=@id`).run({
      id, name: schedule.name, enabled: schedule.enabled ? 1 : 0, timezone: schedule.timezone, schedule_type: schedule.type,
      run_date: schedule.date ?? null, run_time: schedule.time, weekdays: JSON.stringify(schedule.weekdays), payload_ciphertext: encrypted.ciphertext,
      payload_iv: encrypted.iv, payload_auth_tag: encrypted.auth_tag, next_run_at: next, updated_at: timestamp
    });
    return this.get(id);
  }

  setEnabled(id, enabled) {
    const row = this.getWithPayload(id);
    if (!row) return null;
    const timestamp = this.clock().toISOString();
    const next = enabled && !row.next_run_at ? nextOccurrence({...row, type: row.schedule_type, date: row.run_date, time: row.run_time}, new Date(timestamp)) : row.next_run_at;
    this.db.prepare("UPDATE schedules SET enabled=?, dispatch_state='idle', claimed_at=NULL, next_run_at=?, updated_at=? WHERE id=?").run(enabled ? 1 : 0, next, timestamp, id);
    return this.get(id);
  }

  remove(id) { return this.db.prepare("DELETE FROM schedules WHERE id=?").run(id).changes > 0; }

  claimDue(at = this.clock()) {
    const timestamp = (at instanceof Date ? at : new Date(at)).toISOString();
    const stale = new Date(new Date(timestamp).getTime() - 15 * 60 * 1000).toISOString();
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        AND (dispatch_state='idle' OR (dispatch_state='claimed' AND claimed_at <= ?)) ORDER BY next_run_at, id LIMIT 1`).get(timestamp, stale);
      if (!row) return null;
      const parsed = rowWithWeekdays(row);
      const next = parsed.schedule_type === "once" ? parsed.next_run_at : nextOccurrence({type: parsed.schedule_type, date: parsed.run_date, time: parsed.run_time, timezone: parsed.timezone, weekdays: parsed.weekdays}, new Date(timestamp));
      this.db.prepare("UPDATE schedules SET dispatch_state='claimed', claimed_at=?, next_run_at=?, updated_at=? WHERE id=? AND dispatch_state=?").run(timestamp, next, timestamp, row.id, row.dispatch_state);
      return this.getWithPayload(row.id);
    })();
  }

  claimById(id, at = this.clock()) {
    const timestamp = (at instanceof Date ? at : new Date(at)).toISOString();
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM schedules WHERE id=? AND enabled=1 AND dispatch_state='idle'").get(id);
      if (!row) return null;
      const parsed = rowWithWeekdays(row);
      const next = parsed.schedule_type === "once" ? parsed.next_run_at : nextOccurrence({type: parsed.schedule_type, date: parsed.run_date, time: parsed.run_time, timezone: parsed.timezone, weekdays: parsed.weekdays}, new Date(timestamp));
      this.db.prepare("UPDATE schedules SET dispatch_state='claimed', claimed_at=?, next_run_at=?, updated_at=? WHERE id=? AND dispatch_state='idle'").run(timestamp, next, timestamp, id);
      return this.getWithPayload(id);
    })();
  }

  markStarted(id, {status = "queued", runAt = this.clock().toISOString()} = {}) {
    this.db.prepare("UPDATE schedules SET last_run_at=?, last_status=?, last_error=NULL, updated_at=? WHERE id=?").run(runAt, status, this.clock().toISOString(), id);
    return this.get(id);
  }

  finish(id, {status, error = null} = {}) {
    this.db.prepare("UPDATE schedules SET dispatch_state='idle', claimed_at=NULL, enabled=CASE WHEN schedule_type='once' THEN 0 ELSE enabled END, next_run_at=CASE WHEN schedule_type='once' THEN NULL ELSE next_run_at END, last_status=?, last_error=?, updated_at=? WHERE id=?").run(status, error, this.clock().toISOString(), id);
    return this.get(id);
  }

  failClaim(id, error) { return this.finish(id, {status: "failed", error: error?.message || String(error)}); }
}
