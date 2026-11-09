import { BackendProfileError, loadBackendProfiles } from "./backend-profiles.mjs";
import {
  SESSION_QUERY_SCHEMA_VERSION,
  SESSION_TABLE_HEADER,
  sessionPageNotice,
  sessionTableRow,
} from "./session-query.mjs";

const LIST_KIND = "dure.sessions.list";
const NO_CATALOG_BACKEND_ID = "local";

function backendEntry({ backendProfileId, report }) {
  if (report.kind !== LIST_KIND) {
    return {
      backendProfileId,
      status: "error",
      durationMs: report.durationMs,
      error: report.error,
    };
  }
  return {
    backendProfileId,
    status: "ok",
    durationMs: report.durationMs,
    source: report.source,
    inventoryComplete: report.inventoryComplete,
    observationComplete: report.observationComplete,
    truncation: report.truncation,
    ...(report.pagination ? { pagination: report.pagination } : {}),
  };
}

function mergeBackendReports(results, startedAt) {
  const listed = results.filter(({ report }) => report.kind === LIST_KIND);
  const complete = listed.length === results.length;
  const omittedCount = listed.reduce(
    (total, { report }) => total + report.truncation.omittedCount,
    0,
  );
  return {
    schemaVersion: SESSION_QUERY_SCHEMA_VERSION,
    apiVersion: "dure.sessions/v1",
    kind: LIST_KIND,
    complete,
    inventoryComplete: complete && listed.every(({ report }) => report.inventoryComplete),
    observationComplete: listed.every(({ report }) => report.observationComplete),
    partial: !complete || listed.some(({ report }) => report.partial),
    observedAtMs: Date.now(),
    durationMs: Math.max(0, Date.now() - startedAt),
    source: { kind: "all_backends", appDaemonRequired: false },
    limits: results[0].report.limits,
    truncation: {
      items: listed.some(({ report }) => report.truncation.items),
      omittedCount,
    },
    backends: results.map(backendEntry),
    sessions: listed.flatMap(({ backendProfileId, report }) =>
      report.sessions.map((session) => ({ backendProfileId, ...session })),
    ),
  };
}

/** Each backend answers or fails on its own, so one that is down cannot hide
 * the others. A catalog that does not exist yet means only this machine, read
 * through Hmux as plain `dure ls` does, so listing never starts a service just
 * to write one. A catalog that exists but cannot be read is an error: guessing
 * "this machine only" would silently drop every remote backend. */
export async function collectAllBackendsSessionQuery({
  query,
  collect,
  resolveBackend,
  loadCatalog = loadBackendProfiles,
}) {
  const startedAt = Date.now();
  let profiles;
  try {
    profiles = loadCatalog().profiles;
  } catch (error) {
    if (
      !(error instanceof BackendProfileError) ||
      error.code !== "backend_profiles_config_missing"
    ) {
      return collect({ ...query, backend: { error } });
    }
  }
  const listBackend = async (id) => {
    try {
      return await collect({ ...query, backend: await resolveBackend(id) });
    } catch (error) {
      // Remote runtimes update independently, so a response this client
      // cannot process has to stay that one backend's failure.
      return collect({ ...query, backend: { error } });
    }
  };
  const results = profiles
    ? await Promise.all(
        profiles.map(async ({ id }) => ({
          backendProfileId: id,
          report: await listBackend(id),
        })),
      )
    : [
        {
          backendProfileId: NO_CATALOG_BACKEND_ID,
          report: await collect({ ...query, backend: null }),
        },
      ];
  return mergeBackendReports(results, startedAt);
}

function backendNotice(backend) {
  if (backend.status === "error") {
    const { code, message } = backend.error;
    return `Backend ${backend.backendProfileId} unavailable: ${code}${message ? `: ${message}` : ""}`;
  }
  const notice = sessionPageNotice(backend);
  return notice ? `${backend.backendProfileId}: ${notice}` : null;
}

export function formatAllBackendsSessionQuery(report) {
  const unavailable = report.backends.some((backend) => backend.status === "error");
  // An unreachable backend may still be running sessions, so an empty table
  // only means "no sessions" when every backend answered.
  const table = report.sessions.length > 0
    ? [
        `BACKEND\t${SESSION_TABLE_HEADER}`,
        ...report.sessions.map(
          (session) => `${session.backendProfileId}\t${sessionTableRow(session)}`,
        ),
      ]
    : unavailable ? [] : ["No Dure sessions."];
  return [...table, ...report.backends.map(backendNotice).filter(Boolean)].join("\n");
}
