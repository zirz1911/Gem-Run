const $ = (selector) => document.querySelector(selector);
let status;
let error;
let runForm;
let proxyForm;
let settingsForm;
const activeStatuses = new Set(["queued", "submitted", "running"]);
let data = {workflows: [], groups: [], profiles: [], proxies: [], activeRun: null};
let selectedProxyIds = new Set();
let poller;

export function serializeParameters(controls) {
  return Object.fromEntries([...controls].map((control) => [control.name.slice(10), control.type === "checkbox" ? Boolean(control.checked) : control.value]));
}
export function parseProxyLines(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
export function summarizeBatchProgress(runs) {
  const activeRuns = runs.filter(active);
  if (!activeRuns.length) return null;
  const batchId = activeRuns.find((run) => run.batch_id)?.batch_id;
  const batchRuns = batchId ? runs.filter((run) => run.batch_id === batchId) : [activeRuns[0]];
  const total = Number(batchRuns.find((run) => run.batch_total)?.batch_total || batchRuns.length || 1);
  const completed = batchRuns.filter((run) => run.status === "done").length;
  const running = batchRuns.filter((run) => run.status === "running" || run.status === "submitted").length;
  const queued = batchRuns.filter((run) => run.status === "queued").length;
  return {total, completed, running, queued, percent: Math.round((completed / total) * 100)};
}
function updateProxyCount() {
  const count = parseProxyLines(proxyForm?.elements.raw_proxy?.value).length;
  const target = $("#proxy-count");
  if (target) target.textContent = `${count} ${count === 1 ? "proxy" : "proxies"} detected`;
}
function renderSettings(settings) {
  const cloud = settings?.cloud || {};
  for (const name of ["device_id", "soft_id", "token"]) {
    settingsForm.elements[name].placeholder = cloud[name] ? "Configured — enter to replace" : "Not configured";
  }
}
function syncRunForm() {
  const isNew = profileMode() === "new";
  $("#existing-profile").hidden = isNew;
  $("#new-profile").hidden = !isNew;
  runForm.elements.profile_id.required = !isNew;
  runForm.elements.profile_name.required = isNew;
  runForm.elements.group_id.required = isNew;
  $("#manual-proxy").hidden = !isNew || proxyMode() !== "manual";
  runForm.elements.raw_proxy.required = isNew && proxyMode() === "manual";
  $("#parallel-options").hidden = !isNew || runForm.elements.execution_mode.value !== "parallel";
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
function renderRunProgress(runs) {
  const progress = summarizeBatchProgress(runs);
  const panel = $("#run-progress");
  if (!panel) return;
  panel.hidden = !progress;
  if (!progress) return;
  $("#run-progress-count").textContent = `${progress.completed} / ${progress.total} complete`;
  $("#run-progress-detail").textContent = `${progress.percent}% · ${progress.running} running · ${progress.queued} queued`;
  const bar = $("#run-progress-bar");
  bar.style.width = `${progress.percent}%`;
  bar.parentElement.setAttribute("aria-valuenow", String(progress.percent));
}
function renderProxies() {
  selectedProxyIds = new Set([...selectedProxyIds].filter((id) => data.proxies.some((proxy) => String(proxy.id) === String(id))));
  $("#proxies").replaceChildren(...data.proxies.map((proxy) => {
    const row = document.createElement("li");
    const summary = Object.assign(document.createElement("div"), {className: "proxy-summary"});
    const select = Object.assign(document.createElement("input"), {type: "checkbox", className: "proxy-select", checked: selectedProxyIds.has(String(proxy.id)), ariaLabel: `Select ${proxy.label}`});
    select.onchange = () => { if (select.checked) selectedProxyIds.add(String(proxy.id)); else selectedProxyIds.delete(String(proxy.id)); updateProxySelection(); };
    const details = Object.assign(document.createElement("span"), {className: "proxy-details", textContent: `${proxy.label} · ${proxy.scheme}://${proxy.host}:${proxy.port}`});
    const state = Object.assign(document.createElement("span"), {className: `proxy-state${proxy.enabled ? "" : " disabled"}`, textContent: proxy.enabled ? "enabled" : "disabled"});
    summary.append(select, details, state);
    const actions = Object.assign(document.createElement("span"), {className: "proxy-actions"});
    const label = Object.assign(document.createElement("input"), {value: proxy.label, ariaLabel: `Label for ${proxy.label}`});
    const raw = Object.assign(document.createElement("input"), {type: "password", placeholder: "Replace proxy (optional)", ariaLabel: `Replacement proxy for ${proxy.label}`, autocomplete: "off"});
    const save = Object.assign(document.createElement("button"), {type: "button", textContent: "Update"});
    save.onclick = () => updateProxy(proxy.id, {label: label.value, enabled: proxy.enabled, ...(raw.value ? {raw_proxy: raw.value} : {})}, raw);
    const toggle = Object.assign(document.createElement("button"), {type: "button", textContent: proxy.enabled ? "Disable" : "Enable"});
    toggle.onclick = () => updateProxy(proxy.id, {enabled: !proxy.enabled});
    const remove = Object.assign(document.createElement("button"), {type: "button", textContent: "Delete"});
    remove.onclick = () => deleteProxies([proxy.id], `Delete local proxy “${proxy.label}”?`);
    actions.append(label, raw, save, toggle, remove); row.append(summary, actions); return row;
  }));
  updateProxySelection();
}
function updateProxySelection() {
  const selected = selectedProxyIds.size;
  const total = data.proxies.length;
  const selectAll = $("#proxy-select-all");
  if (!selectAll) return;
  selectAll.checked = total > 0 && selected === total;
  selectAll.indeterminate = selected > 0 && selected < total;
  $("#proxy-selection-count").textContent = `${selected} selected`;
  $("#delete-selected-proxies").disabled = selected === 0;
  $("#delete-all-proxies").disabled = total === 0;
}
async function deleteProxies(ids, message) {
  if (!ids.length || !confirm(message)) return;
  try {
    const results = await Promise.allSettled(ids.map((id) => api(`proxies/${id}`, {method: "DELETE"})));
    const failed = results.filter(({status}) => status === "rejected");
    if (failed.length) setError(`Deleted ${ids.length - failed.length} of ${ids.length} proxies. ${failed[0].reason.message}`);
    selectedProxyIds.clear();
    await loadProxies();
  } catch (cause) { setError(cause.message); }
}
function renderRuns(runs) {
  data.activeRun = runs.find(active) || null;
  $("#run-submit").disabled = Boolean(data.activeRun);
  renderRunProgress(runs);
  $("#runs").replaceChildren(...runs.map((run) => Object.assign(document.createElement("li"), {textContent: `#${run.id}${run.batch_id ? ` · batch ${run.batch_index}/${run.batch_total}` : ""} · ${run.workflow_name || run.workflow_id} · ${run.status}${run.cleanup_status ? ` · cleanup: ${run.cleanup_status}` : ""}${run.error_message ? ` · ${run.error_message}` : ""}`})));
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
async function loadProfiles() {
  try { data.profiles = await api("gemlogin/profiles"); option($("#profile"), data.profiles, "Choose a profile"); renderProfiles(); }
  catch { setError("Profiles could not be loaded."); }
}
async function optionalLoad(path, fallback) {
  try { return await api(path); }
  catch { setError("Some dashboard data could not be loaded."); return fallback; }
}
async function load() {
  const history = loadRuns();
  const [health, workflows, groups, profiles, settings] = await Promise.all([optionalLoad("health", null), optionalLoad("gemlogin/workflows", []), optionalLoad("gemlogin/groups", []), optionalLoad("gemlogin/profiles", []), optionalLoad("settings", null)]);
  data = {...data, workflows, groups, profiles};
  status.dataset.state = health?.app === "ok" ? "ready" : "error";
  status.textContent = health?.app === "ok" ? `Service ready; GemLogin ${health.gemlogin}.` : "Service unavailable.";
  renderSettings(settings);
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
    try {
      const run = await api(`runs/${id}`);
      if (run.created_profile_id && !data.profiles.some((profile) => String(profile.id) === String(run.created_profile_id))) await loadProfiles();
      const runs = await api("runs");
      renderRuns(runs);
      if (!active(run)) await loadProfiles();
    }
    catch (cause) { setError(cause.message); poll(id); }
  }, 2000);
}
function initialize() {
  status = $("#status"); error = $("#error"); runForm = $("#run-form"); proxyForm = $("#proxy-form"); settingsForm = $("#settings-form");
  syncRunForm();
  runForm.addEventListener("change", (event) => { if (["profile_mode", "proxy_mode", "execution_mode"].includes(event.target.name)) syncRunForm(); if (event.target.id === "workflow") renderParameters(); });
  runForm.addEventListener("submit", async (event) => {
  event.preventDefault(); setError("");
  const form = new FormData(runForm); const workflow = data.workflows.find((item) => String(item.id) === form.get("workflow_id"));
  const payload = {workflow_id: form.get("workflow_id"), workflow_name: workflow?.name || null, profile_mode: form.get("profile_mode"), cleanup_requested: form.has("cleanup_requested"), parameter: {}};
  payload.parameter = serializeParameters($("#parameters").querySelectorAll("[name^='parameter.']"));
  if (payload.profile_mode === "existing") payload.profile_id = form.get("profile_id");
  else Object.assign(payload, {profile_name: form.get("profile_name"), group_id: form.get("group_id"), proxy_mode: form.get("proxy_mode"), repeat_count: Number(form.get("repeat_count") || 1), execution_mode: form.get("execution_mode"), max_concurrency: form.get("execution_mode") === "parallel" ? Number(form.get("max_concurrency") || 2) : 1, ...(form.get("proxy_mode") === "manual" ? {raw_proxy: form.get("raw_proxy")} : {})});
  try { $("#run-submit").disabled = true; const run = await api("runs", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(payload)}); runForm.elements.raw_proxy.value = ""; status.textContent = `${run.batch_id ? `Batch ${run.batch_id}` : `Run #${run.id}`} started.`; await loadRuns(); }
  catch (cause) { setError(cause.message); $("#run-submit").disabled = false; }
});
  proxyForm.addEventListener("submit", async (event) => {
  event.preventDefault(); setError(""); const form = new FormData(proxyForm); const proxies = parseProxyLines(form.get("raw_proxy"));
  proxyForm.elements.raw_proxy.value = proxies.join("\n");
  if (!proxies.length) { setError("Enter at least one proxy, one per line."); return; }
  const prefix = String(form.get("label") || "").trim(); let saved = 0;
  try {
    for (const [index, rawProxy] of proxies.entries()) {
      const label = prefix ? `${prefix}${proxies.length > 1 ? ` ${index + 1}` : ""}` : `Proxy ${index + 1}`;
      await api("proxies", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({label, raw_proxy: rawProxy, enabled: form.has("enabled")})});
      saved += 1;
    }
    proxyForm.reset(); proxyForm.elements.enabled.checked = true; updateProxyCount(); await loadProxies();
  } catch (cause) { setError(`Saved ${saved} of ${proxies.length} proxies. ${cause.message}`); await loadProxies(); }
  });
  proxyForm.elements.raw_proxy.addEventListener("input", updateProxyCount);
  updateProxyCount();
  $("#proxy-select-all").addEventListener("change", (event) => {
    selectedProxyIds = event.target.checked ? new Set(data.proxies.map((proxy) => String(proxy.id))) : new Set();
    renderProxies();
  });
  $("#delete-selected-proxies").addEventListener("click", () => deleteProxies([...selectedProxyIds], `Delete ${selectedProxyIds.size} selected proxies?`));
  $("#delete-all-proxies").addEventListener("click", () => deleteProxies(data.proxies.map((proxy) => proxy.id), `Delete all ${data.proxies.length} proxies?`));
  settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault(); setError(""); const form = new FormData(settingsForm);
    try {
      const saved = await api("settings", {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify(Object.fromEntries(form))});
      settingsForm.reset(); renderSettings(saved); $("#settings-state").textContent = "Saved securely."; status.textContent = "Settings saved; GemLogin is ready.";
    } catch (cause) { $("#settings-state").textContent = ""; setError(cause.message); }
  });
  load();
}
if (typeof document !== "undefined") initialize();
