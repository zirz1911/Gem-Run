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
  assert.match(html, /id="delete-selected-proxies"/);
  assert.match(html, /id="delete-all-proxies"/);
  assert.match(script, /Promise\.allSettled\(ids\.map/);
});

test("workflow form serialization preserves checked and unchecked booleans", async () => {
  const {serializeParameters, parseProxyLines} = await import(`../public/app.js?form-contract=${Date.now()}`);
  assert.deepEqual(serializeParameters([
    {name: "parameter.enabled", type: "checkbox", checked: true, value: "on"},
    {name: "parameter.archive", type: "checkbox", checked: false, value: "on"},
    {name: "parameter.limit", type: "number", value: "2"}
  ]), {enabled: true, archive: false, limit: "2"});
  assert.deepEqual(parseProxyLines(" http://one:1:u:p \n\nhttp://two:2:u:p\r\n"), ["http://one:1:u:p", "http://two:2:u:p"]);
});

test("dashboard contracts retry a failed run poll and load history independently", async () => {
  const script = await readFile(new URL("public/app.js", root), "utf8");
  assert.match(script, /catch \(cause\) \{ setError\(cause\.message\); poll\(id\); \}/);
  assert.match(script, /await loadRuns\(\);/);
  assert.match(script, /async function loadProfiles\(\)/);
  assert.match(script, /await Promise\.all\(\[loadRuns\(\), loadProfiles\(\)\]\)/);
});
