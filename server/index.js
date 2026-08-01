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

const config = loadConfig(process.env);
const databasePath = process.env.DATABASE_PATH || "data/gem-run.sqlite";
mkdirSync(dirname(databasePath), {recursive: true});
const db = openDatabase(databasePath);
const proxyEncryptionKey = loadOrCreateEncryptionKey(config.proxyEncryptionKey, process.env.PROXY_ENCRYPTION_KEY_FILE || join(dirname(databasePath), ".proxy-encryption-key"));
const settingsStore = new SettingsStore(db, proxyEncryptionKey);
const savedSettings = settingsStore.getAll();
const gemloginClient = new GemLoginClient({
  baseUrl: config.gemloginBase,
  cloudBase: config.cloudBase,
      cloudDeviceId: savedSettings.cloud_device_id || config.cloudDeviceId,
      cloudSoftId: savedSettings.cloud_soft_id || config.cloudSoftId,
      cloudToken: savedSettings.cloud_token || config.cloudToken
});
const proxyStore = new ProxyStore(db, proxyEncryptionKey);
const runStore = new RunStore(db);
const runService = new RunService({
  gemloginClient, proxyStore, runStore,
  runTimeoutSeconds: config.runTimeoutSeconds
});
void runService.recover().catch(() => console.error("Gem-Run recovery failed"));
const app = createApp({config, gemloginClient, proxyStore, runStore, runService, settingsStore});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Gem-Run listening on ${config.port}`);
});
