import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ORCHESTRATION_API_VERSION,
  ORCHESTRATION_CLIENT_CAPABILITIES,
  orchestrationIntegrationInstallRootRef,
} from "./orchestration-client.mjs";
import {
  loadBundledOrchestrationPayload,
  immutableOrchestrationIdleWorker,
  ORCHESTRATION_PAYLOAD_NAMES,
  readDureCliIdentity,
} from "./orchestration-integration-bundle.mjs";
export {
  orchestrationPayloadIdentity,
  validateOrchestrationPayloadIdentity,
} from "./orchestration-integration-bundle.mjs";

const PROVIDERS = Object.freeze({
  claude: {
    directory: ".claude",
    skillDirectory: ["skills", "dure-orchestration"],
    nativeConfig: "claude-json",
    hookFile: "settings.json",
    hookMatcher: "",
  },
  codex: {
    directory: ".codex",
    skillDirectory: ["skills", "dure-orchestration"],
    nativeConfig: "codex-toml",
    hookFile: "hooks.json",
    hookMatcher: "startup|resume|clear",
  },
});
export const ORCHESTRATION_INTEGRATION_PROVIDERS = Object.freeze(Object.keys(PROVIDERS));
const RECEIPT = "install-receipt.json";
const MCP_NAME = "dure-orchestration";
const CODEX_BLOCK_BEGIN = "# BEGIN DURE ORCHESTRATION MCP";
const CODEX_BLOCK_END = "# END DURE ORCHESTRATION MCP";
// The desktop app's Claude shared-state sync replace-writes the global Claude
// config while it holds this flock (lock_profile in
// crates/dure-app/provider-profile). The installer takes the same lock around
// its own read-modify-write of that file, so neither writer can put back a
// copy it read before the other one wrote.
const CLAUDE_SHARED_STATE_LOCK = ["accounts", ".overlay-locks", "claude-shared-state-v1.lock"];
const CLAUDE_SHARED_STATE_LOCK_TIMEOUT_MS = 15_000;
const DARWIN_O_EXLOCK = 0x20;
const LOCK_POLL = new Int32Array(new SharedArrayBuffer(4));
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PUBLIC_RECEIPT_KEYS = new Set([
  "provider",
  "status",
  "scope",
  "installRoot",
  "installRootRef",
  "skillRoot",
  "nativeConfigPath",
  "lifecycleHookPath",
  "version",
  "cliDigest",
  "digest",
  "apiVersion",
  "channel",
  "transportRef",
  "capabilities",
  "globalConfigurationApproved",
]);

function selectedProviders(provider) {
  if (provider === undefined) return Object.entries(PROVIDERS);
  if (!Object.hasOwn(PROVIDERS, provider)) throw new Error(`unsupported provider: ${provider}`);
  return [[provider, PROVIDERS[provider]]];
}

function targetFor({ provider, adapter, homeDirectory, global, installRoot, workspaceRoot }) {
  const workspace = path.resolve(workspaceRoot ?? process.cwd());
  const providerRoot = global
    ? path.join(homeDirectory, adapter.directory)
    : path.join(workspace, adapter.directory);
  const sharedStage = installRoot !== undefined;
  const payloadRoot = sharedStage
    ? path.join(installRoot, "payloads", provider)
    : path.join(providerRoot, "dure", "orchestration");
  const stagedProviderRoot = sharedStage ? path.join(installRoot, "provider", provider) : providerRoot;
  return {
    adapter,
    provider,
    providerRoot,
    installRoot: payloadRoot,
    skillRoot: installRoot
      ? path.join(stagedProviderRoot, "skills", "dure-orchestration")
      : path.join(providerRoot, ...adapter.skillDirectory),
    nativeConfigPath: installRoot
      ? path.join(stagedProviderRoot, "mcp-servers.json")
      : adapter.nativeConfig === "claude-json"
        ? global
          ? path.join(homeDirectory, ".claude.json")
          : path.join(workspace, ".mcp.json")
        : path.join(providerRoot, "config.toml"),
    hookPath: path.join(stagedProviderRoot, installRoot ? "lifecycle-hooks.json" : adapter.hookFile),
    staged: sharedStage,
  };
}

/** Install receipts that can configure `provider` for a shell in
 * `workspaceRoot`: the workspace-scoped install first, then the global one. */
export function orchestrationIntegrationReceiptPaths({ provider, homeDirectory, workspaceRoot }) {
  if (provider === undefined) throw new Error("provider is required");
  const [[name, adapter]] = selectedProviders(provider);
  return [false, true].map((global) =>
    path.join(
      targetFor({ provider: name, adapter, homeDirectory, global, workspaceRoot }).installRoot,
      RECEIPT,
    ));
}

function readReceipt(target, expected, payload) {
  const receiptPath = path.join(target.installRoot, RECEIPT);
  if (!fs.existsSync(receiptPath)) {
    return publicStatus(target, {
      status: "missing",
      version: null,
      digest: null,
      transportRef: null,
      capabilities: [],
    });
  }
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    const sharedDevelopmentGlobal =
      expected.scope === "global" && expected.channel !== "stable";
    const checks = {
      schema: receipt.schemaVersion === 1,
      provider: receipt.provider === target.provider,
      installRoot: receipt.installRoot === fs.realpathSync(target.installRoot),
      version: sharedDevelopmentGlobal || receipt.version === expected.version,
      cliDigest: sharedDevelopmentGlobal || receipt.cliDigest === expected.cliDigest,
      digest:
        SHA256.test(receipt.digest) &&
        (sharedDevelopmentGlobal || receipt.digest === expected.digest),
      apiVersion: receipt.apiVersion === ORCHESTRATION_API_VERSION,
      channel: sharedDevelopmentGlobal || receipt.channel === expected.channel,
      transport:
        expected.transportRef === undefined ||
        receipt.transportRef === expected.transportRef,
      scope: receipt.scope === expected.scope,
      approval:
        receipt.globalConfigurationApproved ===
        expected.globalConfigurationApproved,
      capabilities: isDeepStrictEqual(
        receipt.capabilities,
        ORCHESTRATION_CLIENT_CAPABILITIES,
      ),
      idleWorker:
        !expected.mcpIdleWorkerAvailable || receipt.mcpIdleWorker?.schemaVersion === 1,
      payload:
        payloadDigest(target.installRoot) ===
        (sharedDevelopmentGlobal ? receipt.digest : expected.digest),
      skill:
        fs.existsSync(path.join(target.skillRoot, "SKILL.md")) &&
        fs.readFileSync(path.join(target.skillRoot, "SKILL.md")).equals(
          fs.readFileSync(
            payload.files.find(([name]) => name === "SKILL.md")[1],
          ),
        ),
      providerAdapter: providerAdapterCurrent(target, receipt),
    };
    const current = Object.values(checks).every(Boolean);
    return publicStatus(target, { ...receipt, status: current ? "current" : "outdated" });
  } catch {
    return publicStatus(target, {
      status: "invalid",
      version: null,
      digest: null,
      transportRef: null,
      capabilities: [],
    });
  }
}

function publicStatus(target, receipt) {
  const installRootRef = orchestrationIntegrationInstallRootRef(
    target.provider,
    receipt.digest,
  );
  const status = {
    provider: target.provider,
    status: receipt.status,
    scope: receipt.scope ?? null,
    installRoot: receipt.installRoot ?? target.installRoot,
    installRootRef,
    skillRoot: receipt.skillRoot ?? target.skillRoot,
    nativeConfigPath: receipt.nativeConfigPath ?? target.nativeConfigPath,
    lifecycleHookPath: receipt.lifecycleHookPath ?? target.hookPath,
    version: receipt.version ?? null,
    cliDigest: receipt.cliDigest ?? null,
    digest: receipt.digest ?? null,
    apiVersion: receipt.apiVersion ?? ORCHESTRATION_API_VERSION,
    channel: receipt.channel ?? null,
    transportRef: receipt.transportRef ?? null,
    capabilities: receipt.capabilities ?? [],
    globalConfigurationApproved: receipt.globalConfigurationApproved ?? false,
  };
  if (!isOrchestrationIntegrationReceipt(status)) {
    throw new Error("orchestration integration receipt is invalid");
  }
  return status;
}

export function isOrchestrationIntegrationReceipt(receipt) {
  return (
    receipt !== null &&
    typeof receipt === "object" &&
    !Array.isArray(receipt) &&
    Object.keys(receipt).length === PUBLIC_RECEIPT_KEYS.size &&
    Object.keys(receipt).every((key) => PUBLIC_RECEIPT_KEYS.has(key)) &&
    new Set(["codex", "claude"]).has(receipt.provider) &&
    new Set(["current", "outdated", "missing", "invalid", "removed"]).has(
      receipt.status,
    ) &&
    (receipt.scope === null || receipt.scope === "global" || receipt.scope === "workspace") &&
    [
      receipt.installRoot,
      receipt.skillRoot,
      receipt.nativeConfigPath,
      receipt.lifecycleHookPath,
    ].every(
      (value) =>
        typeof value === "string" &&
        value.length <= 4_096 &&
        !/[\u0000-\u001f\u007f]/u.test(value) &&
        path.isAbsolute(value),
    ) &&
    receipt.installRootRef ===
      orchestrationIntegrationInstallRootRef(
        receipt.provider,
        receipt.digest,
      ) &&
    (receipt.version === null ||
      (typeof receipt.version === "string" &&
        SAFE_REFERENCE.test(receipt.version))) &&
    (receipt.cliDigest === null || SHA256.test(receipt.cliDigest)) &&
    (receipt.digest === null || SHA256.test(receipt.digest)) &&
    receipt.apiVersion === ORCHESTRATION_API_VERSION &&
    (receipt.channel === null ||
      (typeof receipt.channel === "string" &&
        SAFE_REFERENCE.test(receipt.channel))) &&
    (receipt.transportRef === null ||
      (typeof receipt.transportRef === "string" &&
        SAFE_REFERENCE.test(receipt.transportRef))) &&
    Array.isArray(receipt.capabilities) &&
    receipt.capabilities.length <= 64 &&
    receipt.capabilities.every(
      (capability) =>
        typeof capability === "string" &&
        SAFE_REFERENCE.test(capability),
    ) &&
    new Set(receipt.capabilities).size === receipt.capabilities.length &&
    typeof receipt.globalConfigurationApproved === "boolean"
  );
}

function payloadDigest(root) {
  const digest = crypto.createHash("sha256");
  for (const name of ORCHESTRATION_PAYLOAD_NAMES) {
    let content;
    try {
      content = fs.readFileSync(path.join(root, name));
    } catch (error) {
      // An intact older bundle may predate an added module. Its receipt still
      // binds the exact retained names and bytes; losing a file that was in
      // that receipt changes the digest and cannot authorize an auto-refresh.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    digest.update(`${name}\0`);
    digest.update(content);
    digest.update("\0");
  }
  return digest.digest("hex");
}

export function inspectOrchestrationIntegrations(options) {
  const payload = loadBundledOrchestrationPayload(options.cliScriptPath);
  const identity = readDureCliIdentity(options.cliScriptPath);
  return selectedProviders(options.provider).map(([provider, adapter]) => {
    const target = targetFor({ ...options, provider, adapter });
    return readReceipt(
      target,
      {
        ...identity,
        channel: options.channel,
        digest: payload.digest,
        transportRef: options.transportRef,
        scope: options.global ? "global" : "workspace",
        globalConfigurationApproved: Boolean(options.global),
      },
      payload,
    );
  });
}

function previouslyApprovedRefreshIsSafe(target, expected, payload) {
  try {
    const receipt = readOwnedReceipt(target);
    if (
      !receipt ||
      receipt.scope !== "global" ||
      receipt.globalConfigurationApproved !== true ||
      receipt.channel !== expected.channel ||
      receipt.transportRef !== expected.transportRef ||
      receipt.apiVersion !== ORCHESTRATION_API_VERSION ||
      !isDeepStrictEqual(
        receipt.capabilities,
        ORCHESTRATION_CLIENT_CAPABILITIES,
      ) ||
      payloadDigest(target.installRoot) !== receipt.digest ||
      !providerAdapterCurrent(target, receipt, { acceptInstalledRelay: true })
    ) {
      return false;
    }
    publicStatus(target, { ...receipt, status: "outdated" });
    preflightSkill(target, payload, receipt);
    return true;
  } catch {
    return false;
  }
}

/** Providers whose existing global approval can authorize an exact refresh. */
export function approvedOrchestrationIntegrationRefreshProviders(options) {
  if (!options.global) return [];
  const payload = loadBundledOrchestrationPayload(options.cliScriptPath);
  const identity = readDureCliIdentity(options.cliScriptPath);
  return selectedProviders(options.provider).flatMap(([provider, adapter]) => {
    const target = targetFor({ ...options, provider, adapter });
    const expected = {
      ...identity,
      channel: options.channel,
      digest: payload.digest,
      transportRef: options.transportRef ?? "direct-outbound",
      scope: "global",
      globalConfigurationApproved: true,
    };
    return previouslyApprovedRefreshIsSafe(target, expected, payload)
      ? [provider]
      : [];
  });
}

export function mutateOrchestrationIntegrations(options) {
  if (options.global && !options.approval && options.action !== "refresh") {
    throw new Error("global provider configuration requires --approve-global-config");
  }
  const payload = loadBundledOrchestrationPayload(options.cliScriptPath);
  const identity = readDureCliIdentity(options.cliScriptPath);
  const providers = selectedProviders(options.provider);
  if (options.action === "refresh") {
    if (!options.global || options.provider === undefined) {
      throw new Error("approved integration refresh requires one global provider");
    }
    const approved = new Set(
      approvedOrchestrationIntegrationRefreshProviders(options),
    );
    if (!approved.has(options.provider)) {
      throw new Error(
        "previously approved integration is not safe to refresh automatically",
      );
    }
  }
  return providers.map(([provider, adapter]) => {
    const target = targetFor({ ...options, provider, adapter });
    if (options.action === "uninstall") {
      removeOwnedPayload(target, options);
      return publicStatus(target, {
        status: "removed",
        scope: options.global ? "global" : "workspace",
        version: identity.version,
        digest: payload.digest,
        channel: options.channel,
        transportRef: options.transportRef ?? null,
        capabilities: [],
        globalConfigurationApproved: Boolean(
          options.global && options.approval,
        ),
      });
    }
    if (
      options.action !== "install" &&
      options.action !== "update" &&
      options.action !== "refresh"
    ) {
      throw new Error(`unsupported integration action: ${options.action}`);
    }
    assertReference("channel", options.channel);
    if (options.transportRef !== undefined) assertReference("transportRef", options.transportRef);
    return installPayload(target, payload, identity, {
      ...options,
      approval: options.approval || options.action === "refresh",
    });
  });
}

export function runOrchestrationIntegrationAction(action, options) {
  if (action === "status") return inspectOrchestrationIntegrations(options);
  return mutateOrchestrationIntegrations({ ...options, action });
}

function installPayload(target, payload, identity, options) {
  assertSafeTarget(target.installRoot, target.providerRoot, options.installRoot !== undefined);
  fs.mkdirSync(path.dirname(target.installRoot), { recursive: true });
  const canonicalRoot = path.join(
    fs.realpathSync(path.dirname(target.installRoot)),
    path.basename(target.installRoot),
  );
  const canonicalTarget = {
    ...target,
    installRoot: canonicalRoot,
    skillRoot: path.resolve(target.skillRoot),
    nativeConfigPath: path.resolve(target.nativeConfigPath),
    hookPath: path.resolve(target.hookPath),
  };
  const previousReceipt = readOwnedReceipt(canonicalTarget);
  preflightSkill(canonicalTarget, payload, previousReceipt);

  const runtimeExecutable = fs.realpathSync(process.execPath);
  const lifecycleCommand = lifecycleHookCommand(
    lifecycleRuntimeExecutable(runtimeExecutable),
    path.join(canonicalRoot, "orchestration-lifecycle.mjs"),
  );
  const receipt = {
    schemaVersion: 1,
    provider: target.provider,
    scope: options.global ? "global" : "workspace",
    transportRef: options.transportRef ?? "direct-outbound",
    channel: options.channel,
    installRoot: canonicalRoot,
    skillRoot: canonicalTarget.skillRoot,
    nativeConfigPath: canonicalTarget.nativeConfigPath,
    lifecycleHookPath: canonicalTarget.hookPath,
    lifecycleCommand,
    runtimeExecutable,
    version: identity.version,
    cliDigest: identity.cliDigest,
    digest: payload.digest,
    apiVersion: ORCHESTRATION_API_VERSION,
    capabilities: ORCHESTRATION_CLIENT_CAPABILITIES,
    globalConfigurationApproved: Boolean(options.global && options.approval),
  };
  const mcpIdleWorker = immutableOrchestrationIdleWorker(options.cliScriptPath);
  if (mcpIdleWorker) receipt.mcpIdleWorker = mcpIdleWorker;
  const providerFiles = prepareProviderInstall(canonicalTarget, receipt, previousReceipt);
  const snapshots = snapshotFiles([
    canonicalTarget.hookPath,
    path.join(canonicalTarget.skillRoot, "SKILL.md"),
  ]);
  const stage = fs.mkdtempSync(path.join(path.dirname(canonicalRoot), ".dure-orchestration-stage-"));
  const backup = `${canonicalRoot}.previous-${process.pid}-${crypto.randomUUID()}`;
  let hadPreviousRoot = false;
  try {
    for (const [name, source] of payload.files) {
      const destination = path.join(stage, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    fs.writeFileSync(
      path.join(stage, "provider-adapter.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          provider: target.provider,
          mcp: path.join(canonicalRoot, "mcp.json"),
          lifecycle: path.join(canonicalRoot, "lifecycle.json"),
          client: path.join(canonicalRoot, "orchestration-client.mjs"),
          mcpServer: path.join(canonicalRoot, "orchestration-mcp-server.mjs"),
          nativeConfig: canonicalTarget.nativeConfigPath,
          lifecycleHook: canonicalTarget.hookPath,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(stage, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    });
    if (fs.existsSync(canonicalRoot)) {
      fs.renameSync(canonicalRoot, backup);
      hadPreviousRoot = true;
    }
    fs.renameSync(stage, canonicalRoot);
    writeFileAtomic(
      path.join(canonicalTarget.skillRoot, "SKILL.md"),
      fs.readFileSync(path.join(canonicalRoot, "SKILL.md")),
    );
    commitNativeConfig(
      canonicalTarget,
      options,
      () => prepareNativeConfig(canonicalTarget, receipt, previousReceipt),
      () => {
        writeFileAtomic(canonicalTarget.hookPath, providerFiles.hooks);
        if (hadPreviousRoot) fs.rmSync(backup, { recursive: true });
      },
    );
    return publicStatus(canonicalTarget, { ...receipt, status: "current" });
  } catch (error) {
    restoreFiles(snapshots);
    if (fs.existsSync(canonicalRoot)) fs.rmSync(canonicalRoot, { recursive: true });
    if (hadPreviousRoot && fs.existsSync(backup)) fs.renameSync(backup, canonicalRoot);
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true });
    throw error;
  }
}

function readOwnedReceipt(target) {
  if (!fs.existsSync(target.installRoot)) return null;
  if (fs.lstatSync(target.installRoot).isSymbolicLink()) {
    throw new Error(`refusing orchestration payload symlink: ${target.installRoot}`);
  }
  const canonicalRoot = fs.realpathSync(target.installRoot);
  const receiptPath = path.join(target.installRoot, RECEIPT);
  if (!fs.existsSync(receiptPath)) {
    if (fs.readdirSync(target.installRoot).length === 0) return null;
    throw new Error(`refusing to replace unowned integration root: ${target.installRoot}`);
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (
    receipt.schemaVersion !== 1 ||
    receipt.provider !== target.provider ||
    receipt.installRoot !== canonicalRoot
  ) {
    throw new Error(`refusing to replace unowned integration root: ${target.installRoot}`);
  }
  return receipt;
}

function preflightSkill(target, payload, previousReceipt) {
  const skillRoot = target.skillRoot;
  if (!fs.existsSync(skillRoot)) return;
  if (fs.lstatSync(skillRoot).isSymbolicLink()) {
    throw new Error(`refusing orchestration skill symlink: ${skillRoot}`);
  }
  const entries = fs.readdirSync(skillRoot);
  if (entries.some((entry) => entry !== "SKILL.md")) {
    throw new Error(`refusing to replace unowned orchestration skill: ${skillRoot}`);
  }
  const skillPath = path.join(skillRoot, "SKILL.md");
  if (!fs.existsSync(skillPath)) return;
  const installed = fs.readFileSync(skillPath);
  const bundled = fs.readFileSync(payload.files.find(([name]) => name === "SKILL.md")[1]);
  const previous = previousReceipt
    ? path.join(previousReceipt.installRoot, "SKILL.md")
    : null;
  if (
    !installed.equals(bundled) &&
    (!previous || !fs.existsSync(previous) || !installed.equals(fs.readFileSync(previous)))
  ) {
    throw new Error(`refusing to replace unowned orchestration skill: ${skillPath}`);
  }
}

function prepareProviderInstall(target, receipt, previousReceipt) {
  const nativeConfig = prepareNativeConfig(target, receipt, previousReceipt);
  if (target.staged) {
    return {
      nativeConfig,
      hooks: `${JSON.stringify(
        {
          schemaVersion: 1,
          hooks: {
            SessionStart: [
              {
                hooks: [{ type: "command", command: receipt.lifecycleCommand }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    };
  }
  return { nativeConfig, hooks: prepareLifecycleHook(target, receipt, previousReceipt) };
}

function prepareNativeConfig(target, receipt, previousReceipt) {
  if (target.staged) {
    return `${JSON.stringify(
      {
        schemaVersion: 1,
        servers: {
          [MCP_NAME]: claudeMcpEntry(receipt),
        },
      },
      null,
      2,
    )}\n`;
  }
  return target.adapter.nativeConfig === "claude-json"
    ? prepareClaudeMcp(target.nativeConfigPath, receipt, previousReceipt)
    : prepareCodexMcp(target.nativeConfigPath, receipt);
}

function prepareClaudeMcp(configPath, receipt, previousReceipt) {
  const settings = readJsonObject(configPath, "provider MCP config");
  settings.mcpServers = settings.mcpServers ?? {};
  if (typeof settings.mcpServers !== "object" || Array.isArray(settings.mcpServers)) {
    throw new Error(`provider MCP config is invalid: ${configPath}`);
  }
  const current = settings.mcpServers[MCP_NAME];
  const expected = claudeMcpEntry(receipt);
  const previous = previousReceipt ? claudeMcpEntry(previousReceipt) : null;
  if (
    current &&
    !mcpEntryMatches(current, expected) &&
    !(previous && mcpEntryMatches(current, previous)) &&
    !installedRelayOfOtherVersion(current, expected, receipt.provider)
  ) {
    throw new Error(`provider MCP name is already owned: ${configPath}`);
  }
  settings.mcpServers[MCP_NAME] = { ...(current ?? {}), ...expected };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

// Claude's shared-state sync can restore an older copy of this entry after an
// update has already moved the receipt on, so the entry matches neither
// receipt. It is still Dure's when it is this provider's relay from the same
// installed version tree as the expected relay, differing only by version.
function installedRelayOfOtherVersion(candidate, expected, provider) {
  const relay = relayEntryLayout(candidate);
  const current = relayEntryLayout(expected);
  return Boolean(
    relay &&
      current &&
      relay.provider === provider &&
      relay.versionsRoot === current.versionsRoot &&
      relay.binaryDirectory === current.binaryDirectory &&
      relay.command === current.command,
  );
}

function relayEntryLayout(entry) {
  if (entry?.type !== "stdio" || typeof entry.command !== "string" || !Array.isArray(entry.args)) {
    return null;
  }
  const [subcommand, nodeFlag, node, workerFlag, worker, catalogueFlag, catalogue, receiptFlag, receiptJson] =
    entry.args;
  if (
    entry.args.length !== 9 ||
    subcommand !== "mcp-stdio-relay" ||
    nodeFlag !== "--node" ||
    workerFlag !== "--worker" ||
    catalogueFlag !== "--catalogue" ||
    receiptFlag !== "--receipt-json" ||
    ![entry.command, node, worker, catalogue].every(
      (pathname) => typeof pathname === "string" && path.isAbsolute(pathname),
    )
  ) {
    return null;
  }
  // Mirrors the version-bound layout written by immutableOrchestrationIdleWorker.
  const binaryRoot = path.dirname(path.dirname(worker));
  if (
    worker !== path.join(binaryRoot, "lib", "orchestration-mcp-server.mjs") ||
    catalogue !== path.join(binaryRoot, "orchestration-mcp-catalogue.json")
  ) {
    return null;
  }
  const command = path.relative(binaryRoot, entry.command);
  if (command === "" || command.startsWith("..") || path.isAbsolute(command)) return null;
  let integrationReceipt;
  try {
    integrationReceipt = JSON.parse(receiptJson);
  } catch {
    return null;
  }
  if (integrationReceipt?.schemaVersion !== 1 || typeof integrationReceipt.version !== "string") {
    return null;
  }
  return {
    provider: integrationReceipt.provider,
    versionsRoot: path.dirname(path.dirname(binaryRoot)),
    binaryDirectory: path.basename(binaryRoot),
    command,
  };
}

function claudeMcpEntry(receipt) {
  if (receipt.mcpIdleWorker !== undefined) {
    const worker = receipt.mcpIdleWorker;
    if (
      worker?.schemaVersion !== 1 ||
      ![worker.executable, worker.worker, worker.catalogue].every(
        (pathname) => typeof pathname === "string" && path.isAbsolute(pathname),
      )
    ) {
      throw new Error("MCP idle worker receipt is invalid");
    }
    const integrationReceipt = {
      schemaVersion: 1,
      provider: receipt.provider,
      version: receipt.version,
      digest: receipt.digest,
      channel: receipt.channel,
      capabilities: receipt.capabilities,
    };
    return {
      type: "stdio",
      command: worker.executable,
      args: [
        "mcp-stdio-relay",
        "--node", receipt.runtimeExecutable,
        "--worker", worker.worker,
        "--catalogue", worker.catalogue,
        "--receipt-json", JSON.stringify(integrationReceipt),
      ],
    };
  }
  return {
    type: "stdio",
    command: receipt.runtimeExecutable,
    args: [path.join(receipt.installRoot, "orchestration-mcp-server.mjs")],
  };
}

function mcpEntryMatches(candidate, expected) {
  return (
    candidate?.type === expected.type &&
    candidate?.command === expected.command &&
    isDeepStrictEqual(candidate?.args, expected.args)
  );
}

function prepareCodexMcp(configPath, receipt) {
  const content = readTextFile(configPath);
  const block = renderCodexBlock(receipt);
  const owned = extractCodexBlock(content);
  if (!owned && /^\s*\[mcp_servers\.(?:dure-orchestration|"dure-orchestration")\]\s*$/mu.test(content)) {
    throw new Error(`provider MCP name is already owned: ${configPath}`);
  }
  return replaceCodexBlock(content, block);
}

function renderCodexBlock(receipt) {
  const entry = claudeMcpEntry(receipt);
  const forwarded = [
    "TYPESAFE_API_KEY",
    "DURE_HOME",
    "DURE_APP_CHANNEL",
    "HEBBIAN_APP_CHANNEL",
    "DURE_BACKEND_PROFILE",
    "DURE_ORCHESTRATION_HOME",
    "DURE_ORCHESTRATION_ENDPOINT",
    "DURE_ORCHESTRATION_AUTHORIZATION",
    "DURE_ORCHESTRATION_PARTICIPANT",
    "DURE_ORCHESTRATION_ENDPOINT_REF",
    "DURE_ORCHESTRATION_SESSION_IDENTITY",
    "DURE_ORCHESTRATION_GENERATION",
    "DURE_ORCHESTRATION_CHECKPOINT",
    "HMUX_SESSION_ID",
    "HMUX_WORKSPACE_ID",
    "HMUX_RUNNER_PRINCIPAL",
    "HMUX_RUNNER_INSTANCE",
    "HMUX_CHANNEL_EPOCH",
    "HMUX_HOST_INSTANCE_ID",
    "HMUX_TERMINAL_EPOCH",
  ];
  return `${CODEX_BLOCK_BEGIN}\n# digest: ${receipt.digest}\n[mcp_servers.dure-orchestration]\ncommand = ${tomlString(entry.command)}\nargs = [${entry.args.map(tomlString).join(", ")}]\nenv_vars = [${forwarded.map(tomlString).join(", ")}]\n${CODEX_BLOCK_END}`;
}

function extractCodexBlock(content) {
  const begin = content.indexOf(CODEX_BLOCK_BEGIN);
  const end = content.indexOf(CODEX_BLOCK_END);
  if (begin === -1 && end === -1) return null;
  if (
    begin === -1 ||
    end < begin ||
    content.indexOf(CODEX_BLOCK_BEGIN, begin + 1) !== -1 ||
    content.indexOf(CODEX_BLOCK_END, end + 1) !== -1
  ) {
    throw new Error("Codex orchestration MCP block is invalid");
  }
  return content.slice(begin, end + CODEX_BLOCK_END.length);
}

function replaceCodexBlock(content, replacement) {
  const owned = extractCodexBlock(content);
  const without = owned ? content.replace(owned, "").trim() : content.trim();
  return `${without ? `${without}\n\n` : ""}${replacement}\n`;
}

function prepareLifecycleHook(target, receipt, previousReceipt) {
  const settings = readJsonObject(target.hookPath, "provider lifecycle hook config");
  // Codex keys hook trust by group position, so a changed command keeps the
  // owned hook's place: moving it to the end would re-key every later hook.
  // Removing the last owned hook can remove SessionStart and its hooks map.
  // Recreate the insertion containers after cleanup when the Node path changes.
  if (previousReceipt?.lifecycleCommand && previousReceipt.lifecycleCommand !== receipt.lifecycleCommand) {
    if (!hookCommandRegistered(settings, receipt.lifecycleCommand)) {
      replaceFirstHookCommand(settings, previousReceipt.lifecycleCommand, receipt.lifecycleCommand);
    }
    removeHookCommand(settings, previousReceipt.lifecycleCommand);
  }
  settings.hooks = settings.hooks ?? {};
  if (typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new Error(`provider lifecycle hook config is invalid: ${target.hookPath}`);
  }
  settings.hooks.SessionStart = Array.isArray(settings.hooks.SessionStart)
    ? settings.hooks.SessionStart
    : [];
  if (!hookCommandRegistered(settings, receipt.lifecycleCommand)) {
    settings.hooks.SessionStart.push({
      matcher: target.adapter.hookMatcher,
      hooks: [{ type: "command", command: receipt.lifecycleCommand }],
    });
  }
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function providerAdapterCurrent(target, receipt, { acceptInstalledRelay = false } = {}) {
  if (
    receipt.nativeConfigPath !== path.resolve(target.nativeConfigPath) ||
    receipt.lifecycleHookPath !== path.resolve(target.hookPath) ||
    typeof receipt.lifecycleCommand !== "string" ||
    typeof receipt.runtimeExecutable !== "string"
  ) {
    return false;
  }
  if (target.staged) {
    const manifest = readJsonObject(target.nativeConfigPath, "staged MCP manifest");
    const hooks = readJsonObject(target.hookPath, "staged lifecycle hook manifest");
    return (
      mcpEntryMatches(manifest.servers?.[MCP_NAME], claudeMcpEntry(receipt)) &&
      hookCommandRegistered(hooks, receipt.lifecycleCommand)
    );
  }
  let nativeCurrent;
  if (target.adapter.nativeConfig === "claude-json") {
    const entry = readJsonObject(target.nativeConfigPath, "provider MCP config").mcpServers?.[MCP_NAME];
    const expected = claudeMcpEntry(receipt);
    nativeCurrent =
      mcpEntryMatches(entry, expected) ||
      (acceptInstalledRelay && installedRelayOfOtherVersion(entry, expected, receipt.provider));
  } else {
    nativeCurrent = extractCodexBlock(readTextFile(target.nativeConfigPath)) === renderCodexBlock(receipt);
  }
  const hooks = readJsonObject(target.hookPath, "provider lifecycle hook config");
  return nativeCurrent && hookCommandRegistered(hooks, receipt.lifecycleCommand);
}

function removeOwnedPayload(target, options) {
  assertSafeTarget(target.installRoot, target.providerRoot, options.installRoot !== undefined);
  const receiptPath = path.join(target.installRoot, RECEIPT);
  if (!fs.existsSync(receiptPath)) return;
  const canonicalRoot = fs.realpathSync(target.installRoot);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (
    receipt.schemaVersion !== 1 ||
    receipt.provider !== target.provider ||
    receipt.installRoot !== canonicalRoot
  ) {
    throw new Error(`refusing to remove unowned integration root: ${target.installRoot}`);
  }
  const hookPath = path.resolve(target.hookPath);
  // Refuse an unreadable config before anything moves; the commit re-reads it.
  prepareProviderRemoval(target, receipt);
  const hookSettings = readJsonObject(hookPath, "provider lifecycle hook config");
  removeHookCommand(hookSettings, receipt.lifecycleCommand);
  const hooks = `${JSON.stringify(hookSettings, null, 2)}\n`;
  const installedSkill = path.join(target.skillRoot, "SKILL.md");
  const snapshots = snapshotFiles([hookPath, installedSkill]);
  const tombstone = `${canonicalRoot}.remove-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(canonicalRoot, tombstone);
    commitNativeConfig(target, options, () => prepareProviderRemoval(target, receipt), () => {
      writeFileAtomic(hookPath, hooks);
      if (
        fs.existsSync(installedSkill) &&
        fs.readFileSync(installedSkill).equals(fs.readFileSync(path.join(tombstone, "SKILL.md")))
      ) {
        fs.rmSync(target.skillRoot, { recursive: true });
      }
      fs.rmSync(tombstone, { recursive: true });
    });
  } catch (error) {
    restoreFiles(snapshots);
    if (!fs.existsSync(canonicalRoot) && fs.existsSync(tombstone)) {
      fs.renameSync(tombstone, canonicalRoot);
    }
    throw error;
  }
}

function prepareProviderRemoval(target, receipt) {
  if (target.staged) return "";
  if (target.adapter.nativeConfig === "claude-json") {
    const settings = readJsonObject(target.nativeConfigPath, "provider MCP config");
    if (mcpEntryMatches(settings.mcpServers?.[MCP_NAME], claudeMcpEntry(receipt))) {
      delete settings.mcpServers[MCP_NAME];
      if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
    }
    return `${JSON.stringify(settings, null, 2)}\n`;
  }
  const content = readTextFile(target.nativeConfigPath);
  const owned = extractCodexBlock(content);
  if (!owned) return content;
  const without = content.replace(owned, "").trim();
  return without ? `${without}\n` : "";
}

function hookCommandRegistered(settings, command) {
  const groups = settings?.hooks?.SessionStart;
  return (
    Array.isArray(groups) &&
    groups.some(
      (group) =>
        Array.isArray(group?.hooks) && group.hooks.some((hook) => hook?.command === command),
    )
  );
}

function removeHookCommand(settings, command) {
  if (!command || !Array.isArray(settings?.hooks?.SessionStart)) return;
  settings.hooks.SessionStart = settings.hooks.SessionStart
    .map((group) => ({
      ...group,
      hooks: Array.isArray(group?.hooks)
        ? group.hooks.filter((hook) => hook?.command !== command)
        : [],
    }))
    .filter((group) => group.hooks.length > 0);
  if (settings.hooks.SessionStart.length === 0) delete settings.hooks.SessionStart;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

function replaceFirstHookCommand(settings, command, replacement) {
  for (const group of Array.isArray(settings?.hooks?.SessionStart) ? settings.hooks.SessionStart : []) {
    const hook = Array.isArray(group?.hooks) ? group.hooks.find((entry) => entry?.command === command) : undefined;
    if (hook) {
      hook.command = replacement;
      return;
    }
  }
}

function lifecycleHookCommand(runtimeExecutable, lifecycleScript) {
  return `${shellQuote(runtimeExecutable)} ${shellQuote(lifecycleScript)} --event session_start`;
}

/**
 * The Node path the provider lifecycle hook names. Codex trusts a hook by its
 * command text, so a command naming one immutable CLI build
 * (`versions/<build>/bin/node`) needs another review after every update, and
 * unattended sessions stop at that review. When the running Node is the build
 * the install's `current` pointer selects, name it through that pointer: the
 * command then stays the same across updates. Any other runtime keeps its
 * resolved path.
 */
export function lifecycleRuntimeExecutable(runtimeExecutable) {
  const binaryDirectory = path.dirname(runtimeExecutable);
  const versionsRoot = path.dirname(path.dirname(binaryDirectory));
  if (path.basename(binaryDirectory) !== "bin" || path.basename(versionsRoot) !== "versions") {
    return runtimeExecutable;
  }
  const stable = path.join(
    path.dirname(versionsRoot),
    "current",
    "bin",
    path.basename(runtimeExecutable),
  );
  try {
    return fs.realpathSync(stable) === runtimeExecutable ? stable : runtimeExecutable;
  } catch {
    return runtimeExecutable;
  }
}

// Rewrites the provider's native config from its contents at commit time, then
// runs the rest of the commit. A global Claude config is a source of the
// desktop Claude shared-state sync, so the read, the write and any rollback of
// it happen under the sync's lock: a sync write that lands while the payload is
// staged is kept, and a rollback puts back exactly the file it replaced.
function commitNativeConfig(target, options, prepare, rest) {
  const nativeConfigPath = path.resolve(target.nativeConfigPath);
  const sharedWithSync =
    !target.staged && target.adapter.nativeConfig === "claude-json" && Boolean(options.global);
  const release = sharedWithSync
    ? acquireClaudeSharedStateLock(
        options.dureHome ?? path.join(options.homeDirectory, ".dure"),
        options.sharedStateLockTimeoutMs ?? CLAUDE_SHARED_STATE_LOCK_TIMEOUT_MS,
      )
    : () => {};
  try {
    const snapshot = snapshotFiles([nativeConfigPath]);
    let written = false;
    try {
      writeFileAtomic(nativeConfigPath, prepare());
      written = true;
      rest();
    } catch (error) {
      if (written) restoreFiles(snapshot);
      throw error;
    }
  } finally {
    release();
  }
}

function acquireClaudeSharedStateLock(dureHome, timeoutMs) {
  // The sync runs on macOS and Linux, and only for an account root the app
  // created. Without one there is no sync to serialize with.
  if (process.platform !== "darwin" && process.platform !== "linux") return () => {};
  if (!fs.lstatSync(path.join(dureHome, "accounts"), { throwIfNoEntry: false })?.isDirectory()) {
    return () => {};
  }
  const lockPath = path.join(dureHome, ...CLAUDE_SHARED_STATE_LOCK);
  const lockDirectory = path.dirname(lockPath);
  try {
    fs.mkdirSync(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const directory = fs.lstatSync(lockDirectory);
  if (!directory.isDirectory() || directory.uid !== process.getuid()) {
    throw new Error(`refusing untrusted Claude shared state lock directory: ${lockDirectory}`);
  }
  const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;
  const busy = () => new Error(`Claude shared state is busy; try again: ${lockPath}`);
  if (process.platform === "darwin") {
    // O_EXLOCK takes the same flock(2) lock the sync holds.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const descriptor = fs.openSync(lockPath, flags | DARWIN_O_EXLOCK | fs.constants.O_NONBLOCK, 0o600);
        return () => fs.closeSync(descriptor);
      } catch (error) {
        if (error?.code !== "EAGAIN" && error?.code !== "EWOULDBLOCK") throw error;
      }
      if (Date.now() >= deadline) throw busy();
      Atomics.wait(LOCK_POLL, 0, 0, 25);
    }
  }
  const descriptor = fs.openSync(lockPath, flags, 0o600);
  // flock(2) locks belong to the open file description, so the lock flock(1)
  // takes on the inherited descriptor stays held until this process closes it.
  const locked = spawnSync("flock", ["-x", "-w", String(timeoutMs / 1000), "3"], {
    stdio: ["ignore", "ignore", "pipe", descriptor],
    encoding: "utf8",
  });
  if (locked.status === 0) return () => fs.closeSync(descriptor);
  fs.closeSync(descriptor);
  // Without flock(1) the installer keeps its previous unlocked behaviour.
  if (locked.error?.code === "ENOENT") return () => {};
  if (locked.status === 1) throw busy();
  throw new Error(`could not lock Claude shared state: ${locked.error?.message ?? locked.stderr.trim()}`);
}

function readJsonObject(filePath, label) {
  if (!fs.existsSync(filePath)) return {};
  if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`refusing ${label} symlink: ${filePath}`);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid: ${filePath}`);
  }
  return value;
}

function readTextFile(filePath) {
  if (!fs.existsSync(filePath)) return "";
  if (fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`refusing provider config symlink: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function snapshotFiles(paths) {
  return new Map(
    paths.map((filePath) => [
      filePath,
      fs.existsSync(filePath)
        ? { exists: true, content: fs.readFileSync(filePath), mode: fs.statSync(filePath).mode }
        : { exists: false },
    ]),
  );
}

function restoreFiles(snapshots) {
  for (const [filePath, snapshot] of snapshots) {
    if (snapshot.exists) {
      writeFileAtomic(filePath, snapshot.content, snapshot.mode);
    } else if (fs.existsSync(filePath)) {
      fs.rmSync(filePath);
    }
  }
}

function writeFileAtomic(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`refusing provider config symlink: ${filePath}`);
  }
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.next-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    fs.writeFileSync(temporary, content, { mode });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

function assertSafeTarget(targetPath, providerRoot, explicitRoot) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedProvider = path.resolve(providerRoot);
  if (
    resolvedTarget === path.parse(resolvedTarget).root ||
    resolvedTarget === resolvedProvider ||
    (!explicitRoot && !resolvedTarget.startsWith(`${resolvedProvider}${path.sep}`)) ||
    (explicitRoot && resolvedTarget.split(path.sep).filter(Boolean).length < 3)
  ) {
    throw new Error(`integration install root must stay below provider root: ${resolvedTarget}`);
  }
}

function assertReference(field, value) {
  if (typeof value !== "string" || !SAFE_REFERENCE.test(value)) {
    throw new Error(`${field} is invalid`);
  }
}

function tomlString(value) {
  return JSON.stringify(value);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
