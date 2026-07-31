const sensitiveName = /(?:api[_-]?key|authorization|cookie|credential|pass(?:word)?|secret|token|user(?:name)?)/i;

function sanitize(value, sensitive = false) {
  if (sensitive) return "***";
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (!value || typeof value !== "object") return value;

  const parameterName = String(value.name ?? value.key ?? value.id ?? "");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "proxy" && typeof item === "string") {
      return [key, item.replace(/\/\/[^/@]+@/, "//***:***@")];
    }
    return [key, sanitize(item, sensitiveName.test(key) || (key === "default" && sensitiveName.test(parameterName)))];
  }));
}

export class GemLoginClient {
  constructor({baseUrl, cloudBase, cloudDeviceId, cloudSoftId, cloudToken, fetchImpl = fetch}) {
    this.baseUrl = baseUrl?.replace(/\/$/, "");
    this.cloudBase = cloudBase?.replace(/\/$/, "");
    this.cloudDeviceId = cloudDeviceId;
    this.cloudSoftId = cloudSoftId;
    this.cloudToken = cloudToken;
    this.fetchImpl = fetchImpl;
  }

  async request(baseUrl, path, {method = "GET", body} = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : {"content-type": "application/json"},
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new Error("GemLogin request failed (HTTP 0): unavailable");
    }
    if (!response.ok) {
      throw new Error(`GemLogin request failed (HTTP ${response.status}): unavailable`);
    }
    try {
      return sanitize(await response.json());
    } catch {
      throw new Error(`GemLogin request failed (HTTP ${response.status}): invalid JSON response`);
    }
  }

  local(path, options) {
    return this.request(this.baseUrl, path, options);
  }

  status() { return this.local("/api/status"); }
  listProfiles() { return this.local("/api/profiles"); }
  getProfile(profileId) { return this.local(`/api/profile/${encodeURIComponent(profileId)}`); }
  listGroups() { return this.local("/api/groups"); }
  listWorkflows() { return this.local("/api/scripts"); }
  createProfile(details) { return this.local("/api/profiles/create", {method: "POST", body: details}); }
  startProfile(profileId) { return this.local(`/api/profiles/start/${encodeURIComponent(profileId)}`); }
  closeProfile(profileId) { return this.local(`/api/profiles/close/${encodeURIComponent(profileId)}`); }
  deleteProfile(profileId) { return this.local(`/api/profiles/delete/${encodeURIComponent(profileId)}`); }
  checkProfileStatus(profileId) { return this.local(`/api/profiles/check-status/${encodeURIComponent(profileId)}`, {method: "POST"}); }
  checkScriptStatus(scriptId, profileId) {
    return this.local(`/api/scripts/check-status/${encodeURIComponent(scriptId)}`, {method: "POST", body: {profileId: String(profileId)}});
  }

  executeCloud({profileId, workflowId, parameter, closeBrowser}) {
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
      }
    });
  }
}
