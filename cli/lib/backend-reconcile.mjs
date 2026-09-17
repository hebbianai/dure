const API_VERSION = "dure.backend-reconcile/v1";

function reconciliationReceipt(selection) {
  return {
    schemaVersion: 1,
    apiVersion: API_VERSION,
    kind: "dure.backend.reconcile",
    status: selection.managedLocal ? "ready" : "external",
    profile: {
      id: selection.profile.id,
      source: selection.source,
      transportKind: selection.profile.transport.kind,
      ...(selection.managedLocal
        ? { managedAuthority: selection.profile }
        : {}),
    },
    authority: {
      backendId: selection.profile.expected.backendId,
      generation: selection.profile.expected.generation,
    },
  };
}

function reconciliationError(error) {
  return {
    schemaVersion: 1,
    apiVersion: API_VERSION,
    kind: "dure.backend.reconcile_error",
    error: {
      code:
        typeof error?.code === "string"
          ? error.code
          : "backend_reconcile_failed",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export async function runBackendReconcileFromCli({
  explicitId,
  json,
  prepareBackendProfile,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  try {
    const report = reconciliationReceipt(
      await prepareBackendProfile(explicitId),
    );
    stdout.write(
      json
        ? `${JSON.stringify(report)}\n`
        : `Backend ${report.profile.id} is ${report.status} (${report.authority.generation}).\n`,
    );
    return 0;
  } catch (error) {
    const report = reconciliationError(error);
    if (json) {
      stderr.write(`${JSON.stringify(report)}\n`);
    } else {
      stderr.write(`\x1b[31m${report.error.code}: ${report.error.message}\x1b[0m\n`);
    }
    return 2;
  }
}
