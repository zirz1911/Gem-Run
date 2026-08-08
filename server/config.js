export function loadConfig(env) {
  const runTimeoutSeconds = Number(env.RUN_TIMEOUT_SECONDS ?? 300);
  if (!Number.isFinite(runTimeoutSeconds) || runTimeoutSeconds <= 0) {
    throw new Error("RUN_TIMEOUT_SECONDS must be a finite positive number");
  }
  const schedulePollIntervalSeconds = Number(env.SCHEDULE_POLL_INTERVAL_SECONDS ?? 15);
  if (!Number.isFinite(schedulePollIntervalSeconds) || schedulePollIntervalSeconds <= 0) {
    throw new Error("SCHEDULE_POLL_INTERVAL_SECONDS must be a finite positive number");
  }
  const gemloginExecutionMode = env.GEMLOGIN_EXECUTION_MODE || "cloud";
  if (!["local", "cloud"].includes(gemloginExecutionMode)) {
    throw new Error("GEMLOGIN_EXECUTION_MODE must be local or cloud");
  }
  return {
    gemloginBase: env.GEMLOGIN_BASE || "http://127.0.0.1:1010",
    gemloginCdpBase: env.GEMLOGIN_CDP_BASE || "http://127.0.0.1:9222",
    cloudBase: env.GEMLOGIN_CLOUD_BASE || "https://app.gemlogin.io",
    cloudDeviceId: env.GEMLOGIN_CLOUD_DEVICE_ID || "",
    cloudSoftId: env.GEMLOGIN_CLOUD_SOFT_ID || "",
    cloudToken: env.GEMLOGIN_CLOUD_TOKEN || "",
    proxyEncryptionKey: env.PROXY_ENCRYPTION_KEY || "",
    runTimeoutSeconds,
    schedulePollIntervalSeconds,
    gemloginExecutionMode,
    port: Number(env.PORT || 3200)
  };
}
