import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {createApp} from "./app.js";
import {loadConfig} from "./config.js";
import {decodeEncryptionKey} from "./crypto.js";
import {openDatabase} from "./database.js";
import {GemLoginClient} from "./gemlogin-client.js";

const config = loadConfig(process.env);
const databasePath = process.env.DATABASE_PATH || "data/gem-run.sqlite";
mkdirSync(dirname(databasePath), {recursive: true});
const db = openDatabase(databasePath);
decodeEncryptionKey(config.proxyEncryptionKey);
const gemloginClient = new GemLoginClient({
  baseUrl: config.gemloginBase,
  cloudBase: config.cloudBase,
  cloudDeviceId: config.cloudDeviceId,
  cloudSoftId: config.cloudSoftId,
  cloudToken: config.cloudToken
});
const app = createApp({config, gemloginClient, db, runService: null});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Gem-Run listening on ${config.port}`);
});
