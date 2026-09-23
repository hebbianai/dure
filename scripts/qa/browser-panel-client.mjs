import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { processIdentity } from "../lib/process-identity.mjs";
import { performBackendProfileRequest } from "../../cli/lib/backend-transport.mjs";
import { startBrowserRuntimeFixture } from "./lib/browser-runtime-fixture.mjs";
import { browserViewerRequest } from "./lib/browser-viewer-channel.mjs";
import { prepareBrowserOsIme } from "./lib/browser-os-ime.mjs";

const root = realpathSync(process.env.DURE_QA_STATE_ROOT);
assert.ok(basename(root).startsWith("dure-browser-panel."));
assert.equal(realpathSync(process.env.HOME), join(root, "home"));
assert.equal(realpathSync(process.env.DURE_HOME), join(root, "home/.dure"));
const evidence = process.env.DURE_QA_EVIDENCE_DIR;
assert.equal(realpathSync(evidence), join(root, "evidence"));
const cli = join(process.env.HOME, ".local/share/hebbian-ide-cli/channels", process.env.DURE_APP_CHANNEL, "bin/dure");
assert.ok(realpathSync(cli).startsWith(realpathSync(process.env.HOME) + sep));
const execute = promisify(execFile);
const reports = [];
const receipts = [];
const handoffs = [];
let revision = 0;
let fixture;
let resourceId;
let child;
let exited;
let terminal;
let diagnostic = "";
let fixtureStdout = "";
let outcome;
let nativeIme;
async function bounded(description, read, ready) {
  const deadline = Date.now() + 30_000;
  let value;
  while (Date.now() < deadline) {
    if (terminal !== undefined) throw new Error(`Backend fixture exited: ${diagnostic}`);
    value = await read();
    if (ready(value)) return value;
    await delay(80);
  }
  throw new Error(`Timed out: ${description}; ${JSON.stringify(value)}`);
}
async function command(args, failure = false) {
  let stdout;
  let code = 0;
  try {
    ({ stdout } = await execute(cli, ["browser", "--backend", "browser-test", ...args], { timeout: 50_000, maxBuffer: 2 * 1024 * 1024 }));
  } catch (error) {
    stdout = error.stdout;
    code = error.code;
  }
  const result = JSON.parse(stdout);
  receipts.push({ args, code, result });
  if (failure) {
    assert.notEqual(code, 0, "stale CLI controller must be rejected");
    assert.equal(result.error?.code, "browser_controller_changed");
  }
  else assert.equal(code, 0, JSON.stringify({ args, result }));
  return result;
}
async function action(name, fields = {}) {
  const current = ++revision;
  await browserViewerRequest("/configuration", { revision: current, action: name, ...fields });
  const report = await bounded(`native panel ${name}`, () => browserViewerRequest("/reports"),
    (rows) => rows.some((row) => row.type === "browser-panel" && row.revision === current));
  const received = report.find((row) => row.type === "browser-panel" && row.revision === current);
  reports.push(received);
  assert.equal(received.result, "passed", JSON.stringify(received));
  assert.match(received.userAgent, /AppleWebKit/u);
  if (received.frame) {
    const bytes = Buffer.from(received.frame.src.split(",")[1], "base64");
    writeFileSync(join(evidence, `panel-${current}.jpg`), bytes, { flag: "wx" });
    received.frame.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  return received;
}
async function withHeldInput(lease, exercise) {
  let entered = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const server = createServer(async (_request, response) => {
    entered = true;
    await gate;
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end("released");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/hold`;
  const held = command([
    "eval", resourceId, `(async()=>{await fetch(${JSON.stringify(url)});return 'held input completed'})()`,
    "--controller", lease.controller_id, "--epoch", lease.epoch,
  ]).then((result) => ({ result }), (error) => ({ error }));
  const finish = async () => {
    release();
    const outcome = await held;
    if (outcome.error) throw outcome.error;
    return outcome.result;
  };
  const failures = [];
  try {
    await bounded("actual renderer input reached its response gate", async () => entered, Boolean);
    await exercise(finish);
  } catch (error) {
    failures.push(error);
  } finally {
    release();
    const outcome = await held;
    server.closeAllConnections();
    try {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } catch (error) {
      failures.push(error);
    }
    if (outcome.error && !failures.includes(outcome.error)) failures.push(outcome.error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, failures.map(String).join("\n"));
}
try {
  // Finish the app's managed startup before installing the external fixture route.
  await action("backend-ready");
  const postOsIme = process.env.DURE_BROWSER_PANEL_OS_IME === "1"
    ? await prepareBrowserOsIme(root) : undefined;
  fixture = await startBrowserRuntimeFixture();
  child = spawn(process.env.DURE_BROWSER_PANEL_FIXTURE, ["--ignored", "--exact", "desktop::serve_pro_panel_fixture", "--nocapture"], {
    cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"],
  });
  exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { terminal = { code, signal }; resolve(terminal); });
  });
  let published;
  child.stdout.on("data", (bytes) => {
    fixtureStdout += bytes.toString();
    for (const line of fixtureStdout.split("\n")) {
      const marker = "BROWSER_PANEL_FIXTURE ";
      const index = line.indexOf(marker);
      if (index >= 0) {
        try { published = JSON.parse(line.slice(index + marker.length)); } catch {}
      }
    }
  });
  child.stderr.on("data", (bytes) => { diagnostic += bytes.toString(); });
  const identity = processIdentity(child.pid);
  assert.ok(identity, "fixture process generation must be observable");
  writeFileSync(join(evidence, "backend-owner.json"), JSON.stringify({ pid: child.pid, identity, executable: process.env.DURE_BROWSER_PANEL_FIXTURE, cwd: root }));
  const backend = await bounded("published native backend", async () => published, (value) => !!value);
  assert.equal(backend.pid, child.pid);
  const catalog = JSON.parse(readFileSync(join(backend.home, "backend-profiles.json"), "utf8"));
  assert.equal(catalog.profiles.length, 1);
  const profile = catalog.profiles[0];
  const observed = await performBackendProfileRequest(profile, {
    requestId: randomUUID(), operation: "browser.resource",
    requiredCapabilities: ["browser.resource.v1"], body: { kind: "list" },
  });
  assert.ok(observed.backend.capabilities.includes("backend.connection.persistent"));
  profile.expected.capabilities = [...new Set([...profile.expected.capabilities, "backend.connection.persistent"])];
  profile.default = true;
  writeFileSync(join(evidence, "backend-ready.json"), JSON.stringify({ ...backend, handshake: observed.backend, catalog: observed.result }, null, 2));
  writeFileSync(join(process.env.DURE_HOME, "backend-profiles.json"), JSON.stringify(catalog), { mode: 0o600 });
  const created = await command(["create"]);
  const resource = created.result.control.resource;
  resourceId = resource.resource_id;
  const shown = await command(["show", resourceId]);
  const pageId = shown.result.pages[0].page.page_id;
  const controlled = await command(["control", resourceId, "--controller", "native-panel-agent"]);
  let initialLease = controlled.result.controller;
  const flags = (lease) => ["--page", pageId, "--controller", lease.controller_id, "--epoch", lease.epoch];
  const url = `${fixture.url}/?owner=native-panel`;
  await command(["goto", resourceId, url, ...flags(initialLease)]);
  const seedPage = () => command(["eval", resourceId, `
    document.body.style.background='rgb(210,220,230)';
    window.fixture.previewClicks = 0;
    for (const [id, left, width] of [['preview-one', 60, 140], ['preview-two', 230, 160]]) {
      const button = document.createElement('button');
      button.id = id; button.textContent = id; button.type = 'button';
      button.style.cssText = 'position:fixed;box-sizing:border-box;margin:0;top:200px;height:40px;left:'+left+'px;width:'+width+'px';
      button.addEventListener('click', () => window.fixture.previewClicks++);
      document.body.append(button);
    }
    document.querySelector('input').focus();
    ({ ...window.fixture, pixelRatio: window.devicePixelRatio })
  `, ...flags(initialLease)]);
  let initial = await seedPage();
  let instance = initial.result.response.data.result.instance;
  assert.ok(instance);
  assert.equal(initial.result.response.data.result.pixelRatio, 1, "fixture hover coordinates use CSS-sized decoded frames");
  const addressFocus = process.env.DURE_BROWSER_PANEL_INTERACTION === "1";
  const hidden = !addressFocus && process.env.DURE_BROWSER_PANEL_OS_IME !== "1";
  let attached = await action("attach", { resource, pageId, url: addressFocus ? "" : url, focusAddressBeforeObservation: addressFocus, color: [210, 220, 230], presentation: hidden, hidden });
  if (hidden) {
    const args = ["client", "pane", "state", "browser:native-panel-proof", "--json"];
    const state = JSON.parse((await execute(cli, args, { timeout: 30_000 })).stdout);
    receipts.push({ args, result: state });
    assert.equal(state.pane.status, "attached");
    assert.deepEqual(JSON.parse(state.pane.context).resource, resource);
    assert.equal(JSON.parse(state.pane.context).page.page_id, pageId);
    assert.equal(state.pane.actionDefinitions["take-control"].unavailable, undefined);
    assert.ok(state.pane.actions.includes("reconnect"));
    assert.equal(attached.frame, undefined, "a never-revealed Space must not capture frames");
    const oldRevision = JSON.parse(state.pane.context).page.document_revision;
    await command(["goto", resourceId, url, ...flags(initialLease)]);
    await command(["snapshot", resourceId, "--page", pageId]);
    const beforeHandback = JSON.parse((await execute(cli, args, { timeout: 30_000 })).stdout);
    const handbackArgs = ["client", "pane", "act", "browser:native-panel-proof", "take-control", "--args-json",
      JSON.stringify(beforeHandback.pane.actionDefinitions["take-control"].current), "--json"];
    const handback = JSON.parse((await execute(cli, handbackArgs, { timeout: 30_000 })).stdout);
    assert.equal(handback.pane.result.outcome, "applied");
    const afterHandback = JSON.parse((await execute(cli, args, { timeout: 30_000 })).stdout);
    assert.equal(afterHandback.pane.status, "attached", "handback must not leave browser_document_changed");
    assert.ok(BigInt(JSON.parse(afterHandback.pane.context).page.document_revision) > BigInt(oldRevision));
    receipts.push({ args: handbackArgs, result: handback }, { args, result: afterHandback });
    initialLease = (await command(["control", resourceId, "--controller", "native-panel-agent"])).result.controller;
    initial = await seedPage();
    instance = initial.result.response.data.result.instance;

    assert.deepEqual((await command(["show", resourceId])).result.control.controller, initialLease);
    const opened = await command(["open-url", `${fixture.url}/next`, "--resource", resourceId, "--space", attached.spaceId,
      "--controller", initialLease.controller_id, "--epoch", initialLease.epoch]);
    assert.equal(opened.presentation.state, "requested");
    assert.equal(opened.presentation.panelId, "browser:native-panel-proof");
    const presentedPage = opened.result.response.data.page.page_id;
    await action("presentation-watch", { pageId: presentedPage, hidden: true });
    const presented = JSON.parse((await execute(cli, args, { timeout: 30_000 })).stdout);
    receipts.push({ args, result: presented });
    assert.equal(presented.pane.status, "attached");
    assert.equal(JSON.parse(presented.pane.context).page.page_id, presentedPage);
    assert.equal(presented.pane.actionDefinitions["take-control"].unavailable, undefined);
    await command(["tab", "close", resourceId, "--page", presentedPage,
      "--controller", initialLease.controller_id, "--epoch", initialLease.epoch]);
    await action("present-page", { pageId, hidden: true });
    attached = await action("reveal", { pageId, color: [210, 220, 230] });
  }
  assert.deepEqual(attached.binding.resource, resource);
  assert.equal(attached.binding.pageId, pageId);
  assert.equal(attached.address, url, "current URL arrives even when the untouched address field is already focused");
  assert.equal(attached.inputReadOnly, true);
  if (process.env.DURE_BROWSER_PANEL_INTERACTION === "1") {
    await action("frame-fail");
    const changed = await command(["eval", resourceId, "document.body.style.background = 'rgb(170, 190, 210)'", ...flags(initialLease)]);
    assert.equal(changed.result.response.success, true, "agent input succeeds while the pane cannot display a fresh frame");
    const recovered = await action("frame-resume", { color: [170, 190, 210] });
    assert.equal(recovered.inputReadOnly, true, "read recovery never acquires the agent's controller lease");
    await command(["eval", resourceId, `
      document.body.style.minHeight = '10000px';
      const marker = document.createElement('div');
      marker.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:20px;z-index:99999';
      document.body.append(marker);
      const paint = () => marker.style.background = 'rgb(' + (30 + Math.round(scrollY / 10)) + ',80,120)';
      addEventListener('scroll', paint); paint();
    `, ...flags(initialLease)]);
    const paneId = "browser:native-panel-proof";
    const stateArgs = ["client", "pane", "state", paneId, "--json"];
    const state = JSON.parse((await execute(cli, stateArgs, { timeout: 30_000 })).stdout);
    const context = JSON.parse(state.pane.context);
    assert.deepEqual(context.resource, resource);
    assert.equal(context.controller.controller_id, initialLease.controller_id);
    const handbackArgs = ["client", "pane", "act", paneId, "take-control", "--args-json", JSON.stringify(state.pane.actionDefinitions["take-control"].current), "--json"];
    const handedBack = JSON.parse((await execute(cli, handbackArgs, { timeout: 30_000 })).stdout);
    assert.equal(handedBack.pane.result.outcome, "applied");
    receipts.push({ args: stateArgs, result: state }, { args: handbackArgs, result: handedBack });
    const fitted = await action("observe", { color: [30, 80, 120], controlled: true });
    assert.equal(fitted.inputReadOnly, false, "agent handback settles the mounted pane viewport");
    const scrolled = await action("scroll");
    const blurred = await action("address-blur");
    const human = (await command(["show", resourceId])).result.control.controller;
    const position = await command(["eval", resourceId, "scrollY", ...flags(human)]);
    const { timings, latencies } = scrolled.interaction;
    const idle = timings.slice(1).map((row, index) => row.start - timings[index].end);
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const measurements = { latencies, timings, idle, medianIdleMs: median(idle), medianWheelToFrameMs: median(latencies), scrollY: position.result.response.data.result, address: blurred.address, url };
    writeFileSync(join(evidence, "interaction.json"), JSON.stringify(measurements, null, 2));
    await action("close");
    resourceId = undefined;
    assert.equal(measurements.scrollY, 1200, "all twelve wheel deltas reach the real page");
    assert.ok(timings.length >= 5, "measure several actual native captures");
    assert.ok(measurements.medianIdleMs < 50, JSON.stringify(measurements));
    assert.equal(blurred.address, url, "leaving an empty draft restores the observed URL");
    outcome = { result: "passed", measurements };
  } else {
  const taken = await action("take");
  assert.equal(taken.inputReadOnly, false);
  const human = await command(["show", resourceId]);
  assert.match(human.result.control.controller.controller_id, /^view:/u);
  await command(["inserttext", resourceId, "STALE MUST NOT APPEAR", ...flags(initialLease)], true);
  assert.equal((await command(["get", resourceId, "value", "input", "--page", pageId])).result.data.value, "");
  if (postOsIme) {
    nativeIme = await postOsIme({ action, command, resourceId, pageId, controller: human.result.control.controller });
    writeFileSync(join(evidence, "browser-os-ime.json"), JSON.stringify(nativeIme, null, 2), { flag: "wx", mode: 0o600 });
    await command(["fill", resourceId, "input", "", ...flags(human.result.control.controller)]);
    assert.equal((await command(["get", resourceId, "value", "input", "--page", pageId])).result.data.value, "");
  }
  const text = "한글 Pro 패널 입력";
  await action("compose", { text });
  const typed = await bounded("CLI reads the panel's Korean input", () => command(["get", resourceId, "value", "input", "--page", pageId]), (value) => value.result.data.value === text);
  assert.equal(typed.result.data.value, text);
  const namedSnapshot = await command(["snapshot", "--resource", resourceId]);
  const inputReference = Object.entries(namedSnapshot.references ?? {}).find(([, row]) => row.role === "textbox" && row.name === "Name")?.[0];
  assert.ok(inputReference, "the installed CLI snapshot must expose the actual input reference");
  assert.equal((await command(["get", "value", inputReference])).result.data.value, text);
  await command(["fill", inputReference, text, ...flags(human.result.control.controller)]);
  assert.equal((await command(["get", "--resource", resourceId, "value", "input"])).result.data.value, text);
  const firstPreview = await action("preview", { point: { x: 100, y: 220 }, label: "button#preview-one" });
  assert.deepEqual(firstPreview.preview, { x: 60, y: 200, width: 140, height: 40, label: "button#preview-one" });
  const secondPreview = await action("preview", { point: { x: 260, y: 220 }, label: "button#preview-two" });
  assert.deepEqual(secondPreview.preview, { x: 230, y: 200, width: 160, height: 40, label: "button#preview-two" });
  const leftPreview = await action("preview-leave");
  assert.equal(leftPreview.preview, undefined);
  assert.equal(leftPreview.pickerOpen, true);
  const resumedPreview = await action("preview", { point: { x: 100, y: 220 }, label: "button#preview-one" });
  assert.deepEqual(resumedPreview.preview, firstPreview.preview);
  await action("return");
  const returned = await bounded("CLI controller restored", () => command(["show", resourceId]), (value) => value.result.control.controller?.controller_id === initialLease.controller_id);
  const lease = returned.result.control.controller;
  assert.notEqual(lease.epoch, initialLease.epoch);
  const updated = await command(["eval", resourceId, "document.body.style.background='rgb(230,210,180)';window.fixture", ...flags(lease)]);
  assert.equal(updated.result.response.data.result.instance, instance);
  assert.equal(updated.result.response.data.result.previewClicks, 0, "preview must not click either page element");
  // The toolbar offers reconnect after a read failure; healthy views reload.
  await action("frame-fail");
  const reconnected = await action("reconnect", { color: [230, 210, 180] });
  await action("frame-resume", { color: [230, 210, 180] });
  assert.deepEqual(reconnected.binding.resource, resource);
  assert.equal(reconnected.binding.pageId, pageId);
  assert.equal(reconnected.inputReadOnly, true);
  assert.equal((await command(["get", resourceId, "value", "input", "--page", pageId])).result.data.value, text);
  assert.deepEqual(fixture.submissions, [], "handoff and composition must not submit the fixture form");
  // A semantic profile change invalidates the mounted pane's exact route even
  // while its browser, page and controller remain alive on the same backend.
  assert.ok(profile.expected.capabilities.includes("browser.tracing.v1"));
  profile.expected.capabilities = profile.expected.capabilities.filter((capability) => capability !== "browser.tracing.v1");
  writeFileSync(join(process.env.DURE_HOME, "backend-profiles.json"), JSON.stringify(catalog), { mode: 0o600 });
  const recovered = await action("route-recovered", {
    previousRevision: reconnected.binding.authority.revision, pageId, color: [230, 210, 180],
  });
  assert.notEqual(recovered.binding.authority.revision, reconnected.binding.authority.revision);
  assert.deepEqual(recovered.binding.authority.backend, reconnected.binding.authority.backend);
  assert.deepEqual(recovered.binding.resource, resource);
  assert.equal(recovered.inputReadOnly, true);
  assert.deepEqual((await command(["show", resourceId])).result.control.controller, lease);
  assert.equal((await command(["get", resourceId, "value", "input", "--page", pageId])).result.data.value, text);
  assert.deepEqual(fixture.submissions, [], "automatic reconnection must not replay input");
  const controllerFlags = (current) => ["--controller", current.controller_id, "--epoch", current.epoch];
  const secondUrl = `${fixture.url}/?owner=native-current-second`;
  await command(["tab", "create", resourceId, secondUrl, ...controllerFlags(lease)]);
  const twoPages = await command(["show", resourceId]);
  const secondPageId = twoPages.result.pages.find((row) => row.page.page_id !== pageId)?.page.page_id;
  assert.ok(secondPageId);
  assert.equal(twoPages.result.pages.length, 2);
  await command(["eval", resourceId, "document.title='Second shared tab';document.body.style.background='rgb(190,230,210)';document.querySelector('input').focus();true", "--page", secondPageId, ...controllerFlags(lease)]);
  const followed = await action("observe", { pageId: secondPageId, color: [190, 230, 210] });
  assert.equal(followed.binding.followCurrent, true);
  assert.equal(followed.address, secondUrl);
  const inspected = await action("select-page", { pageId, color: [230, 210, 180] });
  assert.equal(inspected.binding.followCurrent, false);
  assert.equal(inspected.inputReadOnly, true);
  assert.equal((await command(["tab", "current", resourceId])).result.tab.page.page_id, secondPageId, "observer inspection cannot redirect the agent's input target");
  const resumed = await action("follow", { pageId: secondPageId, color: [190, 230, 210] });
  assert.equal(resumed.binding.followCurrent, true);
  await action("select-page", { pageId, color: [230, 210, 180] });
  await action("take");
  assert.equal((await command(["tab", "current", resourceId])).result.tab.page.page_id, pageId, "taking control selects the inspected page under the new human lease");
  assert.equal((await command(["get", resourceId, "value", "input"])).result.data.value, text);
  await action("compose-start");
  await action("select-page", { pageId: secondPageId, color: [190, 230, 210] });
  assert.equal((await command(["tab", "current", resourceId])).result.tab.page.page_id, secondPageId, "human tab selection reaches the canonical CLI default target");
  await action("compose-end", { text: "이전 탭의 미완성 입력" });
  assert.equal((await command(["get", resourceId, "value", "input", "--page", secondPageId])).result.data.value, "", "composition started on the original tab cannot enter the newly selected page");
  assert.equal((await command(["get", resourceId, "value", "input", "--page", pageId])).result.data.value, text, "canceled composition leaves the original document unchanged");
  const secondText = "한글 현재 탭 입력";
  await action("compose", { text: secondText });
  const secondTyped = await bounded("default CLI query reads selected-panel input", () => command(["get", resourceId, "value", "input"]), (value) => value.result.data.value === secondText);
  assert.equal(secondTyped.result.data.value, secondText);
  await action("select-page", { pageId, color: [230, 210, 180] });
  assert.equal((await command(["get", resourceId, "value", "input"])).result.data.value, text, "input on the second page leaves the original value intact");
  await action("select-page", { pageId: secondPageId, color: [190, 230, 210] });
  await action("return");
  const secondReturn = await command(["show", resourceId]);
  const finalLease = secondReturn.result.control.controller;
  assert.equal(finalLease.controller_id, initialLease.controller_id);
  assert.equal(secondReturn.result.control.current_page.page_id, secondPageId);
  await command(["tab", "switch", resourceId, "--page", pageId, ...controllerFlags(finalLease)]);
  const agentSwitch = await action("observe", { pageId, color: [230, 210, 180] });
  assert.equal(agentSwitch.binding.followCurrent, true);
  await action("frame-fail");
  const followReconnect = await action("reconnect", { pageId, color: [230, 210, 180] });
  await action("frame-resume", { pageId, color: [230, 210, 180] });
  assert.equal(followReconnect.binding.followCurrent, true);
  assert.equal(followReconnect.inputReadOnly, true);
  assert.deepEqual(fixture.submissions, [], "tab selection and both compositions must not submit either fixture form");
  const controlState = async () => {
    const response = await performBackendProfileRequest(profile, {
      requestId: randomUUID(), operation: "browser.resource",
      requiredCapabilities: ["browser.resource.v1"], body: { kind: "control_state", resource_id: resource.resource_id },
    });
    const current = response.result.result;
    assert.deepEqual(current.resource, resource);
    return current;
  };
  await action("select-page", { pageId: secondPageId, color: [190, 230, 210] });
  await withHeldInput(finalLease, async (finish) => {
    const running = await controlState();
    assert.ok(running.in_flight, "the agent input must already be admitted before takeover");
    assert.deepEqual(running.controller, finalLease);
    handoffs.push({ kind: "take-running", running });
    const waiting = await action("take", { pending: true, pageId: secondPageId });
    assert.equal(waiting.transferring, true);
    assert.equal(waiting.inputReadOnly, true);
    const pending = await controlState();
    assert.deepEqual(pending.controller, finalLease);
    assert.match(pending.requested_controller, /^view:/u);
    assert.equal(pending.in_flight, running.in_flight);
    handoffs.push({ kind: "take", running, pending });
    await finish();
    const selected = await bounded("delayed grant selects the inspected tab", () => command(["tab", "current", resourceId]),
      (value) => value.result.tab.page.page_id === secondPageId);
    assert.equal(selected.result.tab.page.page_id, secondPageId);
    const granted = await controlState();
    assert.equal(granted.controller.controller_id, pending.requested_controller);
    assert.notEqual(granted.controller.epoch, finalLease.epoch);
    assert.equal(granted.requested_controller, null);
    handoffs.push({ kind: "take-granted", granted });
  });
  const lateTaken = await action("observe", { controlled: true, pageId: secondPageId, color: [190, 230, 210] });
  assert.equal(lateTaken.binding.followCurrent, false);
  const lateHuman = (await controlState()).controller;
  await withHeldInput(lateHuman, async (finish) => {
    const running = await controlState();
    assert.ok(running.in_flight, "the human input must already be admitted before return");
    assert.deepEqual(running.controller, lateHuman);
    handoffs.push({ kind: "return-running", running });
    const waiting = await action("return", { pending: true, pageId: secondPageId });
    assert.equal(waiting.transferring, true);
    assert.equal(waiting.inputReadOnly, true);
    const pending = await controlState();
    assert.deepEqual(pending.controller, lateHuman);
    assert.equal(pending.requested_controller, initialLease.controller_id);
    assert.equal(pending.in_flight, running.in_flight);
    handoffs.push({ kind: "return", running, pending });
    await finish();
    const granted = await bounded("delayed return grants the agent", controlState,
      (value) => value.controller.controller_id === initialLease.controller_id);
    assert.equal(granted.requested_controller, null);
    assert.notEqual(granted.controller.epoch, lateHuman.epoch);
    handoffs.push({ kind: "return-granted", granted });
  });
  const resumedAgent = (await controlState()).controller;
  await command(["tab", "switch", resourceId, "--page", pageId, ...controllerFlags(resumedAgent)]);
  const lateFollowed = await action("observe", { controlled: false, pageId, color: [230, 210, 180] });
  assert.equal(lateFollowed.binding.followCurrent, true);
  assert.equal((await command(["get", resourceId, "value", "input"])).result.data.value, text);
  assert.deepEqual(fixture.submissions, [], "delayed handoffs must not submit either form");
  await action("select-page", { pageId: secondPageId, color: [190, 230, 210] });
  await action("take", { pageId: secondPageId });
  await bounded("new viewer grant selects its inspected tab", () => command(["tab", "current", resourceId]),
    (value) => value.result.tab.page.page_id === secondPageId);
  const selectingHuman = (await controlState()).controller;
  await withHeldInput(selectingHuman, async (finish) => {
    const running = await controlState();
    assert.ok(running.in_flight);
    assert.deepEqual(running.controller, selectingHuman);
    await action("return", { pending: true, pageId: secondPageId });
    const selected = await action("select-pending", { pageId });
    assert.equal(selected.binding.followCurrent, false);
    assert.equal(selected.binding.pageId, pageId);
    assert.equal(selected.inputReadOnly, true);
    assert.equal(selected.transferring, true);
    assert.ok(!selected.frame, "the prior tab image cannot represent the newly inspected page");
    const pending = await controlState();
    assert.deepEqual(pending.controller, selectingHuman);
    assert.equal(pending.current_page.page_id, secondPageId);
    assert.equal(pending.requested_controller, initialLease.controller_id);
    assert.equal(pending.in_flight, running.in_flight);
    handoffs.push({ kind: "return-new-selection", running, pending, selected });
    await finish();
    const granted = await bounded("return with a newer selection grants the agent", controlState,
      (value) => value.controller.controller_id === initialLease.controller_id);
    assert.equal(granted.current_page.page_id, secondPageId);
    assert.equal(granted.requested_controller, null);
    assert.notEqual(granted.controller.epoch, selectingHuman.epoch);
    handoffs.push({ kind: "return-new-selection-granted", granted });
  });
  const retainedSelection = await action("observe", { controlled: false, pageId, color: [230, 210, 180] });
  assert.equal(retainedSelection.binding.followCurrent, false);
  assert.equal(retainedSelection.binding.pageId, pageId);
  assert.equal((await command(["tab", "current", resourceId])).result.tab.page.page_id, secondPageId);
  const resumedFollowing = await action("follow", { pageId: secondPageId, color: [190, 230, 210] });
  assert.equal(resumedFollowing.binding.followCurrent, true);
  assert.deepEqual(fixture.submissions, [], "viewer selection during return must not submit either form");
  const savedProfile = await command(["tab", "profile", "create", "--label", "패널 프로필"]);
  const profileId = savedProfile.result.profile.profile.profileId;
  assert.ok(profileId);
  const profileSourceLease = (await controlState()).controller;
  const profileSource = await command(["eval", resourceId,
    "localStorage.setItem('profilePane','기본 저장소');window.profilePane='원본문서';({url:location.href,marker:window.profilePane})",
    "--page", secondPageId, ...controllerFlags(profileSourceLease)]);
  await action("take", { pageId: secondPageId });
  await action("profiles-open", { pageId: secondPageId, profileId });
  const clonedProfile = await action("profile-clone", { profileId });
  const clonedPageId = clonedProfile.binding.pageId;
  assert.ok(clonedPageId && clonedPageId !== secondPageId, "profile clone selects its returned new page");
  const clonedProfileShown = await command(["tab", "profile", "show", resourceId, "--page", clonedPageId]);
  assert.equal(clonedProfileShown.result.profile_id, profileId);
  const profileHuman = (await controlState()).controller;
  const isolatedProfile = await command(["eval", resourceId,
    "({url:location.href,stored:localStorage.getItem('profilePane'),marker:window.profilePane??null})",
    "--page", clonedPageId, ...controllerFlags(profileHuman)]);
  assert.deepEqual(isolatedProfile.result.response.data.result, {
    url: profileSource.result.response.data.result.url, stored: null, marker: null,
  }, "cloning opens the URL with separate storage and no copied document state");
  const pagesAfterClone = await command(["show", resourceId]);
  assert.ok(pagesAfterClone.result.pages.some((row) => row.page.page_id === secondPageId), "cloning keeps the source page open");
  await action("profiles-open", { pageId: clonedPageId, profileId: "default" });
  await action("profile-switch", { pageId: clonedPageId, profileId: "default" });
  const switchedProfile = await command(["tab", "profile", "show", resourceId, "--page", clonedPageId]);
  assert.equal(switchedProfile.result.profile_id, "default");
  assert.equal(switchedProfile.result.page.page_id, clonedPageId, "switching retains the logical page");
  assert.ok(BigInt(switchedProfile.result.page.document_revision) > BigInt(clonedProfileShown.result.page.document_revision));
  const switchedState = await command(["eval", resourceId,
    "({stored:localStorage.getItem('profilePane'),marker:window.profilePane??null})",
    "--page", clonedPageId, ...controllerFlags(profileHuman)]);
  assert.deepEqual(switchedState.result.response.data.result, { stored: "기본 저장소", marker: null });
  assert.deepEqual((await controlState()).controller, profileHuman, "profile operations retain the admitted human lease");
  assert.deepEqual(fixture.submissions, [], "profile changes do not submit either form");
  const managedProfileLabel = `패널에서 만든 프로필 ${randomUUID()}`;
  await action("profiles-open", { pageId: clonedPageId, profileId: "default" });
  await action("profile-new");
  await action("profile-create", { profileName: managedProfileLabel, nativeUserAgent: true });
  const managedProfiles = await command(["tab", "profile", "list"]);
  const managedProfile = managedProfiles.result.profiles.find((row) => row.profile.label === managedProfileLabel);
  assert.ok(managedProfile, "the profile created in the real panel appears in the canonical CLI catalog");
  assert.equal(managedProfile.profile.scope, "isolated");
  assert.equal(managedProfile.profile.userAgentMode, "native");
  const managedPage = await command(["tab", "profile", "show", resourceId, "--page", clonedPageId]);
  assert.equal(managedPage.result.profile_id, managedProfile.profile.profileId, "create-and-switch uses its exact returned profile");
  const managedState = await command(["eval", resourceId, "({stored:localStorage.getItem('profilePane'),marker:window.profilePane??null})", "--page", clonedPageId, ...controllerFlags(profileHuman)]);
  assert.deepEqual(managedState.result.response.data.result, { stored: null, marker: null });
  await action("profiles-open", { pageId: clonedPageId, profileId: managedProfile.profile.profileId });
  await action("profile-delete-open");
  await action("profile-delete-cancel");
  const canceledProfile = await command(["tab", "profile", "show", resourceId, "--page", clonedPageId]);
  assert.equal(canceledProfile.result.profile_id, managedProfile.profile.profileId, "canceling deletion leaves the page and profile intact");
  await action("profile-delete-open");
  const deletedView = await action("profile-delete-confirm", { pageId: clonedPageId });
  assert.notEqual(deletedView.binding.pageId, clonedPageId, "the deleted page is no longer selected");
  if (!deletedView.frame) assert.equal(deletedView.inputReadOnly, true, "no current page grants no input authority");
  const retiredCatalog = await bounded("profile catalog retirement", () => command(["tab", "profile", "list"]),
    (value) => !value.result.profiles.some((row) => row.profile.profileId === managedProfile.profile.profileId && row.state !== "deleted"));
  assert.ok(!retiredCatalog.result.profiles.some((row) => row.profile.profileId === managedProfile.profile.profileId && row.state !== "deleted"));
  const survivingPages = await command(["show", resourceId]);
  assert.ok(!survivingPages.result.pages.some((row) => row.page.page_id === clonedPageId), "deleting the profile closes its page");
  assert.ok(survivingPages.result.pages.some((row) => row.page.page_id === secondPageId), "deleting a profile preserves pages using default storage");
  await action("select-page", { pageId: secondPageId, controlled: true });
  assert.equal((await command(["tab", "current", resourceId])).result.tab.page.page_id, secondPageId, "explicit viewer selection restores the surviving input target");
  assert.deepEqual((await controlState()).controller, profileHuman);
  assert.deepEqual(fixture.submissions, [], "profile management never submits a page form");
  await action("close");
  const listed = await command(["list"]);
  assert.ok(!listed.result.resources.some((row) => row.resource.resource_id === resourceId));
  resourceId = undefined;
  outcome = { result: "passed", instance, resource, pageId, text, secondPageId, secondText, previewClicks: updated.result.response.data.result.previewClicks, fixtureSubmissions: fixture.submissions };
  }
} catch (error) {
  outcome = { result: "failed", error: error instanceof Error ? error.stack : String(error) };
} finally {
  const cleanupErrors = [];
  if (resourceId && terminal === undefined) {
    try { await command(["close", resourceId]); } catch (error) { cleanupErrors.push(String(error)); }
  }
  if (child) {
    child.stdin.end();
    try {
      const exit = await Promise.race([exited, delay(50_000, undefined, { ref: false }).then(() => { throw new Error("Backend shutdown not observed"); })]);
      assert.equal(exit.code, 0, diagnostic);
    } catch (error) { cleanupErrors.push(String(error)); }
  }
  await fixture?.close();
  writeFileSync(join(evidence, "browser-panel.json"), JSON.stringify({ ...outcome, reports, receipts, handoffs, nativeIme, cleanupErrors }, null, 2));
  writeFileSync(join(evidence, "last-status.json"), JSON.stringify({ ...outcome, reports, receipts, handoffs, nativeIme, cleanupErrors }, null, 2));
  writeFileSync(join(evidence, "backend-stderr.log"), diagnostic);
  writeFileSync(join(evidence, "backend-stdout.log"), fixtureStdout);
  assert.deepEqual(cleanupErrors, [], "Native fixture cleanup must be observed");
}
assert.equal(outcome.result, "passed", JSON.stringify(outcome));
console.log(process.env.DURE_BROWSER_PANEL_INTERACTION === "1"
  ? "Actual Pro BrowserPanel / native Tauri IPC / Chromium scroll, capture cadence and address blur: PASS"
  : "Actual Pro BrowserPanel / native Tauri IPC / pinned CLI handoff, Korean input, reconnect and close: PASS");
