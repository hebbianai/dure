import fs from "node:fs";
import path from "node:path";

export function safeBuildId(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value)
  );
}

export function defaultDiscoveryRoots(environment = process.env, platform = process.platform) {
  if (environment.HMUX_DISCOVERY_ROOT !== undefined) {
    if (!environment.HMUX_DISCOVERY_ROOT) {
      throw new Error("HMUX_DISCOVERY_ROOT must not be empty");
    }
    return [path.resolve(environment.HMUX_DISCOVERY_ROOT)];
  }
  const home = environment.HOME;
  const roots = [];
  if (environment.DURE_HOME) {
    roots.push(path.join(environment.DURE_HOME, "state/hmux-hosts"));
  } else if (home) {
    roots.push(path.join(home, ".dure/state/hmux-hosts"));
  } else {
    throw new Error("HMUX_DISCOVERY_ROOT, DURE_HOME, or HOME is required");
  }
  if (environment.HEBBIAN_HOME) {
    roots.push(path.join(environment.HEBBIAN_HOME, "state/hebbian-agent/hmux-hosts"));
  }
  if (home && platform === "darwin") {
    roots.push(
      path.join(home, "Library/Application Support/hebbian/hebbian-agent/hmux-hosts"),
    );
  }
  if (home && platform !== "darwin") {
    roots.push(
      path.join(
        environment.XDG_STATE_HOME || path.join(home, ".local/state"),
        "hebbian/hebbian-agent/hmux-hosts",
      ),
    );
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function manifestCommon(value) {
  if (!value || typeof value !== "object") return undefined;
  const record = value;
  const manifest =
    record.manifest && typeof record.manifest === "object" ? record.manifest : record;
  return manifest.common && typeof manifest.common === "object"
    ? manifest.common
    : undefined;
}

function manifestLifecycle(value) {
  if (!value || typeof value !== "object") return undefined;
  const record = value;
  if (typeof record.lifecycle === "string") return record.lifecycle;
  return typeof record.manifest?.lifecycle === "string"
    ? record.manifest.lifecycle
    : undefined;
}

function localProcessStatus(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) return "indeterminate";
  try {
    process.kill(processId, 0);
    return "live";
  } catch (error) {
    if (error?.code === "ESRCH") return "absent";
    return "indeterminate";
  }
}

const DEFAULT_MAX_VERSIONS = 32;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_VERSION_TREE_ENTRIES = 4_096;

function versionTreeBytes(directory) {
  let bytes = 0;
  let entries = 0;
  const visit = (candidate) => {
    const metadata = fs.lstatSync(candidate);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Hmux version contains an unexpected symlink: ${candidate}`);
    }
    entries += 1;
    if (entries > MAX_VERSION_TREE_ENTRIES) {
      throw new Error(`Hmux version tree exceeds the safe entry bound: ${directory}`);
    }
    bytes += metadata.size;
    if (!metadata.isDirectory()) return;
    for (const child of fs.readdirSync(candidate)) {
      visit(path.join(candidate, child));
    }
  };
  visit(directory);
  return bytes;
}

function manifestFiles(root, maximumDepth = 5) {
  let rootMetadata;
  try {
    rootMetadata = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (rootMetadata.isSymbolicLink()) {
    throw new Error(`Hmux discovery root must not be a symlink: ${root}`);
  }
  if (!rootMetadata.isDirectory()) {
    throw new Error(`Hmux discovery root must be a directory: ${root}`);
  }
  const found = [];
  const visit = (directory, depth) => {
    if (depth > maximumDepth) {
      throw new Error(`Hmux discovery tree exceeds the safe depth at ${directory}`);
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Hmux discovery contains an unexpected symlink: ${candidate}`);
      }
      if (entry.isDirectory()) {
        visit(candidate, depth + 1);
      } else if (entry.isFile() && entry.name === "manifest.json") {
        found.push(candidate);
      }
    }
  };
  visit(root, 0);
  return found;
}

function buildReferenceReasons(discoveryRoots, isProcessLive) {
  const builds = new Map();
  for (const root of discoveryRoots) {
    for (const manifestPath of manifestFiles(root)) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch (error) {
        throw new Error(`cannot safely inspect ${manifestPath}: ${error.message}`);
      }
      const common = manifestCommon(parsed);
      if (!common) {
        throw new Error(`cannot safely inspect manifest common data at ${manifestPath}`);
      }
      const lifecycle = manifestLifecycle(parsed);
      if (!["starting", "ready", "exited"].includes(lifecycle)) {
        throw new Error(`cannot safely inspect manifest lifecycle at ${manifestPath}`);
      }
      const buildId = common.host_build_version;
      const processId = common.host_process?.process_id;
      const durableReady = lifecycle === "ready";
      const processStatus = isProcessLive
        ? isProcessLive(processId)
          ? "live"
          : "absent"
        : localProcessStatus(processId);
      if (!durableReady && processStatus === "absent") continue;
      if (!safeBuildId(buildId)) {
        throw new Error(
          `protected Hmux manifest has an unsafe build id at ${manifestPath}`,
        );
      }
      const reasons = builds.get(buildId) ?? new Set();
      if (durableReady) reasons.add("durable_ready_receipt");
      if (processStatus === "live") reasons.add("live_host");
      if (processStatus === "indeterminate") {
        reasons.add("process_liveness_indeterminate");
      }
      builds.set(buildId, reasons);
    }
  }
  return builds;
}

export function liveBuildReferences(discoveryRoots, isProcessLive) {
  return new Set(buildReferenceReasons(discoveryRoots, isProcessLive).keys());
}

function installedVersions(installRoot) {
  const versionsRoot = path.join(installRoot, "versions");
  if (!fs.existsSync(versionsRoot)) return [];
  if (fs.lstatSync(versionsRoot).isSymbolicLink()) {
    throw new Error(`Hmux versions root must not be a symlink: ${versionsRoot}`);
  }
  return fs
    .readdirSync(versionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => {
      if (!safeBuildId(entry.name)) {
        throw new Error(`unsafe directory in Hmux versions root: ${entry.name}`);
      }
      const directory = path.join(versionsRoot, entry.name);
      const metadataPath = path.join(directory, "install.json");
      let metadata;
      try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      } catch (error) {
        throw new Error(`cannot safely inspect ${metadataPath}: ${error.message}`);
      }
      if (metadata.schemaVersion !== 1 || metadata.buildId !== entry.name) {
        throw new Error(`Hmux install metadata does not match ${directory}`);
      }
      return {
        buildId: entry.name,
        directory,
        modifiedMs: fs.statSync(directory).mtimeMs,
        bytes: versionTreeBytes(directory),
      };
    });
}

function linkedBuildId(installRoot, linkName) {
  const link = path.join(installRoot, linkName);
  let metadata;
  try {
    metadata = fs.lstatSync(link);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (!metadata.isSymbolicLink()) {
    throw new Error(`Hmux ${linkName} must be a symlink: ${link}`);
  }
  const resolved = fs.realpathSync(link);
  const versionsRoot = fs.realpathSync(path.join(installRoot, "versions"));
  if (path.dirname(resolved) !== versionsRoot || !safeBuildId(path.basename(resolved))) {
    throw new Error(
      `Hmux ${linkName} link resolves outside the versions root: ${resolved}`,
    );
  }
  return path.basename(resolved);
}

function addProtection(protections, buildId, reason) {
  if (!buildId) return;
  const reasons = protections.get(buildId) ?? new Set();
  reasons.add(reason);
  protections.set(buildId, reasons);
}

function validatedBudget(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function planVersionPrune({
  installRoot,
  discoveryRoots = defaultDiscoveryRoots(),
  retain = 2,
  maxVersions = DEFAULT_MAX_VERSIONS,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  isProcessLive,
}) {
  validatedBudget(retain, "retain");
  validatedBudget(maxVersions, "maxVersions");
  validatedBudget(maxTotalBytes, "maxTotalBytes");
  const absoluteInstallRoot = path.resolve(installRoot);
  const versions = installedVersions(absoluteInstallRoot);
  const current = linkedBuildId(absoluteInstallRoot, "current");
  const previous = linkedBuildId(absoluteInstallRoot, "previous");
  const references = buildReferenceReasons(discoveryRoots, isProcessLive);
  const protections = new Map();
  addProtection(protections, current, "current");
  addProtection(protections, previous, "previous");
  for (const [buildId, reasons] of references) {
    for (const reason of reasons) addProtection(protections, buildId, reason);
  }
  const unprotected = versions
    .filter((version) => !protections.has(version.buildId))
    .sort((left, right) => right.modifiedMs - left.modifiedMs);
  let retainedByPolicy = 0;
  let protectedVersionCount = versions.filter((version) =>
    protections.has(version.buildId),
  ).length;
  let protectedBytes = versions
    .filter((version) => protections.has(version.buildId))
    .reduce((total, version) => total + version.bytes, 0);
  for (const version of unprotected) {
    if (retainedByPolicy >= retain) break;
    if (
      protectedVersionCount + 1 > maxVersions ||
      protectedBytes + version.bytes > maxTotalBytes
    ) {
      continue;
    }
    addProtection(protections, version.buildId, "retention");
    retainedByPolicy += 1;
    protectedVersionCount += 1;
    protectedBytes += version.bytes;
  }
  const removalCandidates = versions
    .filter((version) => !protections.has(version.buildId))
    .map((version) => ({
      buildId: version.buildId,
      path: version.directory,
      bytes: version.bytes,
      reason: "unreferenced_version",
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const retained = versions.filter((version) => protections.has(version.buildId));
  const installedBytes = versions.reduce((total, version) => total + version.bytes, 0);
  const removalBytes = removalCandidates.reduce(
    (total, candidate) => total + candidate.bytes,
    0,
  );
  const classification = (version) => {
    const reasons = protections.get(version.buildId);
    if (!reasons) return "orphan";
    if (
      reasons.has("current") ||
      reasons.has("previous") ||
      reasons.has("live_host")
    ) {
      return "healthy";
    }
    if (reasons.has("process_liveness_indeterminate")) return "indeterminate";
    if (reasons.has("durable_ready_receipt")) return "stale";
    return "orphan";
  };
  const candidateSummary = {
    healthy: 0,
    stale: 0,
    orphan: 0,
    indeterminate: 0,
  };
  for (const version of versions) candidateSummary[classification(version)] += 1;
  const projectedBytes = installedBytes - removalBytes;
  const projectedVersions = retained.length;
  return {
    schemaVersion: 1,
    installRoot: absoluteInstallRoot,
    discoveryRoots: discoveryRoots.map((root) => path.resolve(root)),
    retain,
    maxVersions,
    maxTotalBytes,
    currentBuildId: current,
    previousBuildId: previous,
    liveBuildIds: [...references.keys()].sort(),
    installedVersions: versions.length,
    installedBytes,
    removalVersions: removalCandidates.length,
    removalBytes,
    projectedVersions,
    projectedBytes,
    budgetUnmet:
      projectedVersions > maxVersions || projectedBytes > maxTotalBytes,
    candidateSummary,
    protectedVersions: retained
      .map((version) => ({
        buildId: version.buildId,
        bytes: version.bytes,
        reasons: [...protections.get(version.buildId)].sort(),
      }))
      .sort((left, right) => left.buildId.localeCompare(right.buildId)),
    removalCandidates,
    retainedBuildIds: versions
      .filter((version) => protections.has(version.buildId))
      .map((version) => version.buildId)
      .sort(),
    removals: removalCandidates.map((candidate) => candidate.path),
  };
}

export function applyVersionPrune(plan, isProcessLive) {
  if (plan.removals.length === 0) return [];
  const mutationLock = path.join(plan.installRoot, ".mutation-lock");
  try {
    fs.mkdirSync(mutationLock);
  } catch (error) {
    throw new Error(
      `another Hmux install or prune operation holds ${mutationLock}: ${error.message}`,
    );
  }
  try {
    const versionsRoot = fs.realpathSync(path.join(plan.installRoot, "versions"));
    const removed = [];
    for (const candidate of plan.removals) {
      const current = linkedBuildId(plan.installRoot, "current");
      const previous = linkedBuildId(plan.installRoot, "previous");
      const live = liveBuildReferences(plan.discoveryRoots, isProcessLive);
      const parent = fs.realpathSync(path.dirname(candidate));
      const buildId = path.basename(candidate);
      if (
        parent !== versionsRoot ||
        !safeBuildId(buildId) ||
        fs.lstatSync(candidate).isSymbolicLink()
      ) {
        throw new Error(`refusing unsafe Hmux version removal: ${candidate}`);
      }
      if (buildId === current || buildId === previous || live.has(buildId)) {
        throw new Error(`refusing live Hmux version removal: ${candidate}`);
      }
      const metadata = JSON.parse(
        fs.readFileSync(path.join(candidate, "install.json"), "utf8"),
      );
      if (metadata.schemaVersion !== 1 || metadata.buildId !== buildId) {
        throw new Error(`refusing Hmux version with mismatched metadata: ${candidate}`);
      }
      fs.rmSync(candidate, { recursive: true });
      removed.push(candidate);
    }
    return removed;
  } finally {
    fs.rmdirSync(mutationLock);
  }
}
