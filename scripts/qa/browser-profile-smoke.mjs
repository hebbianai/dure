#!/usr/bin/env node
// Disposable engine feasibility proof; no product or personal-profile access.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { probeBrowserNative } from "./lib/browser-native-probe.mjs";

const [binaryArgument, chromeArgument] = process.argv.slice(2);
if (!binaryArgument || !chromeArgument)
  throw new Error(
    "usage: browser-profile-smoke.mjs <agent-browser-v0.36.0> <chromium-executable>",
  );
const binary = resolve(binaryArgument);
const chrome = resolve(chromeArgument);
const binarySha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
assert.equal(
  binarySha256,
  "b2106ab39db0838e7b1772f7f26f760518de56d09053150c56f9dddf15af997d",
  "Use the same pinned engine as the product adapter",
);
const root = await mkdtemp("/tmp/dure-profile-proof-");
await chmod(root, 0o700);
const evidence = {
  schemaVersion: 1,
  scope: "profile-engine-feasibility",
  productReady: false,
  limitations: [
    "This command exercises Chromium and the pinned native daemon, not Dure CLI or Host admission.",
    "Profile create/delete/switch/clone, metadata recovery, concurrent workspace authority and installed distribution remain unimplemented or unverified.",
    "Service-worker registration persistence is observed; offline service-worker behavior is not tested.",
  ],
  source: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  root,
  binary,
  binarySha256,
  chrome,
  chromiumVersion: execFileSync(chrome, ["--version"], {
    encoding: "utf8",
  }).trim(),
  probeSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  startedAt: new Date().toISOString(),
  checks: [],
  processes: [],
  cleanup: [],
};
const owned = [];
const sockets = [];
const env = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
  TMPDIR: root,
};
const page = `<!doctype html><meta charset="utf-8"><title>Disposable profile fixture</title><input id="name"><script>
window.instance=crypto.randomUUID();
window.database=()=>new Promise((resolve,reject)=>{const open=indexedDB.open('profile-proof',1);open.onupgradeneeded=()=>open.result.createObjectStore('values');open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error)});
window.writeState=async value=>{
 document.cookie='persistent='+encodeURIComponent(value)+'; Path=/; Max-Age=3600; SameSite=Lax';
 document.cookie='transient='+encodeURIComponent(value)+'; Path=/; SameSite=Lax';
 localStorage.setItem('owner',value);sessionStorage.setItem('owner',value);
 const db=await database();await new Promise((resolve,reject)=>{const tx=db.transaction('values','readwrite');tx.objectStore('values').put(value,'owner');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
 const cache=await caches.open('profile-proof');await cache.put('/cache-proof',new Response(value));
 await navigator.serviceWorker.register('/worker.js');await navigator.serviceWorker.ready;
 return readState();
};
window.readState=async()=>{
 const db=await database();const indexed=await new Promise((resolve,reject)=>{const r=db.transaction('values').objectStore('values').get('owner');r.onsuccess=()=>resolve(r.result??null);r.onerror=()=>reject(r.error)});db.close();
 const cached=await (await caches.open('profile-proof')).match('/cache-proof');
 return {instance,local:localStorage.getItem('owner'),session:sessionStorage.getItem('owner'),cookie:document.cookie,indexed,cache:cached?await cached.text():null,workers:(await navigator.serviceWorker.getRegistrations()).map(r=>r.scope)};
};
</script>`;
const server = createServer((request, response) => {
  if (request.url === "/worker.js") {
    response.writeHead(200, {
      "content-type": "text/javascript",
      "cache-control": "no-store",
    });
    response.end(
      "self.addEventListener('install',event=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(clients.claim()));",
    );
  } else {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(page);
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const url = `http://127.0.0.1:${server.address().port}/`;
evidence.origin = url;
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function launchChild(profile, cwd, label) {
  const args = [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=1280,720",
    "--disable-backgrounding-occluded-windows",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "--disable-sync",
    "--password-store=basic",
    "--use-mock-keychain",
    "about:blank",
  ];
  const child = spawn(chrome, args, {
    cwd,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const record = {
    label,
    pid: child.pid,
    executable: chrome,
    cwd,
    profile,
    args,
  };
  evidence.processes.push(record);
  const entry = { child, record, stderr: "", done: false, cdp: null };
  entry.exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      entry.done = true;
      record.exit = { code, signal };
      resolve(record.exit);
    });
  });
  child.stderr.on("data", (chunk) => {
    entry.stderr = (entry.stderr + chunk).slice(-32768);
  });
  owned.push(entry);
  return entry;
}
async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  sockets.push(socket);
  const pending = new Map();
  let sequence = 0;
  await bounded(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("CDP open failed")),
        { once: true },
      );
    }),
    5000,
    "CDP open timeout",
  );
  function failAll() {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP closed"));
    }
    pending.clear();
  }
  socket.addEventListener("close", failAll);
  socket.addEventListener("error", failAll);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    clearTimeout(p.timer);
    message.error
      ? p.reject(new Error(JSON.stringify(message.error)))
      : p.resolve(message.result);
  });
  return {
    request(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    close() {
      socket.close();
      failAll();
    },
  };
}
async function launch(name, label) {
  const profile = join(root, name);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const cwd = await mkdtemp(join(root, "process-"));
  await chmod(cwd, 0o700);
  let old;
  try {
    old = await readFile(join(profile, "DevToolsActivePort"), "utf8");
  } catch {}
  const entry = launchChild(profile, cwd, label);
  const deadline = Date.now() + 12000;
  let port;
  while (Date.now() < deadline) {
    if (entry.done)
      throw new Error(
        `Chrome startup exited: ${JSON.stringify(entry.record.exit)} ${entry.stderr}`,
      );
    try {
      const text = await readFile(join(profile, "DevToolsActivePort"), "utf8");
      if (text !== old) {
        const lines = text.trim().split("\n");
        if (
          /^\d+$/.test(lines[0]) &&
          lines[1]?.startsWith("/devtools/browser/")
        ) {
          port = lines;
          break;
        }
      }
    } catch {}
    await delay(25);
  }
  assert.ok(port, "Chromium startup must publish a fresh endpoint");
  entry.endpoint = `ws://127.0.0.1:${port[0]}${port[1]}`;
  entry.cdp = await connect(entry.endpoint);
  return entry;
}
async function close(entry) {
  if (entry.done) {
    evidence.cleanup.push({
      pid: entry.child.pid,
      confirmed: true,
      exit: entry.record.exit,
    });
    return;
  }
  if (entry.socket)
    try {
      await native(entry, { action: "close" });
    } catch (error) {
      entry.record.closeResponse = String(error);
    }
  else if (entry.cdp)
    try {
      await entry.cdp.request("Browser.close");
    } catch (error) {
      entry.record.closeResponse = String(error);
    }
  await bounded(entry.exit, 12000, "Owned browser process did not exit");
  entry.cdp?.close();
  evidence.cleanup.push({
    pid: entry.child.pid,
    confirmed: true,
    exit: entry.record.exit,
  });
}

async function launchNative(browser, label) {
  const cwd = await mkdtemp(join(root, "worker-"));
  await chmod(cwd, 0o700);
  const config = join(cwd, "config.json");
  await writeFile(config, "{}\n", { mode: 0o600 });
  const child = spawn(binary, [], {
    cwd,
    env: {
      ...env,
      TMPDIR: cwd,
      AGENT_BROWSER_DAEMON: "1",
      AGENT_BROWSER_SESSION: "worker",
      AGENT_BROWSER_SOCKET_DIR: cwd,
      AGENT_BROWSER_CONFIG: config,
      AGENT_BROWSER_CDP: browser.endpoint,
      AGENT_BROWSER_NO_WEBMCP: "1",
      AGENT_BROWSER_NO_AUTO_DIALOG: "1",
      AGENT_BROWSER_DEFAULT_TIMEOUT: "5000",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const record = {
    label,
    pid: child.pid,
    executable: binary,
    cwd,
    browserPid: browser.child.pid,
  };
  evidence.processes.push(record);
  const entry = {
    child,
    record,
    stderr: "",
    done: false,
    socket: join(cwd, "worker.sock"),
  };
  entry.exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      entry.done = true;
      record.exit = { code, signal };
      resolve(record.exit);
    });
  });
  child.stderr.on("data", (chunk) => {
    entry.stderr = (entry.stderr + chunk).slice(-32768);
  });
  owned.push(entry);
  const deadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < deadline) {
    if (entry.done) throw new Error(`Native daemon exited: ${entry.stderr}`);
    try {
      await access(entry.socket);
      ready = true;
      break;
    } catch {}
    await delay(25);
  }
  assert.ok(ready, "Native daemon must publish its owned socket");
  await native(entry, { action: "stream_disable" });
  const stream = await native(entry, { action: "stream_status" });
  assert.equal(stream.enabled, false);
  assert.equal(stream.port, null);
  return entry;
}
async function native(entry, command) {
  const response = await probeBrowserNative(entry.socket, command);
  assert.equal(response.success, true, JSON.stringify(response));
  return response.data;
}
async function proveNativeSharing(browser, first, second) {
  const one = await launchNative(browser, "shared-profile native worker one");
  const two = await launchNative(browser, "shared-profile native worker two");
  const oneTabs = await native(one, { action: "tab_list", pinTab: true });
  const twoTabs = await native(two, { action: "tab_list", pinTab: true });
  const oneTab = oneTabs.tabs.find((t) => t.targetId === first.targetId);
  const twoTab = twoTabs.tabs.find((t) => t.targetId === second.targetId);
  assert.ok(oneTab);
  assert.ok(twoTab);
  // A browser endpoint exposes both pages to both workers. It is not a resource
  // capability; the product must route only Host-owned target identities.
  assert.ok(oneTabs.tabs.some((t) => t.targetId === second.targetId));
  assert.ok(twoTabs.tabs.some((t) => t.targetId === first.targetId));
  await native(one, {
    action: "tab_switch",
    tabId: oneTab.tabId,
    pinTab: true,
  });
  await native(two, {
    action: "tab_switch",
    tabId: twoTab.tabId,
    pinTab: true,
  });
  const identityOne = await evaluate(first, "instance");
  const identityTwo = await evaluate(second, "instance");
  const firstRead = await native(one, {
    action: "evaluate",
    script: "window.instance",
  });
  const secondRead = await native(two, {
    action: "evaluate",
    script: "window.instance",
  });
  assert.equal(firstRead.result, identityOne);
  assert.equal(secondRead.result, identityTwo);
  await close(one);
  assertOwner(await evaluate(first, "readState()"), "작업 A");
  assert.equal(
    (await native(two, { action: "evaluate", script: "window.instance" }))
      .result,
    identityTwo,
  );
  await close(two);
  assertOwner(await evaluate(second, "readState()"), "작업 A");
  assert.equal(browser.done, false);
  const reattached = await launchNative(
    browser,
    "shared-profile replacement worker",
  );
  const reattachedTabs = await native(reattached, {
    action: "tab_list",
    pinTab: true,
  });
  const retainedTab = reattachedTabs.tabs.find(
    (tab) => tab.targetId === first.targetId,
  );
  assert.ok(
    retainedTab,
    "A new native worker must retain the existing browser page",
  );
  await native(reattached, {
    action: "tab_switch",
    tabId: retainedTab.tabId,
    pinTab: true,
  });
  assert.equal(
    (
      await native(reattached, {
        action: "evaluate",
        script: "window.instance",
      })
    ).result,
    identityOne,
  );
  assertOwner(await evaluate(first, "readState()"), "작업 A");
  await close(reattached);
  evidence.checks.push({
    name: "two pinned native workers address distinct tabs; worker close and replacement retain the same browser pages",
    oneTargets: oneTabs.tabs.map((t) => t.targetId),
    twoTargets: twoTabs.tabs.map((t) => t.targetId),
    identityOne,
    identityTwo,
    limitation:
      "Raw browser endpoint discovery exposes all profile targets to each worker; product resource isolation still requires authoritative target routing.",
  });
}
async function createPage(entry, context) {
  const { targetId } = await entry.cdp.request("Target.createTarget", {
    url: "about:blank",
    ...(context ? { browserContextId: context } : {}),
  });
  const { sessionId } = await entry.cdp.request("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await entry.cdp.request("Page.enable", {}, sessionId);
  await entry.cdp.request("Page.navigate", { url }, sessionId);
  const target = { entry, targetId, sessionId };
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(target, 'typeof readState === "function"'))
        return target;
    } catch {}
    await delay(25);
  }
  throw new Error("Fixture document did not load");
}
async function evaluate(target, expression) {
  const value = await target.entry.cdp.request(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    target.sessionId,
  );
  if (value.exceptionDetails)
    throw new Error(JSON.stringify(value.exceptionDetails));
  return value.result.value;
}
function assertOwner(state, expected) {
  assert.equal(state.local, expected);
  assert.equal(state.indexed, expected);
  assert.equal(state.cache, expected);
  assert.ok(
    state.cookie.includes(`persistent=${encodeURIComponent(expected)}`),
  );
  assert.equal(state.workers.length, 1);
}
function assertEmpty(state) {
  assert.equal(state.local, null);
  assert.equal(state.indexed, null);
  assert.equal(state.cache, null);
  assert.equal(state.session, null);
  assert.equal(state.cookie, "");
  assert.deepEqual(state.workers, []);
}
try {
  const a = await launch("profile-a", "A first launch");
  const b = await launch("profile-b", "B first launch");
  const a1 = await createPage(a);
  const a2 = await createPage(a);
  const b1 = await createPage(b);
  const first = await evaluate(a1, `writeState('작업 A')`);
  assertOwner(first, "작업 A");
  const shared = await evaluate(a2, "readState()");
  assertOwner(shared, "작업 A");
  assert.equal(shared.session, null);
  assert.notEqual(shared.instance, first.instance);
  const separate = await evaluate(b1, "readState()");
  assertEmpty(separate);
  await evaluate(b1, `writeState('작업 B')`);
  assertOwner(await evaluate(a1, "readState()"), "작업 A");
  evidence.checks.push(
    {
      name: "same-profile tabs share persistent storage and isolate sessionStorage",
      first,
      shared,
    },
    {
      name: "different profile on identical URL is empty before its own writes",
      separate,
    },
  );
  await proveNativeSharing(a, a1, a2);
  const { browserContextId: context } = await a.cdp.request(
    "Target.createBrowserContext",
    { disposeOnDetach: false },
  );
  const incognito = await createPage(a, context);
  assertEmpty(await evaluate(incognito, "readState()"));
  assertOwner(
    await evaluate(incognito, `writeState('임시 컨텍스트')`),
    "임시 컨텍스트",
  );
  assertOwner(await evaluate(a1, "readState()"), "작업 A");
  await a.cdp.request("Target.disposeBrowserContext", {
    browserContextId: context,
  });
  const { browserContextId: newContext } = await a.cdp.request(
    "Target.createBrowserContext",
    { disposeOnDetach: false },
  );
  const cleared = await evaluate(
    await createPage(a, newContext),
    "readState()",
  );
  assertEmpty(cleared);
  evidence.checks.push({
    name: "disposing a CDP context removes its storage without affecting the persistent profile",
    context,
    newContext,
    cleared,
  });
  const duplicateCwd = await mkdtemp(join(root, "duplicate-"));
  const duplicate = launchChild(
    join(root, "profile-a"),
    duplicateCwd,
    "A concurrent duplicate",
  );
  const duplicateExit = await bounded(
    duplicate.exit,
    12000,
    "Concurrent duplicate profile unexpectedly stayed live",
  );
  assert.notEqual(duplicateExit.code, 0);
  assert.equal(duplicateExit.signal, null);
  assertOwner(await evaluate(a1, "readState()"), "작업 A");
  evidence.checks.push({
    name: "concurrent process cannot acquire an already live profile",
    exit: duplicateExit,
    stderr: duplicate.stderr,
  });
  await close(a);
  const restarted = await launch("profile-a", "A restart");
  const recovered = await evaluate(await createPage(restarted), "readState()");
  assertOwner(recovered, "작업 A");
  assert.equal(recovered.session, null);
  assert.notEqual(recovered.instance, first.instance);
  assertOwner(await evaluate(b1, "readState()"), "작업 B");
  const contexts = await restarted.cdp.request("Target.getBrowserContexts");
  assert.deepEqual(contexts.browserContextIds, []);
  evidence.checks.push({
    name: "browser restart retains cookies localStorage IndexedDB CacheStorage and service-worker registration",
    recovered,
    contexts,
  });
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  for (const entry of [...owned].reverse()) {
    try {
      if (!evidence.cleanup.some((x) => x.pid === entry.child.pid))
        await close(entry);
    } catch (error) {
      evidence.cleanup.push({
        pid: entry.child.pid,
        confirmed: false,
        error: String(error),
      });
      evidence.status = "failed";
      process.exitCode = 1;
    }
  }
  for (const socket of sockets) socket.close();
  const unexpectedExits = evidence.processes.filter(
    (entry) =>
      entry.label !== "A concurrent duplicate" &&
      (entry.exit?.code !== 0 || entry.exit?.signal !== null),
  );
  if (unexpectedExits.length > 0) {
    evidence.status = "failed";
    evidence.unexpectedExits = unexpectedExits;
    process.exitCode = 1;
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  evidence.serverClosed = !server.listening;
  evidence.finishedAt = new Date().toISOString();
  const receipt = join(root, "receipt.json");
  await writeFile(receipt, JSON.stringify(evidence, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      {
        status: evidence.status,
        root,
        receipt,
        checks: evidence.checks.map((x) => x.name),
        cleanup: evidence.cleanup,
        error: evidence.error,
      },
      null,
      2,
    ),
  );
}
