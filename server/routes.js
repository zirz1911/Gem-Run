import express from "express";
import {parseProxy} from "./proxy-store.js";

const invalidRunRequests = new Set([
  "workflow_id is required", "profile_mode must be existing or new", "profile_id is required",
  "cleanup is only available for new profiles", "profile_name is required", "group_id is required",
  "proxy_mode must be none, manual, or random", "Proxy must be a string",
  "Proxy must include scheme, host, port, and complete credentials", "Proxy host is invalid",
  "Proxy port must be between 1 and 65535"
]);
const runFields = ["workflow_id", "workflow_name", "profile_mode", "profile_id", "profile_name", "group_id", "proxy_mode", "raw_proxy", "parameter", "cleanup_requested"];
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
      ...(Object.hasOwn(parameter, "default") ? {default: sensitiveName.test(parameter.name) ? "***" : parameter.default} : {})
    }).filter(([, field]) => field !== undefined)))};
}
function safeRun(run) {
  return {id: run.id, workflow_id: run.workflow_id, workflow_name: run.workflow_name ?? null, profile_mode: run.profile_mode,
    profile_id: run.profile_id ?? null, created_profile_id: run.created_profile_id ?? null, proxy_id: run.proxy_id ?? null,
    cleanup_requested: Boolean(run.cleanup_requested), status: run.status, error_message: run.error_message ?? null,
    cleanup_status: run.cleanup_status ?? null, created_at: run.created_at ?? null, started_at: run.started_at ?? null, finished_at: run.finished_at ?? null};
}
function safeGroup(group) { return {id: group.id ?? group.group_id, name: group.name ?? group.group_name ?? null}; }
function inputFields(body) { return Object.fromEntries(runFields.filter((field) => Object.hasOwn(body ?? {}, field)).map((field) => [field, body[field]])); }
function validProxyInput(body, required = false) {
  if (required && (!Object.hasOwn(body ?? {}, "label") || !Object.hasOwn(body ?? {}, "raw_proxy"))) throw new Error();
  if (Object.hasOwn(body ?? {}, "label") && !String(body.label || "").trim()) throw new Error();
  if (Object.hasOwn(body ?? {}, "enabled") && typeof body.enabled !== "boolean") throw new Error();
  if (Object.hasOwn(body ?? {}, "raw_proxy")) parseProxy(body.raw_proxy);
}
function validRunInput(input) {
  if (Object.hasOwn(input, "cleanup_requested") && typeof input.cleanup_requested !== "boolean") throw new Error("invalid run input");
  if (Object.hasOwn(input, "parameter") && (!input.parameter || typeof input.parameter !== "object" || Array.isArray(input.parameter))) throw new Error("invalid run input");
  return input;
}
function unavailable(response) { return response.status(503).json({error: "GemLogin unavailable", code: "gemlogin_unavailable"}); }
function proxyById(proxyStore, id) { return proxyStore.list().find((proxy) => String(proxy.id) === String(id)); }

export function createRoutes({gemloginClient, proxyStore, runStore, runService}) {
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
  router.post("/api/runs", async (request, response) => {
    if (!runService) return response.status(503).json({error: "Run service unavailable"});
    try { return response.status(202).json(safeRun(await runService.start(validRunInput(inputFields(request.body))))); }
    catch (error) {
      if (error?.message === "an active run already exists") return response.status(409).json({error: "An active run already exists"});
      if (error?.message === "invalid run input" || invalidRunRequests.has(error?.message)) return response.status(400).json({error: "Invalid run request"});
      return response.status(500).json({error: "Unable to start run"});
    }
  });
  return router;
}
