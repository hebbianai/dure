import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, openSync, closeSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, createConnection } from "node:net";
import { buildAndroidFixture } from "./mobile-android-fixture.mjs";

const sdk = process.env.ANDROID_HOME || join(homedir(), "Library/Android/sdk");
const root = mkdtempSync(join(tmpdir(), "dure-mobile-android-"));
const avdRoot = join(root, "avd"); mkdirSync(avdRoot);
const sdkHome = join(root, "android-home"); mkdirSync(sdkHome);
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const environment = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_AVD_HOME: avdRoot, ANDROID_USER_HOME: sdkHome,
 ANDROID_EMULATOR_HOME: sdkHome, ANDROID_ADB_SERVER_PORT: String(port), ADB_SERVER_SOCKET: `tcp:127.0.0.1:${port}`,
 ADB_MDNS_AUTO_CONNECT: "", ADB_LOCAL_TRANSPORT_MAX_PORT: "0", PATH: `${join(sdk, "platform-tools")}:${process.env.PATH}` };
for (const key of ["DURE_CONTROL_PLANE_BIN", "DURE_CLAUDE_PROCESS_RELAY_BIN", "CARGO_TARGET_DIR"]) delete environment[key];
const run = (binary, args, options = {}) => execFileSync(binary, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024, env: environment, ...options });
const app = buildAndroidFixture(root, sdk);
const avdmanager = join(sdk, "cmdline-tools/latest/bin/avdmanager");
const name = `DureMobileQA-${Date.now()}`;
run(avdmanager, ["create", "avd", "-n", name, "-k", "system-images;android-35;google_apis_playstore;arm64-v8a", "-p", join(avdRoot, name)], { input: "no\n" });
const owner = resolve("scripts/qa/lib/owned-process-group.mjs");
function launchOwned(label, binary, args) {
 const descriptor = join(root, `${label}-process.json`);
 const log = openSync(join(root, `${label}.log`), "wx");
 const process = spawn(globalThis.process.execPath, [owner, "run-observed", descriptor, "--", binary, ...args], { env: environment, stdio: ["ignore", log, log] });
 closeSync(log);
 return { process, descriptor, exited: new Promise((resolve) => process.once("exit", resolve)) };
}
async function stopOwned(owned) {
 if (!owned || !existsSync(owned.descriptor)) return;
 run(process.execPath, [owner, "inspect", owned.descriptor, String(owned.process.pid)]);
 run(process.execPath, [owner, "terminate", owned.descriptor, String(owned.process.pid)]);
 await owned.exited;
}
const adb = join(sdk, "platform-tools/adb");
// A private foreground server avoids altering a user's adb daemon or USB devices.
const server = launchOwned("adb", adb, ["--one-device", name, "-L", `tcp:${port}`, "server", "nodaemon"]);
let emulator;
let id;
try {
 const readyBy = Date.now() + 10000;
 while (true) {
  assert.equal(server.process.exitCode, null, `Owned adb server exited; inspect ${root}`);
  const listening = await new Promise((resolve) => {
   const socket = createConnection({ host: "127.0.0.1", port });
   socket.once("connect", () => { socket.destroy(); resolve(true); });
   socket.once("error", () => resolve(false));
  });
  if (listening && existsSync(server.descriptor)) break;
  assert.ok(Date.now() < readyBy, `Owned adb server did not listen; inspect ${root}`);
  await delay(100);
 }
 run(process.execPath, [owner, "inspect", server.descriptor, String(server.process.pid)]);
 emulator = launchOwned("emulator", join(sdk, "emulator/emulator"), ["-avd", name, "-no-window", "-no-audio", "-no-snapshot", "-no-boot-anim", "-gpu", "swiftshader_indirect", "-memory", "2048"]);
 const descriptor = emulator.descriptor;
 const deadline = Date.now() + 150_000;
 while (!id && Date.now() < deadline) {
  const devices = run(adb, ["devices"]).split("\n").filter((line) => /^emulator-\d+\s+device/.test(line)).map((line) => line.split(/\s+/)[0]);
  for (const candidate of devices) {
   try { if (run(adb, ["-s", candidate, "emu", "avd", "name"]).split("\n")[0].trim() === name) id = candidate; } catch {}
  }
  if (!id) await delay(1000);
 }
 assert.ok(id && existsSync(descriptor), `Owned Android emulator did not start; inspect ${root}`);
 run(process.execPath, [owner, "inspect", descriptor, String(emulator.process.pid)]);
 writeFileSync(join(root, "ownership.json"), JSON.stringify({ root, id, name, descriptor, supervisorPid: emulator.process.pid, adbPort: port, adbDescriptor: server.descriptor, cwd: process.cwd() }, null, 2));
 console.log("Android ownership:", join(root, "ownership.json"));
 const deadlineBoot = Date.now() + 120_000;
 while (true) {
  const boot = spawnSync(adb, ["-s", id, "shell", "getprop", "sys.boot_completed"], { env: environment, encoding: "utf8", timeout: 10000 });
  if (boot.status === 0 && boot.stdout.trim() === "1") break;
  assert.equal(emulator.process.exitCode, null, "Owned emulator exited before boot");
  assert.ok(Date.now() < deadlineBoot, `Android boot timeout: ${boot.stderr}`);
  await delay(1000);
 }
 const url = `index.html?qaWindowSmokeController=1&qaMobileSimulator=${id}&platform=android&fixture=${Buffer.from(app).toString("base64url")}`;
 const child = spawn("sh", ["scripts/qa/lib/tauri-app-runner.sh"], { stdio: "inherit", env: { ...environment, DURE_QA_MOBILE_DEVICE: id, DURE_QA_CLIENT: resolve("scripts/qa/mobile-simulator-client.mjs"), DURE_QA_NAME: "Native Android simulator", DURE_QA_ARTIFACT_NAME: "mobile-android", DURE_QA_LAYER: "background", DURE_QA_UNIQUE_APP_CHANNEL: "1", DURE_QA_WINDOW_URL: url, DURE_QA_WINDOW_PLAN_JSON: JSON.stringify([{ label: "main", title: "Dure Android Simulator QA", url, width: 600, height: 1000, x: -4000, y: -2000, visible: true, focus: false, focusable: false }]) } });
 process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
} finally {
 try {
  await stopOwned(emulator);
  if (id) run(adb, ["-s", id, "wait-for-disconnect"], { timeout: 10000 });
 } finally { await stopOwned(server); }
}
