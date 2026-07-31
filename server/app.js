import express from "express";

export function createApp({config, gemloginClient, db, runService}) {
  const app = express();

  app.use(express.json({limit: "100kb"}));
  app.use(express.static("public"));
  app.get("/api/health", async (_request, response) => {
    let gemlogin = "not configured";
    if (gemloginClient) {
      try {
        gemlogin = await gemloginClient.status();
      } catch {
        gemlogin = "unavailable";
      }
    }
    response.json({app: "ok", gemlogin});
  });
  app.get("/", (_request, response) => response.sendFile("index.html", {root: "public"}));

  return app;
}
