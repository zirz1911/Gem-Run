export function loadConfig(env) {
  const runTimeoutSeconds = Number(env.RUN_TIMEOUT_SECONDS ?? 300);
  if (!Number.isFinite(runTimeoutSeconds) || runTimeoutSeconds <= 0) {
    throw new Error("RUN_TIMEOUT_SECONDS must be a finite positive number");
  }
  return {
    gemloginBase: env.GEMLOGIN_BASE || "http://host.docker.internal:1010",
    cloudBase: env.GEMLOGIN_CLOUD_BASE || "https://app.gemlogin.io",
    cloudDeviceId: env.GEMLOGIN_CLOUD_DEVICE_ID || "",
    cloudSoftId: env.GEMLOGIN_CLOUD_SOFT_ID || "",
    cloudToken: env.GEMLOGIN_CLOUD_TOKEN || "",
    proxyEncryptionKey: env.PROXY_ENCRYPTION_KEY || "",
    runTimeoutSeconds,
    port: Number(env.PORT || 3200)
  };
}
