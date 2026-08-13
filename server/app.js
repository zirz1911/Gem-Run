import express from "express";
import {createRoutes} from "./routes.js";

export function createApp({config, gemloginClient, proxyStore, runStore, runService, settingsStore, scheduleStore, scheduler}) {
  const app = express();

  app.use(express.json({limit: "100kb"}));
  app.use(express.static("public"));
  app.use(createRoutes({config, gemloginClient, proxyStore, runStore, runService, settingsStore, scheduleStore, scheduler}));
  app.get("/", (_request, response) => response.sendFile("index.html", {root: "public"}));

  return app;
}
