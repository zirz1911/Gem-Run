import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {createApp} from "./app.js";
import {loadConfig} from "./config.js";
import {decodeEncryptionKey} from "./crypto.js";
import {openDatabase} from "./database.js";
import {GemLoginClient} from "./gemlogin-client.js";
import {ProxyStore, RunStore} from "./proxy-store.js";
import {RunService} from "./run-service.js";

const config = loadConfig(process.env);
const databasePath = process.env.DATABASE_PATH || "data/gem-run.sqlite";
mkdirSync(dirname(databasePath), {recursive: true});
const db = openDatabase(databasePath);
const proxyEncryptionKey = decodeEncryptionKey(config.proxyEncryptionKey);
const gemloginClient = new GemLoginClient({
  baseUrl: config.gemloginBase,
  cloudBase: config.cloudBase,
  cloudDeviceId: config.cloudDeviceId,
  cloudSoftId: config.cloudSoftId,
  cloudToken: config.cloudToken
});
const runService = new RunService({
  gemloginClient, proxyStore: new ProxyStore(db, proxyEncryptionKey), runStore: new RunStore(db),
  runTimeoutSeconds: config.runTimeoutSeconds
});
void runService.recover().catch(() => console.error("Gem-Run recovery failed"));
const app = createApp({config, gemloginClient, db, runService});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Gem-Run listening on ${config.port}`);
});
