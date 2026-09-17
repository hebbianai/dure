import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeQaExecution } from "./qa-execution.mjs";

export const QA_EVIDENCE_FILENAMES = [
  "tauri-dev.log",
  "client.log",
  "last-status.json",
];
export const DEFAULT_MAX_LOG_BYTES = 512 * 1024;
export const DEFAULT_MAX_STATUS_BYTES = 256 * 1024;

const REDACTED = "[REDACTED]";
const TRUNCATION_MARKER = "[... earlier output truncated ...]\n";
const MAX_READ_MULTIPLIER = 4;
const SENSITIVE_NAME =
  "(?:authorization|bearer|token|proof|password|passwd|secret|key)";

export function redactQaEvidenceText(value, redactions = []) {
  let output = String(value);
  for (const { value: secret, replacement } of redactions) {
    if (secret) output = output.split(secret).join(replacement);
  }
  return output
    .replace(
      new RegExp(
        `(\\B--[\\w-]*${SENSITIVE_NAME}[\\w-]*(?:=|\\s+))(?:"[^"]*"|'[^']*'|[^\\s]+)`,
        "gi",
      ),
      `$1${REDACTED}`,
    )
    .replace(
      /^([\t ]*authorization[\t ]*:[\t ]*)(?:Basic|Bearer)[\t ]+.*$/gimu,
      `$1${REDACTED}`,
    )
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/giu, `$1 ${REDACTED}`)
    .replace(
      new RegExp(`("${SENSITIVE_NAME}"\\s*:\\s*")[^"]*(")`, "gi"),
      `$1${REDACTED}$2`,
    )
    .replace(
      new RegExp(`('${SENSITIVE_NAME}'\\s*:\\s*')[^']*(')`, "gi"),
      `$1${REDACTED}$2`,
    )
    .replace(
      new RegExp(`([?&][\\w-]*${SENSITIVE_NAME}[\\w-]*=)[^&\\s"']+`, "gi"),
      `$1${REDACTED}`,
    )
    .replace(
      new RegExp(
        `(\\b[\\w-]*${SENSITIVE_NAME}[\\w-]*\\b\\s*[=:]\\s*["'])[^"']*(["'])`,
        "gi",
      ),
      `$1${REDACTED}$2`,
    )
    .replace(
      new RegExp(
        `(\\b[\\w-]*${SENSITIVE_NAME}[\\w-]*\\b\\s*[=:]\\s*)(?!["']|\\[REDACTED\\])[^,\\s;&}\\]]+`,
        "gi",
      ),
      `$1${REDACTED}`,
    )
    .replace(
      new RegExp(
        `^(\\s*[\\w-]*${SENSITIVE_NAME}[\\w-]*\\s*=\\s*).*$`,
        "gimu",
      ),
      `$1${REDACTED}`,
    )
    .replace(
      new RegExp(
        `((?:^|[,\\s{])["']?[\\w-]*${SENSITIVE_NAME}[\\w-]*["']?\\s*:\\s*)(?!["']|\\[REDACTED\\])[^,}\\]\\r\\n]+`,
        "gi",
      ),
      `$1${REDACTED}`,
    );
}

function redactStructured(value, redactions, seen = new WeakSet()) {
  if (typeof value === "string") return redactQaEvidenceText(value, redactions);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactStructured(entry, redactions, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      new RegExp(SENSITIVE_NAME, "i").test(key)
        ? REDACTED
        : redactStructured(entry, redactions, seen),
    ]),
  );
}

export function boundQaEvidenceText(value, maxBytes) {
  const originalBytes = Buffer.byteLength(value);
  if (originalBytes <= maxBytes) {
    return { contents: value, truncated: false };
  }

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
  if (markerBytes >= maxBytes) {
    return {
      contents: Buffer.from(TRUNCATION_MARKER)
        .subarray(0, maxBytes)
        .toString("utf8"),
      truncated: true,
    };
  }

  const source = Buffer.from(value);
  let tail = source.subarray(source.length - (maxBytes - markerBytes)).toString(
    "utf8",
  );
  while (
    tail.length > 0 &&
    Buffer.byteLength(TRUNCATION_MARKER) + Buffer.byteLength(tail) > maxBytes
  ) {
    tail = tail.slice(1);
  }
  return { contents: `${TRUNCATION_MARKER}${tail}`, truncated: true };
}

function readLog(pathname, maxBytes, redactions) {
  const stat = fs.lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`QA evidence source is not a regular file: ${pathname}`);
  }

  const readLimit = maxBytes * MAX_READ_MULTIPLIER;
  let source;
  let prefixTruncated = false;
  const file = fs.openSync(pathname, "r");
  try {
    if (stat.size <= readLimit) {
      source = Buffer.alloc(stat.size);
      fs.readSync(file, source, 0, stat.size, 0);
    } else {
      source = Buffer.alloc(readLimit);
      fs.readSync(file, source, 0, readLimit, stat.size - readLimit);
      prefixTruncated = true;
    }
  } finally {
    fs.closeSync(file);
  }

  let text = source.toString("utf8");
  if (prefixTruncated) {
    const firstLineEnd = text.indexOf("\n");
    text = firstLineEnd >= 0 ? text.slice(firstLineEnd + 1) : "";
  }
  const bounded = boundQaEvidenceText(
    `${prefixTruncated ? TRUNCATION_MARKER : ""}${redactQaEvidenceText(text, redactions)}`,
    maxBytes,
  );
  return {
    contents: bounded.contents,
    sourceBytes: stat.size,
    truncated: prefixTruncated || bounded.truncated,
  };
}

function fallbackStatus({
  qaName,
  exitCode,
  reason,
  redactions,
  qaLayer,
  failureClass,
}) {
  const qaExecution = sanitizeQaExecution({
    schemaVersion: 1,
    layer: qaLayer,
    phaseDurationsMs: {},
    failureClass,
  });
  return {
    schemaVersion: 1,
    available: false,
    qaName: redactQaEvidenceText(qaName, redactions),
    result: "failed",
    exitCode,
    reason,
    ...(qaExecution ? { qaExecution } : {}),
  };
}

function readStatus(pathname, options) {
  if (!pathname || !fs.existsSync(pathname)) {
    return fallbackStatus({ ...options, reason: "status-not-recorded" });
  }

  const stat = fs.lstatSync(pathname);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return fallbackStatus({ ...options, reason: "status-not-regular-file" });
  }
  if (stat.size > options.maxStatusBytes) {
    return fallbackStatus({
      ...options,
      reason: `status-exceeded-${options.maxStatusBytes}-byte-limit`,
    });
  }

  try {
    return redactStructured(
      JSON.parse(fs.readFileSync(pathname, "utf8")),
      options.redactions,
    );
  } catch {
    return fallbackStatus({ ...options, reason: "status-invalid-json" });
  }
}

function writePrivateFile(pathname, contents) {
  fs.writeFileSync(pathname, contents, { mode: 0o600, flag: "wx" });
}

function makeRunId(qaName, now) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const label =
    qaName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "qa";
  return `${timestamp}-${label}-${crypto.randomUUID().slice(0, 8)}`;
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 64) {
    throw new Error(`${name} must be an integer of at least 64 bytes`);
  }
  return parsed;
}

function optionalGitObject(value, name) {
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{40,64}$/i.test(value)) {
    throw new Error(`${name} must be a full Git object id`);
  }
  return value.toLowerCase();
}

export function createQaEvidenceBundle({
  result,
  qaName,
  exitCode = 1,
  sources = {},
  artifactRoot = process.env.HEBBIAN_QA_ARTIFACT_ROOT ??
    path.resolve("artifacts/qa"),
  maxLogBytes,
  maxStatusBytes = DEFAULT_MAX_STATUS_BYTES,
  now = new Date(),
  runId,
  commitSha,
  treeSha,
  dirty = false,
  startedAtMs,
  qaLayer,
  failureClass,
  redactions = [],
} = {}) {
  if (result === "passed") return undefined;
  if (result !== "failed") {
    throw new Error('QA evidence result must be "passed" or "failed"');
  }
  if (typeof qaName !== "string" || qaName.length === 0) {
    throw new Error("QA evidence requires qaName");
  }
  if (!Number.isInteger(exitCode) || exitCode < 0) {
    throw new Error("QA evidence exitCode must be a non-negative integer");
  }
  if (
    !Array.isArray(redactions) ||
    redactions.some(
      (entry) =>
        !entry ||
        typeof entry.value !== "string" ||
        typeof entry.replacement !== "string",
    )
  ) {
    throw new Error("QA evidence redactions must be value/replacement pairs");
  }
  const resolvedRedactions = redactions.filter((entry) => entry.value.length > 0);

  const resolvedMaxLogBytes = positiveInteger(
    maxLogBytes ?? process.env.HEBBIAN_QA_ARTIFACT_MAX_LOG_BYTES,
    DEFAULT_MAX_LOG_BYTES,
    maxLogBytes === undefined
      ? "HEBBIAN_QA_ARTIFACT_MAX_LOG_BYTES"
      : "maxLogBytes",
  );
  const resolvedMaxStatusBytes = positiveInteger(
    maxStatusBytes,
    DEFAULT_MAX_STATUS_BYTES,
    "maxStatusBytes",
  );
  const resolvedRunId = runId ?? makeRunId(qaName, now);
  if (!/^[a-zA-Z0-9._-]+$/.test(resolvedRunId)) {
    throw new Error("QA evidence runId contains unsafe characters");
  }
  if (typeof dirty !== "boolean") {
    throw new Error("QA evidence dirty flag must be boolean");
  }
  const resolvedStartedAtMs =
    startedAtMs === undefined ? undefined : Number(startedAtMs);
  if (
    resolvedStartedAtMs !== undefined &&
    (!Number.isSafeInteger(resolvedStartedAtMs) || resolvedStartedAtMs < 0)
  ) {
    throw new Error("QA evidence startedAtMs must be a non-negative integer");
  }

  fs.mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const runDirectory = path.join(artifactRoot, resolvedRunId);
  fs.mkdirSync(runDirectory, { mode: 0o700 });

  const files = [];
  for (const filename of QA_EVIDENCE_FILENAMES.slice(0, 2)) {
    const source = sources[filename];
    if (typeof source !== "string" || !fs.existsSync(source)) continue;
    const evidence = readLog(source, resolvedMaxLogBytes, resolvedRedactions);
    writePrivateFile(path.join(runDirectory, filename), evidence.contents);
    files.push({
      name: filename,
      bytes: Buffer.byteLength(evidence.contents),
      sourceBytes: evidence.sourceBytes,
      truncated: evidence.truncated,
    });
  }

  const status = readStatus(sources["last-status.json"], {
    qaName,
    exitCode,
    maxStatusBytes: resolvedMaxStatusBytes,
    redactions: resolvedRedactions,
    qaLayer,
    failureClass,
  });
  const qaExecution =
    sanitizeQaExecution(status.qaExecution) ??
    sanitizeQaExecution({
      schemaVersion: 1,
      layer: qaLayer,
      phaseDurationsMs: {},
      failureClass,
    });
  const statusContents = `${JSON.stringify(status, null, 2)}\n`;
  writePrivateFile(
    path.join(runDirectory, "last-status.json"),
    statusContents,
  );
  files.push({
    name: "last-status.json",
    bytes: Buffer.byteLength(statusContents),
    truncated: status.available === false,
  });

  const manifest = {
    schemaVersion: 1,
    runId: resolvedRunId,
    qaName: redactQaEvidenceText(qaName, resolvedRedactions),
    result: "failed",
    exitCode,
    createdAt: now.toISOString(),
    durationMs:
      resolvedStartedAtMs === undefined
        ? undefined
        : Math.max(0, now.getTime() - resolvedStartedAtMs),
    revision: {
      commit: optionalGitObject(commitSha, "commitSha"),
      tree: optionalGitObject(treeSha, "treeSha"),
      dirty,
    },
    limits: {
      maxLogBytes: resolvedMaxLogBytes,
      maxStatusBytes: resolvedMaxStatusBytes,
    },
    ...(qaExecution ? { qaExecution } : {}),
    files,
  };
  writePrivateFile(
    path.join(runDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { runDirectory, manifest };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid QA evidence argument: ${key ?? "<missing>"}`);
    }
    values[key.slice(2)] = value;
  }
  return values;
}

function runCli() {
  const options = parseArguments(process.argv.slice(2));
  const bundle = createQaEvidenceBundle({
    result: options.result,
    qaName: options["qa-name"],
    exitCode: Number(options["exit-code"]),
    artifactRoot:
      options["artifact-root"] ??
      process.env.HEBBIAN_QA_ARTIFACT_ROOT ??
      path.resolve("artifacts/qa"),
    sources: {
      "tauri-dev.log": options["tauri-log"],
      "client.log": options["client-log"],
      "last-status.json": options["last-status"],
    },
    commitSha: options.commit,
    treeSha: options.tree,
    dirty: options.dirty === "true",
    startedAtMs: options["started-at-ms"],
    qaLayer: options["qa-layer"],
    failureClass: options["failure-class"],
    redactions: [
      {
        value: options["state-root"] ?? "",
        replacement: "<QA_STATE_ROOT>",
      },
      {
        value: options["developer-home"] ?? "",
        replacement: "<DEVELOPER_HOME>",
      },
    ],
  });
  if (bundle) process.stdout.write(`${bundle.runDirectory}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runCli();
  } catch (error) {
    console.error(`QA evidence bundle failed: ${error}`);
    process.exitCode = 1;
  }
}
