import express from "express";

const invalidRunRequests = new Set([
  "workflow_id is required", "profile_mode must be existing or new", "profile_id is required",
  "cleanup is only available for new profiles", "profile_name is required", "group_id is required",
  "proxy_mode must be none, manual, or random", "Proxy must be a string",
  "Proxy must include scheme, host, port, and complete credentials", "Proxy host is invalid",
  "Proxy port must be between 1 and 65535"
]);

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
      if (error?.message === "an active run already exists") return response.status(409).json({error: "An active run already exists"});
      if (invalidRunRequests.has(error?.message)) return response.status(400).json({error: "Invalid run request"});
      return response.status(500).json({error: "Unable to start run"});
    }
  });
  app.get("/api/runs/:runId", (request, response) => {
    if (!runService) return response.status(503).json({error: "Run service unavailable"});
    const run = runService.get(request.params.runId);
    return run ? response.json(run) : response.status(404).json({error: "Run not found"});
  });

  return app;
}
