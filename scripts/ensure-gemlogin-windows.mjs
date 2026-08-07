import {execFile, spawn} from "node:child_process";
import {access} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import {promisify} from "node:util";

const execFileAsync = promisify(execFile);
const requestTimeoutMs = 2000;
const startupTimeoutMs = 30000;

export function decideGemLoginStartup({apiReady, cdpReady, gemLoginRunning, status}) {
  if (apiReady && cdpReady) {
    if (!gemLoginRunning) throw new Error("GemLogin endpoints are occupied by an unknown process");
    return "reuse";
  }
  if (cdpReady && !apiReady) throw new Error("GemLogin local API is unavailable while CDP is active");
  if (!gemLoginRunning) return "start";
  if (!apiReady || !status) throw new Error("GemLogin status is unavailable; the running process was not stopped");
  if (!Object.hasOwn(status, "activeBrowsers")) throw new Error("GemLogin activeBrowsers is unavailable; the running process was not stopped");
  const activeBrowsers = Number(status.activeBrowsers);
  if (!Number.isInteger(activeBrowsers) || activeBrowsers < 0) {
    throw new Error("GemLogin activeBrowsers is unavailable; the running process was not stopped");
  }
  if (activeBrowsers > 0) throw new Error(`GemLogin has ${activeBrowsers} active browsers; close them before restarting Gem-Run`);
  return "restart";
}

export function gemLoginArguments(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("GEMLOGIN_CDP_PORT must be a valid TCP port");
  return [`--remote-debugging-port=${value}`];
}

export async function waitUntil(check, {timeoutMs, intervalMs = 250, timeoutMessage}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(timeoutMessage);
}

async function request(url, {json = false} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {signal: controller.signal});
    if (!response.ok) return null;
    return json ? await response.json() : true;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function listGemLoginProcesses() {
  const command = "Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'gemlogin.exe' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  const {stdout} = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {windowsHide: true});
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((process) => ({
    processId: Number(process.ProcessId),
    commandLine: String(process.CommandLine ?? "")
  })).filter((process) => Number.isInteger(process.processId) && process.processId > 0);
}

async function stopIdleGemLogin() {
  const command = [
    "$main = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'gemlogin.exe' -and $_.CommandLine -notmatch '--type=' })",
    "foreach ($item in $main) { $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue; if ($process -and $process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() } }",
    "$deadline = (Get-Date).AddSeconds(10)",
    "do { Start-Sleep -Milliseconds 250; $remaining = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'gemlogin.exe' }) } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)",
    "if ($remaining.Count -gt 0) { $remaining | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } }"
  ].join("; ");
  await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {windowsHide: true});
  await waitUntil(async () => (await listGemLoginProcesses()).length === 0, {
    timeoutMs: 5000,
    timeoutMessage: "GemLogin did not stop before the shutdown deadline"
  });
}

async function startGemLogin(executable, args) {
  await access(executable);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {detached: true, stdio: "ignore", windowsHide: false});
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function waitForReady(apiUrl, cdpUrl, timeoutMs = startupTimeoutMs) {
  await waitUntil(async () => {
    const [apiReady, cdpReady] = await Promise.all([request(apiUrl), request(cdpUrl)]);
    return Boolean(apiReady && cdpReady);
  }, {timeoutMs, timeoutMessage: "GemLogin API/CDP did not become ready before the startup deadline"});
}

export async function ensureGemLogin({
  executable = process.env.GEMLOGIN_EXE,
  apiBase = process.env.GEMLOGIN_BASE,
  cdpBase = process.env.GEMLOGIN_CDP_BASE,
  cdpPort = process.env.GEMLOGIN_CDP_PORT
} = {}) {
  if (process.platform !== "win32") throw new Error("GemLogin Windows supervision is only available on Windows");
  if (!executable || !apiBase || !cdpBase) throw new Error("GemLogin Windows startup configuration is incomplete");
  const args = gemLoginArguments(cdpPort);
  const apiUrl = `${apiBase.replace(/\/$/, "")}/api/status`;
  const cdpUrl = `${cdpBase.replace(/\/$/, "")}/json/version`;
  const [apiReady, cdpReady, processes] = await Promise.all([
    request(apiUrl),
    request(cdpUrl),
    listGemLoginProcesses()
  ]);
  const status = processes.length && apiReady && !cdpReady ? await request(apiUrl, {json: true}) : null;
  const action = decideGemLoginStartup({apiReady: Boolean(apiReady), cdpReady: Boolean(cdpReady), gemLoginRunning: processes.length > 0, status});
  if (action === "reuse") return action;
  if (action === "restart") await stopIdleGemLogin();
  await startGemLogin(executable, args);
  await waitForReady(apiUrl, cdpUrl);
  return action;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureGemLogin().then((action) => {
    console.log(`GemLogin ready (${action})`);
  }).catch((error) => {
    console.error(`GemLogin startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
