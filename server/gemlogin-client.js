const sensitiveName = /(?:api[_-]?key|authorization|cookie|credential|pass(?:word)?|secret|token|user(?:name)?)/i;

function sanitize(value, secrets = [], sensitive = false) {
  if (sensitive) return "***";
  if (typeof value === "string") return secrets.reduce((masked, secret) => masked.replaceAll(secret, "***"), value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets));
  if (!value || typeof value !== "object") return value;

  const parameterName = String(value.name ?? value.key ?? value.id ?? "");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "proxy" && typeof item === "string") {
      return [key, sanitize(item.replace(/\/\/[^/@]+@/, "//***:***@").replace(/^(\w+:\/\/[^:]+:\d+):[^:]*:[^:]*$/, "$1:***:***"), secrets)];
    }
    return [key, sanitize(item, secrets, sensitiveName.test(key) || (key === "default" && sensitiveName.test(parameterName)))];
  }));
}

export class GemLoginClient {
  constructor({baseUrl, cdpBase = "", cloudBase, cloudDeviceId, cloudSoftId, cloudToken, fetchImpl = fetch, webSocketImpl = WebSocket}) {
    this.baseUrl = baseUrl?.replace(/\/$/, "");
    this.cdpBase = cdpBase?.replace(/\/$/, "");
    this.cloudBase = cloudBase?.replace(/\/$/, "");
    this.cloudDeviceId = cloudDeviceId;
    this.cloudSoftId = cloudSoftId;
    this.cloudToken = cloudToken;
    this.secrets = [cloudToken].filter(Boolean);
    this.fetchImpl = fetchImpl;
    this.webSocketImpl = webSocketImpl;
  }

  configureCloud({cloudDeviceId, cloudSoftId, cloudToken}) {
    Object.assign(this, {cloudDeviceId, cloudSoftId, cloudToken});
    this.secrets = [cloudToken].filter(Boolean);
  }

  async request(baseUrl, path, {method = "GET", body, signal} = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : {"content-type": "application/json"},
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(signal ? {signal} : {})
      });
    } catch {
      throw new Error("GemLogin request failed (HTTP 0): unavailable");
    }
    if (!response.ok) {
      throw new Error(`GemLogin request failed (HTTP ${response.status}): unavailable`);
    }
    try {
      return sanitize(await response.json(), this.secrets);
    } catch {
      throw new Error(`GemLogin request failed (HTTP ${response.status}): invalid JSON response`);
    }
  }

  local(path, options) {
    return this.request(this.baseUrl, path, options);
  }

  status(options) { return this.local("/api/status", options); }
  async listProfiles(options) {
    const first = await this.local("/api/profiles", options);
    if (!Array.isArray(first?.data) || first.data.length < 50) return first;
    const profiles = [...first.data];
    for (let page = 2; ; page += 1) {
      const next = await this.local(`/api/profiles?page=${page}`, options);
      const pageProfiles = Array.isArray(next?.data) ? next.data : [];
      profiles.push(...pageProfiles);
      if (pageProfiles.length < 50) return {...first, data: profiles};
    }
  }
  getProfile(profileId, options) { return this.local(`/api/profile/${encodeURIComponent(profileId)}`, options); }
  listGroups(options) { return this.local("/api/groups", options); }
  listWorkflows(options) { return this.local("/api/scripts", options); }
  createProfile(details, options = {}) { return this.local("/api/profiles/create", {method: "POST", body: details, ...options}); }
  startProfile(profileId, options) { return this.local(`/api/profiles/start/${encodeURIComponent(profileId)}`, options); }
  closeProfile(profileId, options) { return this.local(`/api/profiles/close/${encodeURIComponent(profileId)}`, options); }
  deleteProfile(profileId, options) { return this.local(`/api/profiles/delete/${encodeURIComponent(profileId)}`, options); }
  checkProfileStatus(profileId, options = {}) { return this.local(`/api/profiles/check-status/${encodeURIComponent(profileId)}`, {method: "POST", ...options}); }
  checkScriptStatus(scriptId, profileId, options = {}) {
    return this.local(`/api/scripts/check-status/${encodeURIComponent(scriptId)}`, {method: "POST", body: {profileId: String(profileId)}, ...options});
  }

  async refreshProfileList({signal} = {}) {
    if (!this.cdpBase) throw new Error("GemLogin profile refresh is not configured");
    const targets = await this.request(this.cdpBase, "/json/list", {signal});
    const target = targets.find((item) => item.type === "page" && item.url?.includes("#/profiles"));
    if (!target?.webSocketDebuggerUrl) throw new Error("GemLogin profile page is not available");
    const cdp = new URL(this.cdpBase);
    const targetUrl = new URL(target.webSocketDebuggerUrl);
    const webSocketUrl = `${cdp.protocol === "https:" ? "wss" : "ws"}://${cdp.host}${targetUrl.pathname}`;
    await new Promise((resolve, reject) => {
      const socket = new this.webSocketImpl(webSocketUrl);
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        try { socket.close(); } catch {}
        error ? reject(error) : resolve();
      };
      const abort = () => finish(new Error("GemLogin profile refresh aborted"));
      const timeout = setTimeout(() => finish(new Error("GemLogin profile refresh timed out")), 10000);
      signal?.addEventListener("abort", abort, {once: true});
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          awaitPromise: true,
          returnByValue: true,
          expression: `(async()=>{const b=[...document.querySelectorAll('button.el-button.is-plain.is-circle')].find(b=>b.querySelector('path')?.getAttribute('d')?.startsWith('M2 12'));if(!b)throw new Error('Refresh profile list button not found');b.click();await new Promise(r=>setTimeout(r,1000));return true})()`
        }
      })));
      socket.addEventListener("message", (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return finish(new Error("GemLogin profile refresh returned invalid data")); }
        if (message.id !== 1) return;
        if (message.result?.exceptionDetails) return finish(new Error("GemLogin profile refresh failed"));
        finish(message.error ? new Error("GemLogin profile refresh failed") : null);
      });
      socket.addEventListener("error", () => finish(new Error("GemLogin profile refresh connection failed")));
    });
  }

  executeLocal({profileId, workflowId, parameter, closeBrowser}, options = {}) {
    return this.local(`/api/scripts/execute/${encodeURIComponent(workflowId)}`, {
      method: "POST", body: {profileId: [String(profileId)], parameters: parameter ?? {}, closeBrowser}, ...options
    });
  }

  executeCloud({profileId, workflowId, parameter, closeBrowser}, options = {}) {
    return this.request(this.cloudBase, "/api/v2/execscript", {
      method: "POST",
      body: {
        profile_id: [String(profileId)],
        workflow_id: workflowId,
        parameter,
        close_browser: closeBrowser,
        device_id: this.cloudDeviceId,
        soft_id: this.cloudSoftId,
        token: this.cloudToken
      },
      ...options
    }).then((result) => {
      if (result?.success === false) throw new Error(`GemLogin workflow rejected: ${result.message || "unknown error"}`);
      if (typeof result?.data !== "string") return result;
      let nested;
      try { nested = JSON.parse(result.data); } catch { return result; }
      if (nested?.success === false) throw new Error(`GemLogin workflow rejected: ${nested.message || "unknown error"}`);
      return {...result, data: nested};
    });
  }
}
