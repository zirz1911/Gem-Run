const $ = (selector) => document.querySelector(selector);
let status;
let error;
let runForm;
let proxyForm;
const activeStatuses = new Set(["queued", "submitted", "running"]);
let data = {workflows: [], groups: [], profiles: [], proxies: [], activeRun: null};
let poller;

export function serializeParameters(controls) {
  return Object.fromEntries([...controls].map((control) => [control.name.slice(10), control.type === "checkbox" ? Boolean(control.checked) : control.value]));
}

async function api(path, options) {
  const response = await fetch(`/api/${path}`, options);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Request failed");
  return response.status === 204 ? null : response.json();
}
function setError(message = "") { error.hidden = !message; error.textContent = message; }
function option(select, items, placeholder) {
  select.replaceChildren(new Option(placeholder, ""), ...items.map((item) => new Option(item.name || item.label || item.id, item.id)));
}
function profileMode() { return runForm.elements.profile_mode.value; }
function proxyMode() { return runForm.elements.proxy_mode.value; }
function active(run) { return run && activeStatuses.has(run.status); }
function syncRunForm() {
  const isNew = profileMode() === "new";
  $("#existing-profile").hidden = isNew;
  $("#new-profile").hidden = !isNew;
  runForm.elements.profile_id.required = !isNew;
  runForm.elements.profile_name.required = isNew;
  runForm.elements.group_id.required = isNew;
  $("#manual-proxy").hidden = !isNew || proxyMode() !== "manual";
  runForm.elements.raw_proxy.required = isNew && proxyMode() === "manual";
}
function renderParameters() {
  const workflow = data.workflows.find((item) => String(item.id) === $("#workflow").value);
  const fields = (workflow?.parameters || []).map((parameter) => {
    const label = document.createElement("label");
    label.append(`${parameter.name}${parameter.required ? " (required)" : ""}`);
    const control = parameter.type === "boolean" ? document.createElement("input") : document.createElement(parameter.options ? "select" : "input");
    control.name = `parameter.${parameter.name}`;
    control.required = Boolean(parameter.required);
    if (parameter.type === "boolean") {
      control.type = "checkbox";
      control.checked = control.defaultChecked = parameter.default === true;
    } else {
      if (parameter.options) control.append(...parameter.options.map((value) => new Option(value, value)));
      else control.type = parameter.type === "number" ? "number" : "text";
      if (parameter.default !== undefined && parameter.default !== "***") control.value = parameter.default;
    }
    if (parameter.description) label.append(document.createTextNode(` — ${parameter.description}`));
    label.append(control);
    return label;
  });
  $("#parameters").replaceChildren(Object.assign(document.createElement("legend"), {textContent: "Workflow parameters"}), ...(fields.length ? fields : [Object.assign(document.createElement("p"), {textContent: "No parameters."})]));
}
function renderProfiles() {
  $("#profiles").replaceChildren(...data.profiles.map((profile) => Object.assign(document.createElement("li"), {textContent: `${profile.name || profile.id} · ${profile.status || "unknown"}${profile.proxy ? ` · ${profile.proxy}` : ""}`})));
}
function renderProxies() {
  $("#proxies").replaceChildren(...data.proxies.map((proxy) => {
    const row = document.createElement("li");
    row.textContent = `${proxy.label} · ${proxy.scheme}://${proxy.host}:${proxy.port} · ${proxy.enabled ? "enabled" : "disabled"}`;
    const actions = Object.assign(document.createElement("span"), {className: "proxy-actions"});
    const label = Object.assign(document.createElement("input"), {value: proxy.label, ariaLabel: `Label for ${proxy.label}`});
    const raw = Object.assign(document.createElement("input"), {type: "password", placeholder: "Replace proxy (optional)", ariaLabel: `Replacement proxy for ${proxy.label}`, autocomplete: "off"});
    const save = Object.assign(document.createElement("button"), {type: "button", textContent: "Update"});
    save.onclick = () => updateProxy(proxy.id, {label: label.value, enabled: proxy.enabled, ...(raw.value ? {raw_proxy: raw.value} : {})}, raw);
    const toggle = Object.assign(document.createElement("button"), {type: "button", textContent: proxy.enabled ? "Disable" : "Enable"});
    toggle.onclick = () => updateProxy(proxy.id, {enabled: !proxy.enabled});
    const remove = Object.assign(document.createElement("button"), {type: "button", textContent: "Delete"});
    remove.onclick = async () => { if (confirm(`Delete local proxy “${proxy.label}”?`)) { try { await api(`proxies/${proxy.id}`, {method: "DELETE"}); await loadProxies(); } catch (cause) { setError(cause.message); } } };
    actions.append(label, raw, save, toggle, remove); row.append(actions); return row;
  }));
}
function renderRuns(runs) {
  data.activeRun = runs.find(active) || null;
  $("#run-submit").disabled = Boolean(data.activeRun);
  $("#runs").replaceChildren(...runs.map((run) => Object.assign(document.createElement("li"), {textContent: `#${run.id} · ${run.workflow_name || run.workflow_id} · ${run.status}${run.cleanup_status ? ` · cleanup: ${run.cleanup_status}` : ""}${run.error_message ? ` · ${run.error_message}` : ""}`})));
  if (data.activeRun) poll(data.activeRun.id);
}
async function loadProxies() {
  try { data.proxies = await api("proxies"); renderProxies(); }
  catch { setError("Some dashboard data could not be loaded."); }
}
async function loadRuns() {
  try { renderRuns(await api("runs")); }
  catch { setError("Run history could not be loaded."); }
}
async function optionalLoad(path, fallback) {
  try { return await api(path); }
  catch { setError("Some dashboard data could not be loaded."); return fallback; }
}
async function load() {
  const history = loadRuns();
  const [health, workflows, groups, profiles] = await Promise.all([optionalLoad("health", null), optionalLoad("gemlogin/workflows", []), optionalLoad("gemlogin/groups", []), optionalLoad("gemlogin/profiles", [])]);
  data = {...data, workflows, groups, profiles};
  status.textContent = health?.app === "ok" ? `Service ready; GemLogin ${health.gemlogin}.` : "Service unavailable.";
  option($("#workflow"), workflows, "Choose a workflow"); option($("#group"), groups, "Choose a group"); option($("#profile"), profiles, "Choose a profile");
  renderProfiles(); renderParameters(); await Promise.all([loadProxies(), history]);
}
async function updateProxy(id, payload, raw) {
  try { await api(`proxies/${id}`, {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify(payload)}); if (raw) raw.value = ""; await loadProxies(); }
  catch (cause) { setError(cause.message); }
}
function poll(id) {
  clearTimeout(poller);
  poller = setTimeout(async () => {
    try { const run = await api(`runs/${id}`); if (active(run)) poll(id); else await loadRuns(); }
    catch (cause) { setError(cause.message); poll(id); }
  }, 2000);
}
function initialize() {
  status = $("#status"); error = $("#error"); runForm = $("#run-form"); proxyForm = $("#proxy-form");
  syncRunForm();
  runForm.addEventListener("change", (event) => { if (event.target.name === "profile_mode" || event.target.name === "proxy_mode") syncRunForm(); if (event.target.id === "workflow") renderParameters(); });
  runForm.addEventListener("submit", async (event) => {
  event.preventDefault(); setError("");
  const form = new FormData(runForm); const workflow = data.workflows.find((item) => String(item.id) === form.get("workflow_id"));
  const payload = {workflow_id: form.get("workflow_id"), workflow_name: workflow?.name || null, profile_mode: form.get("profile_mode"), cleanup_requested: form.has("cleanup_requested"), parameter: {}};
  payload.parameter = serializeParameters($("#parameters").querySelectorAll("[name^='parameter.']"));
  if (payload.profile_mode === "existing") payload.profile_id = form.get("profile_id");
  else Object.assign(payload, {profile_name: form.get("profile_name"), group_id: form.get("group_id"), proxy_mode: form.get("proxy_mode"), ...(form.get("proxy_mode") === "manual" ? {raw_proxy: form.get("raw_proxy")} : {})});
  try { $("#run-submit").disabled = true; const run = await api("runs", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(payload)}); runForm.elements.raw_proxy.value = ""; status.textContent = `Run #${run.id} started.`; await loadRuns(); }
  catch (cause) { setError(cause.message); $("#run-submit").disabled = false; }
});
proxyForm.addEventListener("submit", async (event) => {
  event.preventDefault(); setError(""); const form = new FormData(proxyForm);
  try { await api("proxies", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({label: form.get("label"), raw_proxy: form.get("raw_proxy"), enabled: form.has("enabled")})}); proxyForm.reset(); proxyForm.elements.enabled.checked = true; await loadProxies(); }
  catch (cause) { setError(cause.message); }
});
  load();
}
if (typeof document !== "undefined") initialize();
