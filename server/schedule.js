const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const validTypes = new Set(["once", "daily", "weekly"]);

function partsFor(date, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).filter(({type}) => type !== "literal").map(({type, value}) => [type, Number(value)]));
}

function localDateFromParts(parts) { return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)); }

function localToUtc({date, time, timezone}) {
  const [hour, minute] = time.split(":").map(Number);
  const [year, month, day] = date.split("-").map(Number);
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = partsFor(candidate, timezone);
    const wanted = Date.UTC(year, month - 1, day, hour, minute);
    const observed = Date.UTC(current.year, current.month - 1, current.day, current.hour, current.minute);
    candidate = new Date(candidate.getTime() + (wanted - observed));
  }
  return candidate;
}

function localDateText(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) { const result = new Date(date); result.setUTCDate(result.getUTCDate() + days); return result; }

export function validateScheduleInput(input) {
  if (!String(input?.name || "").trim()) throw new Error("schedule name is required");
  if (input?.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
  if (!validTypes.has(input?.type)) throw new Error("schedule type must be once, daily, or weekly");
  if (typeof input.timezone !== "string" || !input.timezone.trim()) throw new Error("timezone is required");
  try { new Intl.DateTimeFormat("en-US", {timeZone: input.timezone}); } catch { throw new Error("timezone is invalid"); }
  if (!timePattern.test(input.time)) throw new Error("time must use HH:mm");
  if (input.type === "once" && !datePattern.test(input.date || "")) throw new Error("date is required for once schedules");
  if (input.type === "weekly" && (!Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error("weekly schedules require valid weekdays");
  return input;
}

export function nextOccurrence(schedule, fromUtc = new Date()) {
  validateScheduleInput({...schedule, name: schedule.name || "internal"});
  const from = fromUtc instanceof Date ? fromUtc : new Date(fromUtc);
  if (Number.isNaN(from.getTime())) throw new Error("fromUtc must be a valid date");
  if (schedule.type === "once") {
    const candidate = localToUtc(schedule);
    return candidate > from ? candidate.toISOString() : null;
  }
  const nowParts = partsFor(from, schedule.timezone);
  const localStart = localDateFromParts(nowParts);
  const days = schedule.type === "daily" ? [0, 1] : Array.from({length: 8}, (_, index) => index);
  for (const offset of days) {
    const localDate = addDays(localStart, offset);
    if (schedule.type === "weekly" && !schedule.weekdays.map(Number).includes(localDate.getUTCDay())) continue;
    const candidate = localToUtc({date: localDateText(localDate), time: schedule.time, timezone: schedule.timezone});
    if (candidate > from) return candidate.toISOString();
  }
  throw new Error("unable to calculate next schedule occurrence");
}

export function scheduleSummary(row) {
  return {
    id: row.id, name: row.name, enabled: Boolean(row.enabled), timezone: row.timezone, type: row.schedule_type,
    date: row.run_date ?? null, time: row.run_time, weekdays: row.weekdays ?? [], next_run_at: row.next_run_at ?? null,
    last_run_at: row.last_run_at ?? null, last_status: row.last_status ?? null, last_error: row.last_error ?? null,
    dispatch_state: row.dispatch_state ?? "idle", created_at: row.created_at ?? null, updated_at: row.updated_at ?? null
  };
}

export function randomProfileCount(maximum, random = Math.random) {
  const max = Number(maximum);
  if (!Number.isInteger(max) || max < 1 || max > 100) throw new Error("profile_count must be between 1 and 100");
  return Math.floor(random() * max) + 1;
}

export function normalizeScheduleInput(input) {
  validateScheduleInput(input);
  const weekdays = input.type === "weekly" ? [...new Set(input.weekdays.map(Number))].sort((a, b) => a - b) : [];
  return {...input, name: String(input.name).trim(), enabled: input.enabled !== false, weekdays};
}
