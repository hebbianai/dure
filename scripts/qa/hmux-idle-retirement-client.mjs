import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const cli = required("HEBBIAN_QA_HMUX_CLI");
const runtime = required("HEBBIAN_QA_HMUX_RUNTIME");
const discoveryRoot = required("HMUX_DISCOVERY_ROOT");
const project = required("HEBBIAN_QA_PROJECT");
const serverPath = path.join(required("HOME"), ".hebbian", "server.json");

function externalHmuxClientEnvironment() {
  const environment = {
    ...process.env,
    HEBBIAN_HMUX_RUNTIME: runtime,
  };
  for (const name of [
    "HMUX",
    "HMUX_SESSION_ID",
    "HMUX_SESSION_NAME",
    "HMUX_WORKSPACE_ID",
    "HMUX_RUNNER_PRINCIPAL",
    "HMUX_RUNNER_INSTANCE",
    "HMUX_CHANNEL_EPOCH",
    "HMUX_HOST_INSTANCE_ID",
    "HMUX_TERMINAL_EPOCH",
  ]) {
    delete environment[name];
  }
  return environment;
}

function runHmux(args, { allowFailure = false } = {}) {
  const result = spawnSync(
    cli,
    ["--discovery-root", discoveryRoot, ...args],
    {
      cwd: project,
      encoding: "utf8",
      timeout: 30_000,
      env: externalHmuxClientEnvironment(),
    },
  );
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `hmux ${args.join(" ")} failed (${result.status}): ${
        result.stderr || result.stdout
      }`,
    );
  }
  return result;
}

function exactProcessIdentity(value, label) {
  const processId = value?.process_id;
  const startMarker = value?.start_marker;
  if (
    !Number.isInteger(processId) ||
    processId <= 1 ||
    typeof startMarker !== "string" ||
    !startMarker
  ) {
    throw new Error(`${label} omitted its exact process generation`);
  }
  return { process_id: processId, start_marker: startMarker };
}

function processGenerationStatus(identity) {
  const result = runHmux([
    "--json",
    "process",
    "probe",
    String(identity.process_id),
    identity.start_marker,
  ]);
  const value = JSON.parse(result.stdout);
  if (
    value.process?.process_id !== identity.process_id ||
    value.process?.start_marker !== identity.start_marker ||
    !["live", "absent"].includes(value.status)
  ) {
    throw new Error(
      `process probe returned the wrong generation: ${result.stdout}`,
    );
  }
  return value.status;
}

function listedSessions() {
  const result = runHmux([
    "--json",
    "session",
    "list",
    "--no-probe",
  ]);
  const sessions = JSON.parse(result.stdout);
  if (!Array.isArray(sessions)) {
    throw new Error("session list did not return a JSON array");
  }
  return sessions;
}

function exactSessionIsAbsent(sessionId, workspaceId) {
  return !listedSessions().some(
    (session) =>
      session.session_id === sessionId &&
      session.workspace_id === workspaceId,
  );
}

function assertAttachedPane(pane, expected) {
  if (
    pane?.desktopId !== expected.desktopId ||
    pane?.panelId !== expected.panelId ||
    pane?.sessionId !== expected.sessionId ||
    pane?.workspaceId !== expected.workspaceId ||
    pane?.attachment?.state !== "attached" ||
    pane?.attachment?.sessionId !== expected.sessionId ||
    pane?.attachment?.workspaceId !== expected.workspaceId ||
    pane?.attachment?.ownerId !==
      `window:main:desktop:${expected.desktopId}:pane:${expected.panelId}` ||
    (!pane?.attachment?.observerAttached &&
      !pane?.attachment?.controllerAttached)
  ) {
    throw new Error(
      `pane did not acknowledge its exact native attachment: ${JSON.stringify(pane)}`,
    );
  }
}

function assertCloseReceipt(response, expected) {
  if (
    response.closed?.panelId !== expected.panelId ||
    response.closed?.desktopId !== expected.desktopId ||
    response.closed?.departure?.state !== expected.state ||
    response.closed?.departure?.reason !== expected.reason
  ) {
    throw new Error(
      `pane close returned the wrong retirement receipt: ${JSON.stringify(response)}`,
    );
  }
}

async function stopExactChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (timeoutMs) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("error", onError);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const onError = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
      child.once("error", onError);
      if (child.exitCode !== null || child.signalCode !== null) finish(true);
    });

  child.kill("SIGTERM");
  if (await waitForExit(5_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(5_000))) {
    throw new Error(`exact QA child ${child.pid ?? "unknown"} survived SIGKILL`);
  }
}

async function waitFor(description, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for ${description}${
      lastError ? `: ${String(lastError)}` : ""
    }`,
  );
}

async function postResponse(route, payload) {
  const server = JSON.parse(readFileSync(serverPath, "utf8"));
  const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

async function post(route, payload) {
  const response = await postResponse(route, payload);
  if (!response.ok || !response.body?.ok) {
    throw new Error(
      `${route} failed (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

async function closePanelAfterMount(panelId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await postResponse("/pane/close", {
      targetPanelId: panelId,
      confirm: true,
    });
    if (response.ok && response.body?.ok) return response.body;
    if (
      response.status !== 409 ||
      response.body?.error?.code !== "pane_not_found"
    ) {
      throw new Error(
        `/pane/close failed (${response.status}): ${JSON.stringify(response.body)}`,
      );
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for pane ${panelId} to mount`);
}

async function closeAutomaticDesktopTerminals(targetSessionId) {
  // First-run/onboarding desktops intentionally may not create a default
  // terminal, and a desktop whose explicit Hmux pane wins the mount race must
  // not add one later. Retire any defaults that did appear, but keep the smoke
  // authoritative on the two explicitly created/attached target panes below.
  await sleep(1_000);
  const sessions = listedSessions().filter(
    (session) =>
      session.session_id !== targetSessionId &&
      session.session_class === "standalone" &&
      session.lifecycle === "ready",
  );

  const retired = [];
  for (const session of sessions) {
    if (
      session.retirement_policy?.kind !==
        "after_graceful_last_client_departure_v1" ||
      session.retirement_policy?.grace_period_ms !== "2000"
    ) {
      throw new Error(
        `automatic terminal omitted its retirement contract: ${JSON.stringify(session)}`,
      );
    }
    const hostProcess = exactProcessIdentity(
      session.host_process,
      "automatic terminal Host",
    );
    const providerProcess = exactProcessIdentity(
      session.provider_process,
      "automatic terminal provider",
    );
    const panelId = `term:${session.session_id}`;
    const closed = await closePanelAfterMount(panelId);
    const desktopId = closed.closed?.desktopId;
    if (typeof desktopId !== "string" || !desktopId) {
      throw new Error(
        `automatic terminal close omitted its desktop: ${JSON.stringify(closed)}`,
      );
    }
    assertCloseReceipt(closed, {
      desktopId,
      panelId,
      state: "retirement_armed",
      reason: undefined,
    });
    await waitFor(`automatic terminal ${session.session_id} retirement`, () => {
      return (
        exactSessionIsAbsent(session.session_id, session.workspace_id) &&
        processGenerationStatus(hostProcess) === "absent" &&
        processGenerationStatus(providerProcess) === "absent"
      );
    }, 30_000);
    retired.push(session.session_id);
  }
  return retired;
}

let cliAttach;
try {
  await waitFor("isolated app server", () => existsSync(serverPath), 180_000);
  // server.json is published by the native process before React has installed
  // the cli:request listener. Prove the same frontend bridge that will claim
  // pane mutations is live before issuing the non-replayable create request.
  await waitFor(
    "frontend CLI bridge",
    async () => {
      await post("/diagnostics", {});
      return true;
    },
    180_000,
  );
  const created = await post("/hmux/create", { cwd: project });
  const { desktopId: firstDesktopId, panelId, sessionId, workspaceId } =
    created.pane;
  if (!firstDesktopId || !panelId || !sessionId || !workspaceId) {
    throw new Error(`hmux create returned an incomplete pane: ${JSON.stringify(created)}`);
  }
  assertAttachedPane(created.pane, {
    desktopId: firstDesktopId,
    panelId,
    sessionId,
    workspaceId,
  });

  const inspection = await waitFor("healthy retirement-enabled session", () => {
    const result = runHmux(
      ["--json", "session", "show", sessionId, "--workspace", workspaceId],
      { allowFailure: true },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    const value = JSON.parse(result.stdout);
    if (
      value.health !== "healthy" ||
      value.retirement_policy?.kind !==
        "after_graceful_last_client_departure_v1" ||
      value.retirement_policy?.grace_period_ms !== "2000"
    ) {
      throw new Error(`unexpected session inspection: ${result.stdout}`);
    }
    return value;
  });

  const hostProcess = exactProcessIdentity(
    inspection.host_process,
    "session Host",
  );
  const providerProcess = exactProcessIdentity(
    inspection.provider_process,
    "session provider",
  );

  const desktop = await post("/desktop/create", {
    name: "Idle retirement sibling",
  });
  const secondDesktopId = desktop.desktop?.desktopId;
  if (!secondDesktopId || desktop.desktop?.mounted !== true) {
    throw new Error(
      `desktop create did not return a mounted desktop: ${JSON.stringify(desktop)}`,
    );
  }
  const second = await post("/hmux/attach", {
    sessionId,
    workspaceId,
    cwd: project,
    desktopId: secondDesktopId,
  });
  assertAttachedPane(second.pane, {
    desktopId: secondDesktopId,
    panelId,
    sessionId,
    workspaceId,
  });
  // Close any default terminals that raced with the explicit target panes and
  // prove their opt-in policies too. Zero defaults is valid on first run.
  const automaticSessions = await closeAutomaticDesktopTerminals(sessionId);

  let siblingOutput = "";
  let siblingError = "";
  cliAttach = spawn(
    cli,
    [
      "--discovery-root",
      discoveryRoot,
      "attach",
      "--read-only",
      sessionId,
    ],
    {
      cwd: project,
      env: externalHmuxClientEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  cliAttach.stdout.setEncoding("utf8");
  cliAttach.stderr.setEncoding("utf8");
  cliAttach.stdout.on("data", (chunk) => {
    siblingOutput += chunk;
  });
  cliAttach.stderr.on("data", (chunk) => {
    siblingError += chunk;
  });
  await waitFor("sibling CLI attachment", () => {
    if (cliAttach.exitCode !== null) {
      throw new Error(
        `sibling attach exited early (${cliAttach.exitCode}): ${siblingError}`,
      );
    }
    return siblingOutput.length > 0;
  }, 15_000);

  const firstClose = await post("/pane/close", {
    targetPanelId: panelId,
    desktopId: firstDesktopId,
    confirm: true,
  });
  assertCloseReceipt(firstClose, {
    desktopId: firstDesktopId,
    panelId,
    state: "session_preserved",
    reason: "other_clients_attached",
  });

  await sleep(3_000);
  const preserved = runHmux(
    ["--json", "session", "show", sessionId, "--workspace", workspaceId],
    { allowFailure: true },
  );
  if (
    preserved.status !== 0 ||
    processGenerationStatus(hostProcess) !== "live" ||
    processGenerationStatus(providerProcess) !== "live" ||
    cliAttach.exitCode !== null
  ) {
    throw new Error(
      `first pane close did not preserve the sibling attachment: ${
        preserved.stderr || preserved.stdout
      }`,
    );
  }

  const secondClose = await post("/pane/close", {
    targetPanelId: panelId,
    desktopId: secondDesktopId,
    confirm: true,
  });
  assertCloseReceipt(secondClose, {
    desktopId: secondDesktopId,
    panelId,
    state: "session_preserved",
    reason: "other_clients_attached",
  });

  // A read-only observer has no stdin loop. Terminating this exact child drops
  // its transport without sending the typed graceful-departure action.
  cliAttach.kill("SIGTERM");
  const [cliExitCode, cliExitSignal] = await Promise.race([
    once(cliAttach, "exit"),
    sleep(10_000).then(() => {
      throw new Error("sibling CLI attachment did not exit after SIGTERM");
    }),
  ]);
  if (cliExitCode !== null || cliExitSignal !== "SIGTERM") {
    throw new Error(
      `sibling CLI SIGTERM exited unexpectedly: code=${cliExitCode} signal=${cliExitSignal}`,
    );
  }
  cliAttach = undefined;
  await sleep(3_000);
  if (
    processGenerationStatus(hostProcess) !== "live" ||
    processGenerationStatus(providerProcess) !== "live" ||
    exactSessionIsAbsent(sessionId, workspaceId)
  ) {
    throw new Error("transport drop unexpectedly retired the session");
  }

  const reattached = await post("/hmux/attach", {
    sessionId,
    workspaceId,
    cwd: project,
    desktopId: secondDesktopId,
  });
  const lastPanelId = reattached.pane?.panelId;
  if (
    !lastPanelId ||
    reattached.pane?.sessionId !== sessionId ||
    reattached.pane?.workspaceId !== workspaceId
  ) {
    throw new Error(
      `exact pane reattach returned an incomplete identity: ${JSON.stringify(reattached)}`,
    );
  }
  assertAttachedPane(reattached.pane, {
    desktopId: secondDesktopId,
    panelId: lastPanelId,
    sessionId,
    workspaceId,
  });

  const lastClose = await post("/pane/close", {
    targetPanelId: lastPanelId,
    desktopId: secondDesktopId,
    confirm: true,
  });
  assertCloseReceipt(lastClose, {
    desktopId: secondDesktopId,
    panelId: lastPanelId,
    state: "retirement_armed",
    reason: undefined,
  });

  await waitFor("retired pane Host and provider", () => {
    return (
      exactSessionIsAbsent(sessionId, workspaceId) &&
      processGenerationStatus(hostProcess) === "absent" &&
      processGenerationStatus(providerProcess) === "absent"
    );
  }, 30_000);

  console.log(
    `hmux idle retirement smoke: automatic panes ${automaticSessions.join(",")} retired; two target panes preserved their exact closes while CLI was attached; transport drop preserved; last target pane ${lastPanelId} retired Host ${hostProcess.process_id} and provider ${providerProcess.process_id}`,
  );
} finally {
  await stopExactChild(cliAttach);
}
