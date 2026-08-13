import express from "express";
import {parseProxy} from "./proxy-store.js";
import {validateScheduleInput} from "./schedule.js";

const invalidRunRequests = new Set([
  "workflow_id is required", "profile_mode must be existing or new", "profile_id is required",
  "cleanup is only available for new profiles", "profile_name is required", "group_id is required",
  "profile_ids are invalid", "profile_ids are only available for existing profiles",
  "proxy_mode must be none, manual, or random", "repeat_count must be between 1 and 500", "repeat_count is only available for new profiles",
  "execution_mode must be sequential or parallel", "max_concurrency must be between 1 and 500", "max_concurrency cannot exceed profile count", "not enough enabled proxies for batch", "Proxy must be a string",
  "Proxy must include host, port, and complete credentials", "Proxy host is invalid",
  "Proxy port must be between 1 and 65535"
]);
const runFields = ["workflow_id", "workflow_name", "profile_mode", "profile_id", "profile_ids", "profile_name", "group_id", "proxy_mode", "raw_proxy", "parameter", "cleanup_requested", "close_browser", "delete_profile", "repeat_count", "execution_mode", "max_concurrency"];
const sensitiveName = /(?:api[_-]?key|access[_-]?key|private[_-]?key|authorization|(?:^|[_-])auth(?:$|[_-])|(?:^|[_-])bearer(?:$|[_-])|(?:^|[_-])headers?(?:$|[_-])|(?:^|[_-])config(?:uration)?(?:$|[_-])|cookie|credential|pass(?:word)?|secret|token|user(?:name)?)/i;

function items(payload) { return Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : []; }
function value(payload) { return payload?.data && !Array.isArray(payload.data) ? payload.data : payload; }
function maskedProxy(proxy) {
  return String(proxy ?? "").replace(/\/\/[^/@]+@/, "//***:***@").replace(/^(\w+:\/\/[^:]+:\d+):[^:]*:[^:]*$/, "$1:***:***");
}
function safeProxy(proxy) {
  return {id: proxy.id, label: proxy.label, scheme: proxy.scheme, host: proxy.host, port: proxy.port, enabled: Boolean(proxy.enabled), last_used_at: proxy.last_used_at ?? null};
}
function safeProfile(profile) {
  return {id: profile.id, name: profile.name ?? profile.profile_name ?? null, group_id: profile.group_id ?? profile.groupId ?? null,
    group_name: profile.group_name ?? profile.groupName ?? null,
    browser: profile.browser_name ?? profile.browser?.name ?? (typeof profile.browser === "string" ? profile.browser : null),
    status: typeof profile.status === "string" ? profile.status : null, proxy: profile.proxy == null ? null : maskedProxy(profile.proxy)};
}
function safeWorkflow(workflow) {
  return {id: workflow.id ?? workflow.workflow_id, name: workflow.name ?? workflow.workflow_name ?? null,
    parameters: items(workflow.parameters ?? workflow.params).map((parameter) => Object.fromEntries(Object.entries({
      name: parameter.name, type: parameter.type, required: parameter.required, description: parameter.description,
      options: Array.isArray(parameter.options) ? parameter.options : undefined,
      ...(Object.hasOwn(parameter, "default") || Object.hasOwn(parameter, "defaultValue")
        ? {default: sensitiveName.test(parameter.name) ? "***" : (parameter.default ?? parameter.defaultValue)} : {})
    }).filter(([, field]) => field !== undefined)))};
}
function safeRun(run) {
  const batch = run.batch_id ? {batch_id: run.batch_id, batch_index: run.batch_index, batch_total: run.batch_total} : {};
  const source = run.source === "schedule" || run.schedule_id != null ? {source: run.source ?? "manual", schedule_id: run.schedule_id ?? null, schedule_name: run.schedule_name ?? null,
    configured_profile_count: run.configured_profile_count ?? null, profile_count_mode: run.profile_count_mode ?? null, actual_profile_count: run.actual_profile_count ?? null} : {};
  return {id: run.id, workflow_id: run.workflow_id, workflow_name: run.workflow_name ?? null, profile_mode: run.profile_mode,
    profile_id: run.profile_id ?? null, created_profile_id: run.created_profile_id ?? null, proxy_id: run.proxy_id ?? null,
    cleanup_requested: Boolean(run.cleanup_requested), close_browser: Boolean(run.close_browser ?? run.cleanup_requested), delete_profile: Boolean(run.delete_profile ?? run.cleanup_requested), status: run.status, error_message: run.error_message ?? null,
    cleanup_status: run.cleanup_status ?? null, created_at: run.created_at ?? null, started_at: run.started_at ?? null, finished_at: run.finished_at ?? null, ...source, ...batch};
}
function safeBatch(batch) { return {batch_id: batch.batch_id, execution_mode: batch.execution_mode, max_concurrency: batch.max_concurrency, runs: batch.runs.map(safeRun)}; }
function safeSchedule(schedule) { return schedule ? {...schedule, weekdays: [...(schedule.weekdays || [])]} : null; }
function safeGroup(group) { return {id: group.id ?? group.group_id, name: group.name ?? group.group_name ?? null}; }
function safeSettings(client) {
  return {cloud: {device_id: Boolean(client?.cloudDeviceId), soft_id: Boolean(client?.cloudSoftId), token: Boolean(client?.cloudToken)}};
}
function inputFields(body) { return Object.fromEntries(runFields.filter((field) => Object.hasOwn(body ?? {}, field)).map((field) => [field, body[field]])); }
function validProxyInput(body, required = false) {
  if (required && (!Object.hasOwn(body ?? {}, "label") || !Object.hasOwn(body ?? {}, "raw_proxy"))) throw new Error();
  if (Object.hasOwn(body ?? {}, "label") && !String(body.label || "").trim()) throw new Error();
  if (Object.hasOwn(body ?? {}, "enabled") && typeof body.enabled !== "boolean") throw new Error();
  if (Object.hasOwn(body ?? {}, "raw_proxy")) parseProxy(body.raw_proxy);
}
function validRunInput(input) {
  if (Object.hasOwn(input, "cleanup_requested") && typeof input.cleanup_requested !== "boolean") throw new Error("invalid run input");
  if (Object.hasOwn(input, "close_browser") && typeof input.close_browser !== "boolean") throw new Error("invalid run input");
  if (Object.hasOwn(input, "delete_profile") && typeof input.delete_profile !== "boolean") throw new Error("invalid run input");
  if (Object.hasOwn(input, "parameter") && (!input.parameter || typeof input.parameter !== "object" || Array.isArray(input.parameter))) throw new Error("invalid run input");
  return input;
}
function validScheduledRun(input, runService) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid schedule run");
  const run = {...input};
  if (run.profile_mode === "new") {
    const count = Number(run.profile_count);
    if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error("profile_count must be between 1 and 500");
    if (!['fixed', 'random'].includes(run.profile_count_mode ?? "fixed")) throw new Error("profile_count_mode is invalid");
    run.profile_count = count;
    run.profile_count_mode = run.profile_count_mode ?? "fixed";
    run.repeat_count = count;
    const maxConcurrency = Number(run.max_concurrency ?? 1);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 500) throw new Error("max_concurrency must be between 1 and 500");
    if (maxConcurrency > count) throw new Error("max_concurrency cannot exceed profile_count");
    run.max_concurrency = maxConcurrency;
    run.execution_mode = run.execution_mode ?? (Number(run.max_concurrency) > 1 ? "parallel" : "sequential");
  } else if (run.profile_count !== undefined || run.profile_count_mode !== undefined) throw new Error("profile count is only available for new profiles");
  validRunInput(run);
  runService.validate(run);
  return run;
}
function unavailable(response) { return response.status(503).json({error: "GemLogin unavailable", code: "gemlogin_unavailable"}); }
function proxyById(proxyStore, id) { return proxyStore.list().find((proxy) => String(proxy.id) === String(id)); }

export function createRoutes({gemloginClient, proxyStore, runStore, runService, settingsStore, scheduleStore = null, scheduler = null}) {
  const router = express.Router();
  const gemlogin = (method, map) => async (_request, response) => {
    if (!gemloginClient) return unavailable(response);
    try { return response.json(map(await gemloginClient[method]())); } catch { return unavailable(response); }
  };

  router.get("/api/health", async (_request, response) => {
    if (!gemloginClient) return response.json({app: "ok", gemlogin: "not configured"});
    try { await gemloginClient.status(); return response.json({app: "ok", gemlogin: "available"}); }
    catch { return response.json({app: "ok", gemlogin: "unavailable"}); }
  });
  router.get("/api/settings", (_request, response) => response.json(safeSettings(gemloginClient)));
  router.patch("/api/settings", (request, response) => {
    if (!settingsStore || !gemloginClient) return response.status(503).json({error: "Settings unavailable"});
    const allowed = ["device_id", "soft_id", "token"];
    if (Object.keys(request.body ?? {}).some((key) => !allowed.includes(key)) || Object.values(request.body ?? {}).some((value) => typeof value !== "string" || value.length > 1000)) {
      return response.status(400).json({error: "Invalid settings request"});
    }
    try {
      const values = Object.fromEntries(Object.entries(request.body ?? {}).map(([key, value]) => [`cloud_${key}`, value]));
      const saved = settingsStore.setMany(values);
      gemloginClient.configureCloud({cloudDeviceId: saved.cloud_device_id || gemloginClient.cloudDeviceId, cloudSoftId: saved.cloud_soft_id || gemloginClient.cloudSoftId, cloudToken: saved.cloud_token || gemloginClient.cloudToken});
      return response.json(safeSettings(gemloginClient));
    } catch { return response.status(400).json({error: "Invalid settings request"}); }
  });
  router.get("/api/gemlogin/status", gemlogin("status", () => ({connected: true})));
  router.get("/api/gemlogin/profiles", gemlogin("listProfiles", (payload) => items(payload).map(safeProfile)));
  router.get("/api/gemlogin/groups", gemlogin("listGroups", (payload) => items(payload).map(safeGroup)));
  router.get("/api/gemlogin/workflows", gemlogin("listWorkflows", (payload) => items(payload).map(safeWorkflow)));
  router.get("/api/proxies", (_request, response) => response.json(proxyStore.list().map(safeProxy)));
  router.post("/api/proxies", (request, response) => {
    try {
      validProxyInput(request.body, true);
      const created = proxyStore.create({label: request.body?.label, raw_proxy: request.body?.raw_proxy, enabled: request.body?.enabled});
      return response.status(201).json(safeProxy(proxyById(proxyStore, created.id)));
    } catch { return response.status(400).json({error: "Invalid proxy request"}); }
  });
  router.patch("/api/proxies/:id", (request, response) => {
    const existing = proxyStore.get(request.params.id);
    if (!existing) return response.status(404).json({error: "Proxy not found"});
    try {
      if (!["label", "enabled", "raw_proxy"].some((field) => Object.hasOwn(request.body ?? {}, field))) throw new Error();
      validProxyInput(request.body);
      if (Object.hasOwn(request.body ?? {}, "label") && !proxyStore.setLabel(request.params.id, request.body.label)) throw new Error();
      if (Object.hasOwn(request.body ?? {}, "enabled") && !proxyStore.setEnabled(request.params.id, request.body.enabled)) throw new Error();
      if (Object.hasOwn(request.body ?? {}, "raw_proxy") && !proxyStore.replaceCredentials(request.params.id, request.body.raw_proxy)) throw new Error();
      return response.json(safeProxy(proxyById(proxyStore, request.params.id)));
    } catch { return response.status(400).json({error: "Invalid proxy request"}); }
  });
  router.delete("/api/proxies/:id", (request, response) => proxyStore.remove(request.params.id) ? response.status(204).end() : response.status(404).json({error: "Proxy not found"}));
  router.post("/api/gemlogin/profiles/:id/start", async (request, response) => {
    if (!gemloginClient) return unavailable(response);
    try {
      const profile = value(await gemloginClient.startProfile(request.params.id));
      return response.json({cdp_address: profile.cdp_address ?? profile.debugger_address ?? profile.ws ?? null,
        browser: {name: profile.browser?.name ?? profile.name ?? null, version: profile.browser?.version ?? profile.version ?? null}});
    } catch { return unavailable(response); }
  });
  router.get("/api/runs", (_request, response) => response.json(runStore.listRecent(50).map(safeRun)));
  router.get("/api/runs/:id", (request, response) => {
    const run = runService?.get(request.params.id) ?? runStore.get(request.params.id);
    return run ? response.json(safeRun(run)) : response.status(404).json({error: "Run not found"});
  });
  router.post("/api/runs/:id/cancel", async (request, response) => {
    if (!runService?.cancel) return response.status(503).json({error: "Run service unavailable"});
    try { return response.status(202).json(safeRun(await runService.cancel(request.params.id))); }
    catch (error) {
      if (error?.message === "run not found") return response.status(404).json({error: "Run not found"});
      if (error?.message === "run is not active") return response.status(409).json({error: "Run is not active"});
      return response.status(500).json({error: "Unable to cancel run"});
    }
  });
  router.post("/api/runs", async (request, response) => {
    if (!runService) return response.status(503).json({error: "Run service unavailable"});
    try {
      const started = await runService.start(validRunInput(inputFields(request.body)));
      return response.status(202).json(started.batch_id ? safeBatch(started) : safeRun(started));
    }
    catch (error) {
      if (error?.message === "an active run already exists") return response.status(409).json({error: "An active run already exists"});
      if (error?.message === "invalid run input" || invalidRunRequests.has(error?.message)) return response.status(400).json({error: "Invalid run request"});
      return response.status(500).json({error: "Unable to start run"});
    }
  });
  router.get("/api/schedules", (_request, response) => response.json(scheduleStore?.list?.().map(safeSchedule) ?? []));
  router.get("/api/schedules/:id/runs", (request, response) => {
    if (!scheduleStore?.get(request.params.id)) return response.status(404).json({error: "Schedule not found"});
    return response.json((runStore.listBySchedule?.(request.params.id) ?? []).map(safeRun));
  });
  router.post("/api/schedules", (request, response) => {
    if (!scheduleStore || !runService) return response.status(503).json({error: "Schedule service unavailable"});
    try {
      const body = request.body ?? {};
      const run = validScheduledRun(body.run, runService);
      const schedule = {name: body.name, enabled: body.enabled, timezone: body.timezone, type: body.type, date: body.date, time: body.time, weekdays: body.weekdays, run};
      validateScheduleInput(schedule);
      return response.status(201).json(safeSchedule(scheduleStore.create(schedule)));
    } catch { return response.status(400).json({error: "Invalid schedule request"}); }
  });
  router.patch("/api/schedules/:id", (request, response) => {
    if (!scheduleStore || !runService) return response.status(503).json({error: "Schedule service unavailable"});
    const existing = scheduleStore.getWithPayload(request.params.id);
    if (!existing) return response.status(404).json({error: "Schedule not found"});
    try {
      const body = request.body ?? {};
      const patch = {...body};
      if (body.run) patch.run = validScheduledRun(body.run, runService);
      validateScheduleInput({name: existing.name, enabled: existing.enabled, timezone: existing.timezone, type: existing.schedule_type, date: existing.run_date, time: existing.run_time, weekdays: existing.weekdays, ...patch});
      return response.json(safeSchedule(scheduleStore.update(request.params.id, patch)));
    } catch { return response.status(400).json({error: "Invalid schedule request"}); }
  });
  router.post("/api/schedules/:id/enable", (request, response) => {
    const updated = scheduleStore?.setEnabled(request.params.id, true);
    return updated ? response.json(safeSchedule(updated)) : response.status(404).json({error: "Schedule not found"});
  });
  router.post("/api/schedules/:id/disable", (request, response) => {
    const updated = scheduleStore?.setEnabled(request.params.id, false);
    return updated ? response.json(safeSchedule(updated)) : response.status(404).json({error: "Schedule not found"});
  });
  router.post("/api/schedules/:id/run-now", async (request, response) => {
    if (!scheduler) return response.status(503).json({error: "Schedule service unavailable"});
    try { return response.status(202).json(safeSchedule(await scheduler.runNow(request.params.id))); }
    catch (error) {
      if (error?.message === "an active run already exists" || error?.message === "an active scheduled run exists") return response.status(409).json({error: "An active run already exists"});
      if (error?.message === "schedule is not active or not found") return response.status(409).json({error: "Schedule is not active"});
      return response.status(500).json({error: "Unable to run schedule"});
    }
  });
  router.delete("/api/schedules/:id", (request, response) => scheduleStore?.remove(request.params.id) ? response.status(204).end() : response.status(404).json({error: "Schedule not found"}));
  return router;
}
