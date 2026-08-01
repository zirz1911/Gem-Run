import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("dashboard exposes the required panels without cloud credential names", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/app.js", root), "utf8")
  ]);

  for (const panel of ["Run Workflow", "Profiles", "Proxy Pool", "Run History"]) {
    assert.match(html, new RegExp(`<h2[^>]*>${panel}</h2>`));
  }
  assert.doesNotMatch(script, /GEMLOGIN_CLOUD_(?:DEVICE_ID|SOFT_ID|TOKEN)/);
});
