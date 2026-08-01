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
  app.post("/api/runs", async (request, response) => {
    if (!runService) return response.status(503).json({error: "Run service unavailable"});
    try {
      response.status(201).json(await runService.start(request.body));
    } catch (error) {
      response.status(/active run/.test(error.message) ? 409 : 400).json({error: error.message});
    }
  });
  app.get("/api/runs/:runId", (request, response) => {
    if (!runService) return response.status(503).json({error: "Run service unavailable"});
    const run = runService.get(request.params.runId);
    return run ? response.json(run) : response.status(404).json({error: "Run not found"});
  });

  return app;
}
