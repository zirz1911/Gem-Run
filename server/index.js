import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import Database from "better-sqlite3";
import {createApp} from "./app.js";
import {loadConfig} from "./config.js";
import {GemLoginClient} from "./gemlogin-client.js";

const config = loadConfig(process.env);
const databasePath = process.env.DATABASE_PATH || "data/gem-run.sqlite";
mkdirSync(dirname(databasePath), {recursive: true});
const db = new Database(databasePath);
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
