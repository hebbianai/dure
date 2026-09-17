import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { resolveChannelCommand } from "./dure-cli-channel-launcher.mjs";

const DEPRECATED_COMMANDS = new Set(["hebbian-ade", "hebbian-ide"]);
const MAX_JSON_BYTES = 64 * 1024;
const SAFE_BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SAFE_PACKAGE_VERSION =
  /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
const APP_COMPATIBILITY_MODES = new Set([
  "current",
  "version-skew",
  "degraded",
  "legacy",
]);
const APP_COMPATIBILITY_BASES = new Set([
  "none",
  "runtime-fingerprint",
  "build-id-fallback",
  "fingerprint-unavailable",
]);
const FRONTEND_WORKTREE_OVERLAYS = new Set(["clean", "present", "unknown"]);
const DEFAULT_DIAGNOSTIC_REQUIREMENTS = ["app", "hmux", "path"];
const DIAGNOSTIC_REQUIREMENTS = new Set(DEFAULT_DIAGNOSTIC_REQUIREMENTS);

export function supportsHmuxCapability(manifest, capability) {
  return (
    Number.isInteger(manifest?.schemaVersion) &&
    manifest.schemaVersion >= 1 &&
    Array.isArray(manifest.capabilities) &&
    manifest.capabilities.includes(capability)
  );
}

function regularJson(pathname) {
  try {
    const stat = lstatSync(pathname);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) {
      return null;
    }
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    return null;
  }
}

function realpath(pathname) {
  try {
    return realpathSync(pathname);
  } catch {
    return null;
  }
}

function absolutePath(pathname) {
  if (!pathname) return null;
  return isAbsolute(pathname) ? pathname : resolve(pathname);
}

function pathCommand(command, environment) {
  for (const directory of String(environment.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      const resolvedPath = realpath(candidate);
      if (resolvedPath) return { path: candidate, resolvedPath };
    } catch {}
  }
  return null;
}

function pathSelectsCli(discovered, resolvedPath, environment) {
  if (!discovered?.resolvedPath) return false;
  if (discovered.resolvedPath === resolvedPath) return true;
  try {
    return (
      resolveChannelCommand({
        launcherPath: discovered.resolvedPath,
        environment,
      }).resolvedTarget === resolvedPath
    );
  } catch {
    return false;
  }
}

function installedIdentity(resolvedScriptPath) {
  const descriptorPath = join(dirname(dirname(resolvedScriptPath)), "install.json");
  const descriptor = regularJson(descriptorPath);
  if (
    descriptor?.schemaVersion !== 3 ||
    descriptor.command !== "dure" ||
    !SAFE_PACKAGE_VERSION.test(descriptor.packageVersion || "") ||
    !SAFE_BUILD_ID.test(descriptor.buildId || "")
  ) {
    return null;
  }
  return {
    packageVersion: descriptor.packageVersion,
    buildId: descriptor.buildId,
    installation: "immutable",
    installDescriptorPath: descriptorPath,
  };
}

function sourceIdentity(resolvedScriptPath) {
  const packagePath = join(dirname(resolvedScriptPath), "package.json");
  const manifest = regularJson(packagePath);
  if (
    manifest?.name !== "dure-cli" ||
    !SAFE_PACKAGE_VERSION.test(manifest.version || "")
  ) {
    return null;
  }
  return {
    packageVersion: manifest.version,
    buildId: null,
    installation: "source",
    installDescriptorPath: null,
  };
}

/** The two layouts a `dure` script can be running from, in precedence order,
 *  with a stable fallback. An installed channel has `install.json` a level
 *  above `bin/`; a source checkout has `cli/package.json` beside the script.
 *  Anything else genuinely cannot say which build this is. */
function identityMetadata(resolvedScriptPath) {
  return (
    installedIdentity(resolvedScriptPath) ||
    sourceIdentity(resolvedScriptPath) || {
      packageVersion: "unknown",
      buildId: null,
      installation: "unknown",
      installDescriptorPath: null,
    }
  );
}

/**
 * The running CLI's own version, resolved exactly the way `dure --version`
 * resolves it — both layouts, not just the source checkout.
 *
 * Callers that only need the version string should use this rather than
 * reading `cli/package.json` themselves: that manifest is not shipped into an
 * installed channel, so reading it directly answers "unknown" on every real
 * install while working perfectly in the repository and in tests. See #923.
 */
export function cliPackageVersion(scriptPath) {
  const absoluteScriptPath = absolutePath(scriptPath);
  return identityMetadata(realpath(absoluteScriptPath) || absoluteScriptPath)
    .packageVersion;
}

export function inspectCliIdentity({
  scriptPath,
  invocationPath = scriptPath,
  invokedAs = basename(invocationPath || "dure"),
  environment = process.env,
}) {
  const safeInvokedAs = /^[A-Za-z0-9._-]{1,64}$/.test(invokedAs || "")
    ? invokedAs
    : "unknown";
  const absoluteScriptPath = absolutePath(scriptPath);
  const resolvedPath = realpath(absoluteScriptPath) || absoluteScriptPath;
  const metadata = identityMetadata(resolvedPath);
  const discovered = pathCommand("dure", environment);
  return {
    schemaVersion: 1,
    command: "dure",
    invokedAs: safeInvokedAs,
    deprecatedInvocation: DEPRECATED_COMMANDS.has(safeInvokedAs),
    packageVersion: metadata.packageVersion,
    buildId: metadata.buildId,
    installation: metadata.installation,
    invocationPath: absolutePath(invocationPath),
    resolvedPath,
    installDescriptorPath: metadata.installDescriptorPath,
    pathCommand: discovered?.path ?? null,
    pathResolvedPath: discovered?.resolvedPath ?? null,
    pathMatchesCurrent: pathSelectsCli(discovered, resolvedPath, environment),
  };
}

function validateServerDescriptor(descriptor) {
  if (
    descriptor?.schemaVersion !== 1 ||
    !Number.isInteger(descriptor.port) ||
    descriptor.port < 1 ||
    descriptor.port > 65_535 ||
    typeof descriptor.token !== "string" ||
    descriptor.token.length < 1 ||
    descriptor.token.length > 512 ||
    typeof descriptor.channel !== "string" ||
    !/^[a-z0-9-]{1,64}$/.test(descriptor.channel) ||
    typeof descriptor.generation !== "string" ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(descriptor.generation) ||
    !Number.isSafeInteger(descriptor.processId) ||
    descriptor.processId < 1 ||
    !Number.isSafeInteger(descriptor.startedAtUnixMs) ||
    descriptor.startedAtUnixMs < 0
  ) {
    return null;
  }
  const packageVersion = SAFE_PACKAGE_VERSION.test(
    descriptor.packageVersion || "",
  )
    ? descriptor.packageVersion
    : null;
  const buildId = SAFE_BUILD_ID.test(descriptor.buildId || "")
    ? descriptor.buildId
    : null;
  const apiVersion =
    Number.isSafeInteger(descriptor.apiVersion) && descriptor.apiVersion > 0
    ? descriptor.apiVersion
    : null;
  return {
    token: descriptor.token,
    public: {
      descriptorPath: null,
      channel: descriptor.channel,
      generation: descriptor.generation,
      processId: descriptor.processId,
      startedAtUnixMs: descriptor.startedAtUnixMs,
      packageVersion,
      buildId,
      apiVersion,
    },
    fence: {
      channel: descriptor.channel,
      generation: descriptor.generation,
      processId: descriptor.processId,
    },
    port: descriptor.port,
  };
}

async function requestJson(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = null;
    if (text.length <= MAX_JSON_BYTES) {
      try {
        body = JSON.parse(text);
      } catch {}
    }
    return { status: response.status, ok: response.ok, body };
  } catch (error) {
    return {
      error: error?.name === "AbortError" ? "timeout" : "connection_failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

function safeToken(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value.replace(/[\u0000-\u001f\u007f]/g, "?")
    : null;
}

function normalizeBackend(backend) {
  if (!backend || typeof backend !== "object") return null;
  const name = safeToken(backend.name);
  const packageVersion = safeToken(backend.packageVersion, 64);
  const buildId = safeToken(backend.buildId);
  if (
    !name ||
    !packageVersion ||
    !buildId ||
    !Number.isSafeInteger(backend.protocolVersion) ||
    backend.protocolVersion < 0 ||
    !Array.isArray(backend.features)
  ) {
    return null;
  }
  return {
    name,
    packageVersion,
    protocolVersion: backend.protocolVersion,
    buildId,
    runtimeFingerprint: safeToken(backend.runtimeFingerprint) || null,
    features: backend.features
      .slice(0, 128)
      .map((feature) => safeToken(feature, 128))
      .filter(Boolean),
  };
}

function normalizeCompatibility(value) {
  if (
    !value ||
    !APP_COMPATIBILITY_MODES.has(value.mode) ||
    !APP_COMPATIBILITY_BASES.has(value.comparisonBasis) ||
    !Array.isArray(value.missingFeatures)
  ) {
    return null;
  }
  const frontendBuildId = safeToken(value.frontendBuildId);
  if (!frontendBuildId) return null;
  const backend = normalizeBackend(value.backend);
  if ((value.backend !== null && !backend) || (value.mode !== "legacy" && !backend)) {
    return null;
  }
  return {
    mode: value.mode,
    comparisonBasis: value.comparisonBasis,
    frontendBuildId,
    frontendSourceRevision:
      typeof value.frontendSourceRevision === "string" &&
      /^[0-9a-f]{12}$/.test(value.frontendSourceRevision)
        ? value.frontendSourceRevision
        : null,
    frontendWorktreeOverlay: FRONTEND_WORKTREE_OVERLAYS.has(
      value.frontendWorktreeOverlay,
    )
      ? value.frontendWorktreeOverlay
      : "unknown",
    frontendRuntimeFingerprint:
      safeToken(value.frontendRuntimeFingerprint) || null,
    backend,
    missingFeatures: value.missingFeatures
      .slice(0, 128)
      .map((feature) => safeToken(feature, 128))
      .filter(Boolean),
  };
}

function pingMatchesFence(ping, fence) {
  return (
    ping?.ok === true &&
    ping.channel === fence.channel &&
    ping.generation === fence.generation &&
    ping.processId === fence.processId
  );
}

export async function inspectAppRuntime({
  descriptorPath,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_500,
}) {
  const rawDescriptor = regularJson(descriptorPath);
  if (!rawDescriptor) {
    let exists = false;
    try {
      exists = lstatSync(descriptorPath) !== undefined;
    } catch {}
    return {
      state: exists ? "invalid_descriptor" : "not_running",
      descriptorPath,
      compatibility: { state: "unavailable", mode: null },
    };
  }
  const descriptor = validateServerDescriptor(rawDescriptor);
  if (!descriptor) {
    return {
      state: "invalid_descriptor",
      descriptorPath,
      compatibility: { state: "unavailable", mode: null },
    };
  }
  descriptor.public.descriptorPath = descriptorPath;
  const baseUrl = `http://127.0.0.1:${descriptor.port}`;
  const headers = { Authorization: `Bearer ${descriptor.token}` };
  const ping = await requestJson(
    fetchImpl,
    `${baseUrl}/ping`,
    { method: "GET", headers },
    timeoutMs,
  );
  if (ping.error || !ping.ok || !pingMatchesFence(ping.body, descriptor.fence)) {
    return {
      state: "stale_descriptor",
      ...descriptor.public,
      compatibility: { state: "unavailable", mode: null },
    };
  }
  const diagnostics = await requestJson(
    fetchImpl,
    `${baseUrl}/diagnostics`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    },
    timeoutMs,
  );
  if (diagnostics.status === 404) {
    return {
      state: "running",
      ...descriptor.public,
      compatibility: { state: "unsupported", mode: null },
    };
  }
  const compatibility = normalizeCompatibility(diagnostics.body?.compatibility);
  if (
    diagnostics.error ||
    !diagnostics.ok ||
    diagnostics.body?.ok !== true ||
    diagnostics.body?.schemaVersion !== 1 ||
    !compatibility
  ) {
    return {
      state: "running",
      ...descriptor.public,
      compatibility: { state: "unavailable", mode: null },
    };
  }
  return {
    state: "running",
    ...descriptor.public,
    compatibility: {
      state: "available",
      mode: compatibility.mode,
      detail: compatibility,
    },
  };
}

export function createDiagnosticReport({ cli, app, hmux, now = Date.now() }) {
  const issues = [];
  if (!cli.pathMatchesCurrent) issues.push("cli_path_mismatch");
  if (app.state !== "running") {
    issues.push(`app_${app.state}`);
  } else if (app.compatibility.state !== "available") {
    issues.push(`app_compatibility_${app.compatibility.state}`);
  } else if (app.compatibility.mode !== "current") {
    issues.push(`app_${String(app.compatibility.mode).replaceAll("-", "_")}`);
  }
  if (!hmux.compatible) issues.push("hmux_incompatible");
  return {
    schemaVersion: 1,
    generatedAtMs: now,
    status: issues.length === 0 ? "ok" : "degraded",
    issues,
    cli,
    app,
    hmux,
  };
}

export function parseDiagnosticRequirements(value) {
  if (value === undefined) return [...DEFAULT_DIAGNOSTIC_REQUIREMENTS];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      "--require must specify one or more comma-separated values from app,hmux,path.",
    );
  }
  const requirements = [];
  for (const requirement of value.split(",").map((item) => item.trim())) {
    if (!DIAGNOSTIC_REQUIREMENTS.has(requirement)) {
      throw new Error(
        "Unknown diagnostics requirement. Supported values: app,hmux,path",
      );
    }
    if (!requirements.includes(requirement)) requirements.push(requirement);
  }
  return requirements;
}

export function evaluateDiagnosticCheck(report, required) {
  const passed = {
    app:
      report.app?.state === "running" &&
      report.app.compatibility?.state === "available" &&
      report.app.compatibility.mode === "current",
    hmux: report.hmux?.compatible === true,
    path: report.cli?.pathMatchesCurrent === true,
  };
  const failed = required.filter((requirement) => !passed[requirement]);
  return {
    required: [...required],
    failed,
    passed: failed.length === 0,
  };
}

function label(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "?")
    : (value ?? "unknown");
}

export function formatVersion(identity) {
  const build = identity.buildId ? ` (${identity.buildId})` : " (source)";
  return `dure ${identity.packageVersion}${build}`;
}

export function formatDiagnosticReport(report) {
  const compatibility = report.app.compatibility;
  const checkLines = report.check
    ? [
        "check:",
        `  required: ${report.check.required.join(",")}`,
        `  passed: ${label(report.check.passed)}`,
        `  failed: ${report.check.failed.join(",") || "none"}`,
      ]
    : [];
  return [
    `Dure diagnostics: ${report.status}`,
    "cli:",
    `  version: ${report.cli.packageVersion}`,
    `  build: ${label(report.cli.buildId)}`,
    `  invoked_as: ${report.cli.invokedAs}`,
    `  deprecated_invocation: ${label(report.cli.deprecatedInvocation)}`,
    `  binary: ${label(report.cli.resolvedPath)}`,
    `  path_binary: ${label(report.cli.pathResolvedPath)}`,
    `  path_matches: ${label(report.cli.pathMatchesCurrent)}`,
    "app:",
    `  status: ${report.app.state}`,
    `  channel: ${label(report.app.channel)}`,
    `  version: ${label(report.app.packageVersion)}`,
    `  build: ${label(report.app.buildId)}`,
    `  source_revision: ${label(compatibility.detail?.frontendSourceRevision)}`,
    `  worktree_overlay: ${label(compatibility.detail?.frontendWorktreeOverlay)}`,
    `  compatibility: ${compatibility.mode ?? compatibility.state}`,
    "hmux:",
    `  command: ${label(report.hmux.command)}`,
    `  version: ${label(report.hmux.version)}`,
    `  compatible: ${label(report.hmux.compatible)}`,
    ...checkLines,
    "issues:",
    ...(report.issues.length === 0
      ? ["  none"]
      : report.issues.map((issue) => `  - ${issue}`)),
  ].join("\n");
}
