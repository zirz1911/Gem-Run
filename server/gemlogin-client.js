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
  constructor({baseUrl, cloudBase, cloudDeviceId, cloudSoftId, cloudToken, fetchImpl = fetch}) {
    this.baseUrl = baseUrl?.replace(/\/$/, "");
    this.cloudBase = cloudBase?.replace(/\/$/, "");
    this.cloudDeviceId = cloudDeviceId;
    this.cloudSoftId = cloudSoftId;
    this.cloudToken = cloudToken;
    this.secrets = [cloudToken].filter(Boolean);
    this.fetchImpl = fetchImpl;
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
  listProfiles(options) { return this.local("/api/profiles", options); }
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
    });
  }
}
