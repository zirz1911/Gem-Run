import {mkdirSync} from "node:fs";
import {dirname, join} from "node:path";
import {createApp} from "./app.js";
import {loadConfig} from "./config.js";
import {loadOrCreateEncryptionKey} from "./crypto.js";
import {openDatabase} from "./database.js";
import {GemLoginClient} from "./gemlogin-client.js";
import {ProxyStore, RunStore} from "./proxy-store.js";
import {RunService} from "./run-service.js";
import {SettingsStore} from "./settings-store.js";
import {ScheduleStore} from "./schedule-store.js";
import {Scheduler} from "./scheduler.js";

const config = loadConfig(process.env);
const databasePath = process.env.DATABASE_PATH || "data/gem-run.sqlite";
mkdirSync(dirname(databasePath), {recursive: true});
const db = openDatabase(databasePath);
const proxyEncryptionKey = loadOrCreateEncryptionKey(config.proxyEncryptionKey, process.env.PROXY_ENCRYPTION_KEY_FILE || join(dirname(databasePath), ".proxy-encryption-key"));
const settingsStore = new SettingsStore(db, proxyEncryptionKey);
const savedSettings = settingsStore.getAll();
const gemloginClient = new GemLoginClient({
  baseUrl: config.gemloginBase,
  cdpBase: config.gemloginCdpBase,
  cloudBase: config.cloudBase,
      cloudDeviceId: savedSettings.cloud_device_id || config.cloudDeviceId,
      cloudSoftId: savedSettings.cloud_soft_id || config.cloudSoftId,
      cloudToken: savedSettings.cloud_token || config.cloudToken
});
const proxyStore = new ProxyStore(db, proxyEncryptionKey);
const runStore = new RunStore(db);
const scheduleStore = new ScheduleStore(db, proxyEncryptionKey);
const runService = new RunService({
  gemloginClient, proxyStore, runStore,
  runTimeoutSeconds: config.runTimeoutSeconds
});
const scheduler = new Scheduler({scheduleStore, runService, runStore, intervalMs: config.schedulePollIntervalSeconds * 1000});
void runService.recover().catch(() => console.error("Gem-Run recovery failed"));
const app = createApp({config, gemloginClient, proxyStore, runStore, runService, settingsStore, scheduleStore, scheduler});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Gem-Run listening on ${config.port}`);
  scheduler.start();
});

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
  await scheduler.stop();
  server.close(() => process.exit(0));
});
