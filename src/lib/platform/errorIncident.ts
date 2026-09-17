import { configuredFrontendAppChannel } from "@/lib/platform/appChannel";
import { frontendRuntimeObservation } from "@/lib/platform/frontendRuntimeObservation";

const ERROR_REPORT_KIND = "dure.error-report" as const;
const ERROR_REPORT_SCHEMA_VERSION = 1 as const;
const ERROR_REPORT_REDACTION_VERSION = 1 as const;

const MESSAGE_LIMIT = 4 * 1024;
const STACK_LIMIT = 16 * 1024;
const COMPONENT_STACK_LIMIT = 8 * 1024;
const NOTES_LIMIT = 4 * 1024;
const TOKEN_LIMIT = 96;
const REDACTED = "[redacted]";

export type ErrorReportSurface =
  | "main"
  | "diff-window"
  | "session-window"
  | "source-control-window"
  | "popout-window";
export type ErrorIncidentBoundary =
  | "app"
  | "diff-window"
  | "session-window"
  | "source-control-window"
  | "popout-window"
  | "entry";

export interface ErrorDiagnosticReference {
  kind: "backend_receipt" | "hmux_connection" | "render";
  code: string;
  reference?: string;
}

export interface ErrorIncident {
  boundary: ErrorIncidentBoundary;
  surface: ErrorReportSurface;
  occurredAt: string;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  componentStack?: string;
  diagnostics: ErrorDiagnosticReference[];
}

export interface ErrorReportAppMetadata {
  frontendBuildId: string;
  channel: string;
}

export interface ErrorReportBundleV1 {
  schemaVersion: typeof ERROR_REPORT_SCHEMA_VERSION;
  kind: typeof ERROR_REPORT_KIND;
  createdAt: string;
  app: ErrorReportAppMetadata;
  incident: {
    fingerprint: string;
    boundary: ErrorIncidentBoundary;
    surface: ErrorReportSurface;
    occurredAt: string;
    error: {
      name: string;
      message: string;
      stack?: string;
    };
    componentStack?: string;
  };
  diagnostics: ErrorDiagnosticReference[];
  reproduction: {
    notes: string;
  };
  privacy: {
    redactionVersion: typeof ERROR_REPORT_REDACTION_VERSION;
    redactionMarker: typeof REDACTED;
    excludedByDefault: [
      "terminal_scrollback",
      "prompts",
      "credentials",
      "environment_values",
      "absolute_paths",
      "attachments",
    ];
  };
}

export interface BuildErrorReportOptions {
  notes?: string;
  createdAt?: string;
  app?: ErrorReportAppMetadata;
}

function bounded(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n…[truncated]`;
}

function redactCredentialAssignments(value: string): string {
  return value.replace(
    /(["']?)(password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential)\1(\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}\]]+)/gi,
    (_match, quote: string, key: string, separator: string) =>
      `${quote}${key}${quote}${separator}"${REDACTED}"`,
  );
}

function redactEnvironmentValues(value: string): string {
  return value.replace(
    /\b([A-Z][A-Z0-9_]{1,63})=("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/g,
    (_match, key: string) => `${key}=${REDACTED}`,
  );
}

function redactWindowsPaths(value: string): string {
  return value.replace(
    /(^|[\s([{"'=])(?:[A-Za-z]:\\|\\\\[^\\\s"'<>]+\\)(?:[^\\\s:"'<>]+\\)*([^\\\s:"'<>]+)(:\d+(?::\d+)?)?/gm,
    (_match, prefix: string, basename: string, position = "") =>
      `${prefix}[path]\\${basename}${position}`,
  );
}

function redactPosixPaths(value: string): string {
  const withoutFileScheme = value.replace(/\bfile:\/\/(?=\/)/gi, "");
  const withoutHomes = withoutFileScheme.replace(
    /(^|[\s([{"'=])~\/(?:[^/\s:?#"'<>]+\/)+([^/\s:?#"'<>]+)(:\d+(?::\d+)?)?/gm,
    (_match, prefix: string, basename: string, position = "") =>
      `${prefix}[path]/${basename}${position}`,
  );
  return withoutHomes.replace(
    /(^|[\s([{"'=])(\/(?:[^/\s:?#"'<>]+\/)+)([^/\s:?#"'<>]+)(:\d+(?::\d+)?)?/gm,
    (_match, prefix: string, _directories: string, basename: string, position = "") =>
      `${prefix}[path]/${basename}${position}`,
  );
}

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    const disallowed =
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f;
    return disallowed ? "�" : character;
  }).join("");
}

/** Redact arbitrary exception text before it can enter a report bundle.
 *
 * This is intentionally lossy. The report keeps source basenames and stack
 * positions for debugging, but never keeps complete filesystem paths, URL
 * authorities or queries, credential-shaped values, environment values, or
 * email addresses.
 */
export function redactErrorReportText(value: string, maximum = STACK_LIMIT): string {
  let redacted = replaceControlCharacters(value.replace(/\r\n?/g, "\n"))
    .replace(
      /\b(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?|tauri:\/\/localhost)(\/[^\s?#)"']*)?(?:[?#][^\s)"']*)?/gi,
      (_match, pathname = "") => `app://${String(pathname).replace(/^\/+/, "")}`,
    )
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"')\]]+/gi, "[url]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
      REDACTED,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      REDACTED,
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]");
  redacted = redactCredentialAssignments(redacted);
  redacted = redactEnvironmentValues(redacted);
  redacted = redactWindowsPaths(redacted);
  redacted = redactPosixPaths(redacted);
  return bounded(redacted, maximum);
}

function safeToken(value: string, fallback: string): string {
  const candidate = value.trim();
  return candidate.length > 0 &&
    candidate.length <= TOKEN_LIMIT &&
    /^[A-Za-z0-9._:+-]+$/.test(candidate)
    ? candidate
    : fallback;
}

function safeTimestamp(value: string, fallback: string): string {
  return Number.isNaN(Date.parse(value)) ? fallback : new Date(value).toISOString();
}

function errorDetails(error: unknown): ErrorIncident["error"] {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "Unknown error",
      stack: error.stack,
    };
  }
  return {
    name: "NonErrorThrown",
    message: String(error),
  };
}

export function createErrorIncident({
  boundary,
  surface,
  error,
  componentStack,
  diagnostics = [],
  occurredAt = new Date().toISOString(),
}: {
  boundary: ErrorIncidentBoundary;
  surface: ErrorReportSurface;
  error: unknown;
  componentStack?: string | null;
  diagnostics?: ErrorDiagnosticReference[];
  occurredAt?: string;
}): ErrorIncident {
  return {
    boundary,
    surface,
    occurredAt,
    error: errorDetails(error),
    componentStack: componentStack || undefined,
    diagnostics: diagnostics.map((reference) => ({ ...reference })),
  };
}

function redactedDiagnosticReference(
  reference: ErrorDiagnosticReference,
): ErrorDiagnosticReference {
  const safe: ErrorDiagnosticReference = {
    kind: reference.kind,
    code: safeToken(reference.code, "invalid_diagnostic_code"),
  };
  if (reference.reference) {
    safe.reference = safeToken(reference.reference, "redacted_reference");
  }
  return safe;
}

function normalizeFingerprintEvidence(value: string): string {
  return value
    .toLowerCase()
    .replace(/:\d+(?::\d+)?/g, ":#:#")
    .replace(/\b0x[0-9a-f]+\b/g, "0x#")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
      "uuid",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function incidentFingerprint(incident: ErrorReportBundleV1["incident"]): string {
  const evidence = [
    incident.boundary,
    incident.surface,
    incident.error.name,
    incident.error.message,
    incident.error.stack ?? "",
    incident.componentStack ?? "",
  ].join("\n");
  return `error-v1-${fnv1a64(normalizeFingerprintEvidence(evidence))}`;
}

export function currentErrorReportAppMetadata(): ErrorReportAppMetadata {
  const configuredChannel = configuredFrontendAppChannel();
  return {
    frontendBuildId: safeToken(frontendRuntimeObservation.buildId, "unknown-build"),
    channel: safeToken(
      configuredChannel || (import.meta.env.DEV ? "development" : "stable"),
      "unknown-channel",
    ),
  };
}

export function buildErrorReportBundle(
  source: ErrorIncident,
  options: BuildErrorReportOptions = {},
): ErrorReportBundleV1 {
  const fallbackTimestamp = new Date(0).toISOString();
  const createdAt = safeTimestamp(
    options.createdAt ?? new Date().toISOString(),
    fallbackTimestamp,
  );
  const incident: ErrorReportBundleV1["incident"] = {
    fingerprint: "",
    boundary: source.boundary,
    surface: source.surface,
    occurredAt: safeTimestamp(source.occurredAt, createdAt),
    error: {
      name: redactErrorReportText(source.error.name, 160),
      message: redactErrorReportText(source.error.message, MESSAGE_LIMIT),
      ...(source.error.stack
        ? { stack: redactErrorReportText(source.error.stack, STACK_LIMIT) }
        : {}),
    },
    ...(source.componentStack
      ? {
          componentStack: redactErrorReportText(
            source.componentStack,
            COMPONENT_STACK_LIMIT,
          ),
        }
      : {}),
  };
  incident.fingerprint = incidentFingerprint(incident);
  const app = options.app ?? currentErrorReportAppMetadata();
  return {
    schemaVersion: ERROR_REPORT_SCHEMA_VERSION,
    kind: ERROR_REPORT_KIND,
    createdAt,
    app: {
      frontendBuildId: safeToken(app.frontendBuildId, "unknown-build"),
      channel: safeToken(app.channel, "unknown-channel"),
    },
    incident,
    diagnostics: source.diagnostics.map(redactedDiagnosticReference),
    reproduction: {
      notes: redactErrorReportText(options.notes ?? "", NOTES_LIMIT),
    },
    privacy: {
      redactionVersion: ERROR_REPORT_REDACTION_VERSION,
      redactionMarker: REDACTED,
      excludedByDefault: [
        "terminal_scrollback",
        "prompts",
        "credentials",
        "environment_values",
        "absolute_paths",
        "attachments",
      ],
    },
  };
}

export function serializeErrorReportBundle(bundle: ErrorReportBundleV1): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
