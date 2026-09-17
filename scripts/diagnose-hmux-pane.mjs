#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appControlDirectory,
  resolveAppChannel,
} from "./lib/app-channel.mjs";

const INCIDENT_MARKER =
  /closed|failed|error|stalled|backlog|backpressure|resource_limit|timeout|gap|conflict|unavailable|exhausted/i;
const RECEIPT_EVENT_LIMIT = 40;

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function incidentEvent(event) {
  return (
    ["disconnected", "error", "stale"].includes(event?.state) ||
    INCIDENT_MARKER.test(event?.code ?? "")
  );
}

function safeRenderer(renderer) {
  if (!renderer || typeof renderer !== "object") return undefined;
  const keys = [
    "queuedWrites",
    "queuedBytes",
    "activeBytes",
    "activeWriteAgeMs",
    "completedWrites",
    "completedBytes",
    "droppedQueuedWrites",
    "droppedQueuedBytes",
    "snapshotCollapses",
    "refreshes",
    "refreshErrors",
    "writeErrors",
    "staleActiveWrites",
    "firstWriteLatencyMs",
    "lastWriteLatencyMs",
    "maxWriteLatencyMs",
    "peakBufferedBytes",
  ];
  const safe = {};
  for (const key of keys) {
    if (typeof renderer[key] === "number" || renderer[key] === null) {
      safe[key] = renderer[key];
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function safeEvent(event) {
  const details = event?.details ?? {};
  return {
    timestamp: nonEmpty(event?.timestamp),
    lastTimestamp: nonEmpty(event?.lastTimestamp),
    repeatCount:
      Number.isSafeInteger(event?.repeatCount) && event.repeatCount > 1
        ? event.repeatCount
        : undefined,
    event: nonEmpty(event?.event),
    state: nonEmpty(event?.state),
    code: nonEmpty(event?.code),
    paneId: nonEmpty(event?.paneId),
    observationScope:
      details.observationScope === "background" ? "background" : undefined,
    retryDirective:
      details.retryDirective === "never" ||
      details.retryDirective === "reconnect" ||
      details.retryDirective === "retry_after_resync"
        ? details.retryDirective
        : undefined,
    phase: nonEmpty(details.phase),
    errorType: nonEmpty(details.errorType),
    consumerId: nonEmpty(details.consumerId),
    windowLabel: nonEmpty(details.windowLabel),
    webviewInstanceId: nonEmpty(details.webviewInstanceId),
    webviewStartedAt: nonEmpty(details.webviewStartedAt),
    webviewUptimeMs:
      typeof details.webviewUptimeMs === "number"
        ? details.webviewUptimeMs
        : undefined,
    onScreen:
      typeof details.onScreen === "boolean" ? details.onScreen : undefined,
    presentationActive:
      typeof details.presentationActive === "boolean"
        ? details.presentationActive
        : undefined,
    controlActive:
      typeof details.controlActive === "boolean"
        ? details.controlActive
        : undefined,
    hostBuildVersion: nonEmpty(details.hostBuildVersion),
    terminalEpoch:
      nonEmpty(details.terminalEpoch) ??
      nonEmpty(details.controlPlaneTerminalEpoch),
    receivedSequence:
      nonEmpty(details.receivedSequence) ??
      nonEmpty(details.controlPlaneOutputSeq),
    presentedSequence: nonEmpty(details.presentedSequence),
    renderer: safeRenderer(details.renderer),
  };
}

export function webviewRecoveryTimeline(events) {
  const generations = new Map();
  for (const event of events) {
    const instanceId = nonEmpty(event?.details?.webviewInstanceId);
    if (!instanceId) continue;
    const previous = generations.get(instanceId) ?? {
      webviewInstanceId: instanceId,
    };
    const next = {
      ...previous,
      startedAt:
        nonEmpty(event.details?.webviewStartedAt) ?? previous.startedAt,
      firstEventAt: previous.firstEventAt ?? nonEmpty(event.timestamp),
      latestEventAt: nonEmpty(event.timestamp) ?? previous.latestEventAt,
    };
    if (
      event.event === "transport" &&
      event.state === "mounted" &&
      !next.firstTransportMountedAt
    ) {
      next.firstTransportMountedAt = nonEmpty(event.timestamp);
    }
    generations.set(instanceId, next);
  }
  return [...generations.values()].sort((left, right) =>
    String(left.startedAt ?? left.firstEventAt).localeCompare(
      String(right.startedAt ?? right.firstEventAt),
    ),
  );
}

function latestMountCohort(events) {
  const members = new Map();
  for (const event of events) {
    const consumerId = nonEmpty(event?.details?.consumerId);
    if (!consumerId) continue;
    const previous = members.get(consumerId) ?? {
      consumerId,
      paneId: event.paneId,
    };
    const next = {
      ...previous,
      consumerId,
      paneId: event.paneId ?? previous.paneId,
      windowLabel: event.details?.windowLabel ?? previous.windowLabel,
      webviewInstanceId:
        event.details?.webviewInstanceId ?? previous.webviewInstanceId,
      latestAt: event.timestamp ?? previous.latestAt,
    };
    for (const key of ["onScreen", "presentationActive", "controlActive"]) {
      if (typeof event.details?.[key] === "boolean") {
        next[key] = event.details[key];
      }
    }
    if (event.event === "transport") next.transportState = event.state;
    members.set(consumerId, next);
  }
  const recent = [...members.values()].sort((left, right) =>
    String(left.paneId).localeCompare(String(right.paneId)),
  );
  const latestByPane = new Map();
  for (const member of recent) {
    const previous = latestByPane.get(member.paneId);
    if (
      !previous ||
      Date.parse(member.latestAt ?? "") >= Date.parse(previous.latestAt ?? "")
    ) {
      latestByPane.set(member.paneId, member);
    }
  }
  return {
    lastObservedActive: [...latestByPane.values()]
      .filter((member) =>
        ["mounted", "retained"].includes(member.transportState),
      )
      .sort((left, right) =>
        String(left.paneId).localeCompare(String(right.paneId)),
      ),
    recent,
  };
}

function simultaneousClosures(incidents) {
  const closures = incidents
    .filter((event) => event.code === "hmux_transport_closed")
    .map(safeEvent)
    .filter((event) => event.timestamp);
  const groups = [];
  for (const event of closures) {
    const at = Date.parse(event.timestamp);
    const group = groups.find(
      (candidate) => Math.abs(candidate.unixMs - at) <= 100,
    );
    if (group) {
      group.events.push(event);
    } else {
      groups.push({ unixMs: at, events: [event] });
    }
  }
  return groups
    .filter((group) => group.events.length > 1)
    .map((group) => ({
      timestamp: new Date(group.unixMs).toISOString(),
      panes: [...new Set(group.events.map((event) => event.paneId))].sort(),
      consumers: [
        ...new Set(group.events.map((event) => event.consumerId)),
      ].sort(),
    }));
}

function safeSession(session) {
  return {
    sessionId: session.session_id,
    sessionName: session.session_name,
    workspaceId: session.workspace_id,
    sessionClass: session.session_class,
    lifecycle: session.lifecycle,
    providerId: session.provider_id,
    runtimeHost: session.runtime_host,
    hostBuildVersion: session.host_build_version,
    terminalEpoch: session.terminal_epoch,
    manifestReadyOutputSeq: session.output_seq,
    channelEpoch: session.channel_epoch,
    hostInstanceId: session.host_instance_id,
    hostProcess: session.host_process,
    providerProcess: session.provider_process,
    capabilities: session.capabilities,
    endpointKind: session.endpoint?.kind,
    createdUnixMs: session.created_unix_ms,
    lifecycleChangedUnixMs: session.lifecycle_changed_unix_ms,
    exit: session.exit,
  };
}

export function resolveSession(sessions, target) {
  const exactId = sessions.filter((session) => session.session_id === target);
  if (exactId.length === 1) return exactId[0];
  const named = sessions.filter((session) => session.session_name === target);
  const readyNamed = named.filter((session) => session.lifecycle === "ready");
  if (readyNamed.length === 1) return readyNamed[0];
  if (named.length === 1) return named[0];
  const prefixed = sessions.filter((session) =>
    session.session_id?.startsWith(target),
  );
  if (prefixed.length === 1) return prefixed[0];
  const count = Math.max(named.length, prefixed.length);
  throw new Error(
    count > 1
      ? `Hmux session target is ambiguous: ${target}`
      : `Hmux session was not found: ${target}`,
  );
}

export function buildDiagnosticReceipt({
  session,
  probe,
  snapshot,
  journal,
  hmuxCliVersion,
  installedBuildVersion,
  generatedAt = new Date().toISOString(),
}) {
  const events = (journal?.events ?? []).filter(
    (event) => event.sessionId === session.session_id,
  );
  const incidents = (
    journal?.schemaVersion === 2
      ? journal.incidents ?? []
      : events.filter(incidentEvent)
  ).filter((event) => event.sessionId === session.session_id);
  const mountCohort = latestMountCohort(events);
  const webviewInstances = [
    ...new Set(
      events
        .map((event) => nonEmpty(event?.details?.webviewInstanceId))
        .filter(Boolean),
    ),
  ].sort();
  const simultaneousTransportClosures = simultaneousClosures(incidents);
  const webviewRecoveries = webviewRecoveryTimeline(events);
  const hostHealthy = probe?.status === "healthy";
  const snapshotMetadata = snapshot
    ? {
        schemaVersion: snapshot.schemaVersion,
        sessionId: snapshot.sessionId,
        workspaceId: snapshot.workspaceId,
        terminalEpoch: snapshot.terminalEpoch,
        sequenceThrough: snapshot.sequenceThrough,
        columns: snapshot.columns,
        rows: snapshot.rows,
        alternateScreen: snapshot.alternateScreen,
        cursorVisible: snapshot.cursorVisible,
        truncated: snapshot.truncated,
      }
    : undefined;

  return {
    schemaVersion: 1,
    generatedAt,
    target: safeSession(session),
    live: {
      probe: probe
        ? {
            schemaVersion: probe.schemaVersion,
            sessionId: probe.sessionId,
            workspaceId: probe.workspaceId,
            status: probe.status,
          }
        : undefined,
      snapshot: snapshotMetadata,
    },
    build: {
      hmuxCliVersion,
      installedBuildVersion,
      hostBuildVersion: session.host_build_version,
      hostDiffersFromInstalled:
        Boolean(installedBuildVersion && session.host_build_version) &&
        installedBuildVersion !== session.host_build_version,
    },
    appEvidence: {
      journalSchemaVersion: journal?.schemaVersion,
      journalUpdatedAt: journal?.updatedAt,
      retainedEventCount: events.length,
      retainedIncidentCount: incidents.length,
      eventWindow: {
        first: events[0]?.timestamp,
        last: events.at(-1)?.timestamp,
      },
      webviewInstances,
      webviewRecoveries,
      mountCohort,
      simultaneousTransportClosures,
      incidents: incidents.slice(-RECEIPT_EVENT_LIMIT).map(safeEvent),
      recentTransitions: events
        .filter((event) =>
          ["connection", "health", "transport"].includes(event.event),
        )
        .slice(-RECEIPT_EVENT_LIMIT)
        .map(safeEvent),
    },
    assessment: {
      hostHealthy,
      supportedReplicaCohortObserved:
        new Set(
          mountCohort.lastObservedActive.map((member) => member.paneId),
        ).size > 1,
      appGenerationChangeObserved: webviewInstances.length > 1,
      appTransportInterruptionWithLiveHost:
        hostHealthy && simultaneousTransportClosures.length > 0,
      note:
        "Assessment fields correlate retained evidence; they do not prove an unobserved process restart.",
    },
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const appChannel = resolveAppChannel();
  let journalPath = join(
    process.env.HEBBIAN_HOME ||
      appControlDirectory(homedir(), appChannel),
    "hmux-connection-diagnostics.json",
  );
  let pretty = true;
  let target;
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--") {
      continue;
    } else if (argument === "--journal") {
      journalPath = args.shift();
    } else if (argument === "--compact") {
      pretty = false;
    } else if (!target) {
      target = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  if (!target) {
    throw new Error(
      "Usage: node scripts/diagnose-hmux-pane.mjs <session-name-or-id> [--journal <path>] [--compact]",
    );
  }
  return { target, journalPath, pretty };
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveHmuxBinary() {
  const candidates = [
    process.env.HMUX_BIN,
    join(homedir(), ".local", "bin", "hmux"),
    "hmux",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "hmux" || executable(candidate)) return candidate;
  }
  throw new Error("hmux executable was not found; set HMUX_BIN");
}

function hmuxJson(binary, args, execute = execFileSync) {
  return JSON.parse(
    execute(binary, ["--json", ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
}

export function optionalHmuxJson(binary, args, execute = execFileSync) {
  try {
    return hmuxJson(binary, args, execute);
  } catch (error) {
    const stdout = error?.stdout;
    if (typeof stdout === "string" || Buffer.isBuffer(stdout)) {
      try {
        return JSON.parse(stdout.toString());
      } catch {
        // Fall through to the bounded diagnostic below.
      }
    }
    return {
      status: "unavailable",
      code: "hmux_diagnostic_command_failed",
      command: args[0],
      exitCode: error?.status,
    };
  }
}

function installedBuild(binary) {
  try {
    const resolved = realpathSync(binary);
    const binDirectory = dirname(resolved);
    const versionDirectory = dirname(binDirectory);
    return basename(dirname(versionDirectory)) === "versions"
      ? basename(versionDirectory)
      : undefined;
  } catch {
    return undefined;
  }
}

function readJournal(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { schemaVersion: 0, events: [], incidents: [] };
  }
}

function main() {
  const { target, journalPath, pretty } = parseArgs(process.argv.slice(2));
  const binary = resolveHmuxBinary();
  const sessions = hmuxJson(binary, ["ls"]);
  const session = resolveSession(sessions, target);
  const receipt = buildDiagnosticReceipt({
    session,
    probe: optionalHmuxJson(binary, ["session", "probe", session.session_id]),
    snapshot: optionalHmuxJson(binary, [
      "session",
      "snapshot",
      session.session_id,
    ]),
    journal: readJournal(journalPath),
    hmuxCliVersion: execFileSync(binary, ["--version"], {
      encoding: "utf8",
    }).trim(),
    installedBuildVersion: installedBuild(binary),
  });
  process.stdout.write(`${JSON.stringify(receipt, null, pretty ? 2 : 0)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
