import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { requestAppControl } from "../../cli/lib/app-control-client.mjs";

const DESCRIPTOR_TIMEOUT_MS = 180_000;
const AGENT_IDENTITY_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const stateRoot = process.env.HEBBIAN_QA_STATE_ROOT;
const qaHome = process.env.HOME;
const discoveryRoot = process.env.HMUX_DISCOVERY_ROOT;
const providerBin = process.env.HEBBIAN_QA_PROVIDER_BIN;
const hmuxCli = process.env.DURE_QA_HMUX_CLI;
if (!stateRoot || !qaHome || !discoveryRoot || !providerBin || !hmuxCli) {
  throw new Error("isolated app-control environment is incomplete");
}
if (path.resolve(qaHome) !== path.join(path.resolve(stateRoot), "home")) {
  throw new Error("QA HOME escaped the isolated state root");
}
if (
  path.resolve(discoveryRoot) !==
  path.join(path.resolve(stateRoot), "hmux-discovery")
) {
  throw new Error("Hmux discovery escaped the isolated state root");
}
fs.accessSync(hmuxCli, fs.constants.X_OK);
for (const provider of ["claude", "codex"]) {
  fs.accessSync(path.join(providerBin, provider), fs.constants.X_OK);
}

const rootPid = process.env.HEBBIAN_QA_ROOT_PID;
if (!rootPid || !/^[1-9][0-9]*$/u.test(rootPid)) {
  throw new Error("QA root process identity is missing");
}
const rootProcess = execFileSync(
  "ps",
  ["eww", "-p", rootPid, "-o", "command="],
  { encoding: "utf8" },
);
if (
  !rootProcess.includes(`HOME=${qaHome}`) ||
  !rootProcess.includes(`HMUX_DISCOVERY_ROOT=${discoveryRoot}`) ||
  !rootProcess.includes(`HEBBIAN_QA_PROVIDER_BIN=${providerBin}`)
) {
  throw new Error(
    "debug app process did not inherit the isolated roots and fake-provider path",
  );
}

const descriptorPath = path.join(qaHome, ".hebbian", "server.json");
const deadline = Date.now() + DESCRIPTOR_TIMEOUT_MS;
let connected = false;
let lastError;
let descriptor;
while (Date.now() < deadline && !connected) {
  try {
    if (!fs.existsSync(descriptorPath)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const descriptorMode = fs.statSync(descriptorPath).mode & 0o777;
    if ((descriptorMode & 0o077) !== 0) {
      throw new Error("server descriptor is not owner-only");
    }
    descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    if (
      !Number.isInteger(descriptor.port) ||
      typeof descriptor.token !== "string" ||
      descriptor.token.length === 0
    ) {
      throw new Error("invalid isolated server descriptor");
    }
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/ping`, {
      headers: { Authorization: `Bearer ${descriptor.token}` },
    });
    if (response.ok) {
      connected = true;
      break;
    }
    lastError = new Error(`authorized ping returned ${response.status}`);
  } catch (error) {
    lastError = error;
  }
  await sleep(POLL_INTERVAL_MS);
}
if (!connected) {
  throw new Error(
    `timed out waiting for isolated app control plane: ${lastError?.message ?? "descriptor absent"}`,
  );
}

async function waitForFrontend() {
  const frontendDeadline = Date.now() + 30_000;
  let frontendError;
  while (Date.now() < frontendDeadline) {
    try {
      await requestAppControl({
        descriptor,
        path: "/diagnostics",
        timeoutMs: 2_000,
      });
      return;
    } catch (error) {
      frontendError = error;
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `timed out waiting for the frontend control listener: ${frontendError?.message ?? "unknown error"}`,
  );
}

await waitForFrontend();

const hmuxJson = (args) =>
  JSON.parse(
    execFileSync(hmuxCli, ["--json", "--discovery-root", discoveryRoot, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    }),
  );

async function waitForAgentIdentity(sessionId, workspaceId, provider) {
  const identityDeadline = Date.now() + AGENT_IDENTITY_TIMEOUT_MS;
  let lastIdentity;
  while (Date.now() < identityDeadline) {
    const snapshot = hmuxJson([
      "session",
      "snapshot",
      sessionId,
      "--workspace",
      workspaceId,
    ]);
    lastIdentity = snapshot.agentIdentity;
    if (lastIdentity?.agent === provider) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Host did not recognize ${provider} in ${sessionId}; last identity: ${JSON.stringify(lastIdentity)}`,
  );
}

async function verifyTerminalLaunch(provider) {
  const created = await requestAppControl({
    descriptor,
    path: "/hmux/create",
    body: {
      cwd: process.cwd(),
    },
  });
  const { panelId, sessionId, workspaceId } = created.pane ?? {};
  if (
    typeof sessionId !== "string" ||
    typeof workspaceId !== "string" ||
    typeof panelId !== "string" ||
    !/^pane-[A-Za-z0-9_-]+$/.test(panelId)
  ) {
    throw new Error(`hmux.create returned an invalid pane: ${JSON.stringify(created.pane)}`);
  }
  hmuxJson([
    "command-input",
    "--target",
    sessionId,
    "--workspace",
    workspaceId,
    "--text",
    provider,
    "--submit",
  ]);
  await waitForAgentIdentity(sessionId, workspaceId, provider);
}

for (const provider of ["claude", "codex"]) {
  await verifyTerminalLaunch(provider);
}

console.log("app E2E smoke: terminal-launched Claude and Codex were recognized in place");
