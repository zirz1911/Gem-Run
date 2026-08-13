import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("dashboard exposes the required panels without cloud credential names", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/app.js", root), "utf8")
  ]);

  for (const panel of ["Run Workflow", "Scheduled Profiles", "Profiles", "Proxy Pool", "Run History"]) {
    assert.match(html, new RegExp(`<h2[^>]*>${panel}</h2>`));
  }
  assert.doesNotMatch(script, /GEMLOGIN_CLOUD_(?:DEVICE_ID|SOFT_ID|TOKEN)/);
  assert.match(html, /id="delete-selected-proxies"/);
  assert.match(html, /id="delete-all-proxies"/);
  assert.match(html, /id="run-progress"/);
  assert.match(script, /Promise\.allSettled\(ids\.map/);
  assert.match(html, /name="repeat_count"/);
  assert.match(html, /name="execution_mode"/);
  assert.match(html, /name="max_concurrency"/);
  assert.match(html, /class="field schedule-batch-field"/);
  assert.match(html, /id="schedule-concurrency-warning"/);
  assert.match(html, /name="close_browser"/);
  assert.match(html, /name="delete_profile"/);
  assert.match(html, /id="run-cancel"/);
  assert.match(html, /id="schedule-form"/);
  assert.match(html, /name="profile_count_mode"/);
  assert.match(html, /name="max_concurrency"/);
  assert.match(html, /id="schedules"/);
  assert.match(html, /id="schedule-parameters"/);
  assert.match(script, /schedules\/\$\{schedule\.id\}\/runs/);
  assert.match(script, /renderScheduleParameters/);
  assert.match(script, /paused by Manual run/);
  const styles = await readFile(new URL("public/styles.css", root), "utf8");
  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.match(styles, /\.history-panel\s*\{\s*grid-column:\s*span 4;\s*grid-row:\s*1;/);
  assert.match(styles, /\.schedule-history\s*\{[^}]*max-height:\s*210px;[^}]*overflow-y:\s*auto;/);
  assert.match(styles, /\.schedule-actions button\s*\{[^}]*height:\s*32px;/);
  assert.match(script, /repeat_count/);
  assert.match(script, /max_concurrency/);
  assert.match(script, /cannot exceed Maximum profiles/);
  assert.match(script, /renderRunProgress/);
  assert.match(script, /runs\/\$\{run\.id\}\/cancel/);
});

test("workflow form serialization preserves checked and unchecked booleans", async () => {
  const {serializeParameters, parseProxyLines, selectExistingProfileIds, batchSize, batchExecutionSettings, runConcurrencyActive} = await import(`../public/app.js?form-contract=${Date.now()}`);
  assert.deepEqual(serializeParameters([
    {name: "parameter.enabled", type: "checkbox", checked: true, value: "on"},
    {name: "parameter.archive", type: "checkbox", checked: false, value: "on"},
    {name: "parameter.limit", type: "number", value: "2"}
  ]), {enabled: true, archive: false, limit: 2});
  assert.deepEqual(parseProxyLines(" http://one:1:u:p \n\nhttp://two:2:u:p\r\n"), ["http://one:1:u:p", "http://two:2:u:p"]);
  const profiles = [{id: 1, group_id: 7}, {id: 2, group_id: 8}, {id: 3, group_id: 7}];
  assert.deepEqual(selectExistingProfileIds(profiles, "group", "", "7"), [1, 3]);
  assert.deepEqual(selectExistingProfileIds(profiles, "all", "", ""), [1, 2, 3]);
  assert.equal(batchSize("new", profiles, "profile", "", "", 500), 500);
  assert.equal(batchSize("existing", profiles, "group", "", "7", 1), 2);
  assert.equal(batchSize("existing", profiles, "all", "", "", 1), 3);
  assert.deepEqual(batchExecutionSettings("parallel", "25"), {execution_mode: "parallel", max_concurrency: 25});
  assert.deepEqual(batchExecutionSettings("sequential", "25"), {execution_mode: "sequential", max_concurrency: 1});
  assert.equal(runConcurrencyActive("existing", "profile", "sequential"), false);
  assert.equal(runConcurrencyActive("existing", "group", "sequential"), false);
  assert.equal(runConcurrencyActive("existing", "group", "parallel"), true);
  assert.equal(runConcurrencyActive("new", "profile", "parallel"), true);
});

test("maps GemLogin parameter types to matching controls", async () => {
  const {parameterControlType} = await import(`../public/app.js?parameter-types=${Date.now()}`);
  assert.equal(parameterControlType({type: "checkbox"}), "checkbox");
  assert.equal(parameterControlType({type: "filepath"}), "text");
  assert.equal(parameterControlType({type: "number"}), "number");
  assert.equal(parameterControlType({type: "divider"}), null);
  assert.equal(parameterControlType({type: "label"}), null);
  assert.equal(parameterControlType({type: "string", options: ["a", "b"]}), "select");
});

test("summarizes active batch progress", async () => {
  const {summarizeBatchProgress} = await import(`../public/app.js?progress-contract=${Date.now()}`);
  assert.deepEqual(summarizeBatchProgress([
    {id: 3, batch_id: "batch-1", batch_total: 3, status: "queued"},
    {id: 2, batch_id: "batch-1", batch_total: 3, status: "running"},
    {id: 1, batch_id: "batch-1", batch_total: 3, status: "done"}
  ]), {total: 3, completed: 1, running: 1, queued: 1, percent: 33});
  assert.equal(summarizeBatchProgress([{id: 1, status: "done"}]), null);
});

test("dashboard contracts retry a failed run poll and load history independently", async () => {
  const script = await readFile(new URL("public/app.js", root), "utf8");
  assert.match(script, /catch \(cause\) \{ setError\(cause\.message\); poll\(id\); \}/);
  assert.match(script, /await loadRuns\(\);/);
  assert.match(script, /async function loadProfiles\(\)/);
  assert.match(script, /const runs = await api\("runs"\);/);
  assert.match(script, /if \(!active\(run\)\) await loadProfiles\(\);/);
});
