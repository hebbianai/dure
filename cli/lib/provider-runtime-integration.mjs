import { spawnSync } from "node:child_process";

// Native terminal launches of Claude and Codex read the Dure-managed
// integration document only a Dure app publishes. The control plane owns the
// check; this module names its requirement tokens and runs it for doctor.

export const PROVIDER_RUNTIME_INTEGRATION_FILE = "managed-provider-integrations-v1.json";

const REQUIREMENT_TEXT = Object.freeze({
  integration_channel_invalid: "DURE_APP_CHANNEL does not name a valid channel",
  integration_directory_unsafe: "its directory must be owned by this user and closed to others",
  integration_document_missing: "no Dure app has published it",
  integration_document_unsafe: "it must be a regular file owned by this user and closed to others",
  integration_document_invalid: "it is not a valid integration document",
  integration_channel_mismatch: "it was published for another Dure channel",
  integration_provider_unpublished: "it does not list this provider",
  integration_reference_unavailable:
    "a file it lists for this provider is missing, not owner-only, or outside the Dure directory",
});

const INTEGRATION_FILE =
  /^(?:channels\/[a-z0-9-]{1,64}\/)?managed-provider-integrations-v1\.json$/;

export function validIntegrationFile(value) {
  return typeof value === "string" && INTEGRATION_FILE.test(value);
}

/** Why the integration check failed, for a known requirement token. */
export function integrationRequirementText(requirement) {
  return Object.hasOwn(REQUIREMENT_TEXT, requirement)
    ? REQUIREMENT_TEXT[requirement]
    : null;
}

const STATUS_PROVIDERS = Object.freeze(["claude", "codex"]);

function validStatus(report, providers) {
  return (
    report?.schemaVersion === 1 &&
    report.kind === "dure.provider_runtime_integration_status" &&
    (report.channel === null || typeof report.channel === "string") &&
    (report.document === null || typeof report.document === "string") &&
    Array.isArray(report.providers) &&
    report.providers.length === providers.length &&
    report.providers.every(
      (entry, index) =>
        entry?.providerId === providers[index] &&
        ((entry.status === "current" && entry.requirement === null) ||
          (entry.status === "unavailable" &&
            typeof entry.requirement === "string" &&
            /^[a-z0-9_]{1,64}$/.test(entry.requirement))),
    )
  );
}

/**
 * Runs the control plane's own integration check for doctor. Returns null
 * when this CLI's control plane cannot run it (not installed, or older than
 * the check), so doctor reports the check as unknown rather than failing.
 */
export function inspectProviderRuntimeIntegrations({
  controlPlanePath,
  dureHome,
  providers = STATUS_PROVIDERS,
  environment = process.env,
  run = spawnSync,
}) {
  let result;
  try {
    result = run(
      controlPlanePath,
      [
        "provider-integration-status",
        "--home",
        dureHome,
        ...providers.flatMap((provider) => ["--provider", provider]),
      ],
      {
        encoding: "utf8",
        env: environment,
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    return null;
  }
  if (result?.error || result?.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  return validStatus(report, providers) ? report : null;
}
