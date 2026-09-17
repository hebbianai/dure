import { validExecutionProfile } from "./agent-spawn-query.mjs";
import { isProviderEffortSelection, isProviderModelSelection } from "./contracts/provider-launch-selection.mjs";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { validProjectId, validProjectPath } from "./project-contract.mjs";

export const SCHEDULE_CLIENT_SCHEMA_VERSION = 1;
export const DEFAULT_SCHEDULE_COMMAND_DEADLINE_MS = 2_500;
export const MAX_SCHEDULE_COMMAND_DEADLINE_MS = 10_000;
export const MAX_SCHEDULE_ITEMS = 128;
export const MAX_SCHEDULE_OCCURRENCES = 256;
export const MAX_SCHEDULE_OUTPUT_BYTES = 256 * 1024;

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PERMISSION_MODES = new Set(["default", "skip_permissions"]);
const LAUNCH_STATES = new Set(["pending", "started", "failed"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, keys) {
  return (
    record(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function boundedText(value, maximumBytes, { multiline = false } = {}) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        (codePoint <= 0x1f && !(multiline && ["\n", "\t"].includes(character))) ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      );
    })
  );
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validRunTemplate(value, { allowProjectPath = false } = {}) {
  if (!record(value)) return false;
  const selector = value.projectPath === undefined ? "projectId" : "projectPath";
  return (
    onlyKeys(value, [selector, "providerId", "prompt",
      ...(value.permissionMode === undefined ? [] : ["permissionMode"]),
      ...(value.model === undefined ? [] : ["model"]),
      ...(value.effort === undefined ? [] : ["effort"]),
      ...(value.executionProfile === undefined ? [] : ["executionProfile"]),
      ...(value.worktree === undefined ? [] : ["worktree"]),
    ]) &&
    (selector === "projectId"
      ? validProjectId(value.projectId)
      : allowProjectPath && validProjectPath(value.projectPath)) &&
    TOKEN.test(value.providerId ?? "") &&
    boundedText(value.prompt, 16 * 1024, { multiline: true }) &&
    (value.model === undefined || isProviderModelSelection(value.model)) &&
    (value.effort === undefined || isProviderEffortSelection(value.effort)) &&
    (value.permissionMode === undefined || PERMISSION_MODES.has(value.permissionMode)) &&
    validExecutionProfile(value.executionProfile, { allowMissing: true }) &&
    validWorkspacePolicy(value.worktree)
  );
}

function validSchedule(value, scheduleId) {
  const deletedKeys = value?.deletedAtMs === undefined ? [] : ["deletedAtMs"];
  return (
    onlyKeys(value, [
      "schemaVersion",
      "scheduleId",
      "revision",
      "name",
      "enabled",
      "expression",
      "timezone",
      "runTemplate",
      "createdAtMs",
      "updatedAtMs",
      ...deletedKeys,
    ]) &&
    value.schemaVersion === SCHEDULE_CLIENT_SCHEMA_VERSION &&
    TOKEN.test(value.scheduleId ?? "") &&
    (scheduleId === undefined || value.scheduleId === scheduleId) &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0 &&
    boundedText(value.name, 256) &&
    typeof value.enabled === "boolean" &&
    boundedText(value.expression, 256) &&
    boundedText(value.timezone, 128) &&
    validRunTemplate(value.runTemplate) &&
    nonNegativeInteger(value.createdAtMs) &&
    nonNegativeInteger(value.updatedAtMs) &&
    value.updatedAtMs >= value.createdAtMs &&
    (value.deletedAtMs === undefined ||
      (nonNegativeInteger(value.deletedAtMs) &&
        value.deletedAtMs >= value.updatedAtMs))
  );
}

function validWorkspacePolicy(value) {
  return value === undefined || (
    onlyKeys(value, ["kind", ...(value?.baseCommitSha === undefined ? [] : ["baseCommitSha"])]) &&
    value.kind === "dedicated" && (value.baseCommitSha === undefined || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.baseCommitSha))
  );
}

function validRun(value) {
  return value === undefined || (
    onlyKeys(value, ["runId", "taskId", "dispatchId", "generation", "workspaceId", "completed",
      ...(value?.blockedBy === undefined ? [] : ["blockedBy"])]) &&
    [value.runId, value.taskId, value.dispatchId, value.workspaceId].every((id) => TOKEN.test(id ?? "")) &&
    Number.isSafeInteger(value.generation) && value.generation > 0 &&
    typeof value.completed === "boolean" &&
    (value.blockedBy === undefined || (!value.completed && TOKEN.test(value.blockedBy)))
  );
}

function validOccurrence(value, scheduleId) {
  return (
    onlyKeys(value, ["schemaVersion", "scheduleId", "scheduleRevision", "trigger", "idempotencyKey", "launchState",
      ...(value?.operationId === undefined ? [] : ["operationId"]),
      ...(value?.errorCode === undefined ? [] : ["errorCode"]),
      ...(value?.run === undefined ? [] : ["run"]), "createdAtMs", "updatedAtMs"]) &&
    value.schemaVersion === 2 && TOKEN.test(value.scheduleId ?? "") &&
    (scheduleId === undefined || value.scheduleId === scheduleId) &&
    Number.isSafeInteger(value.scheduleRevision) && value.scheduleRevision > 0 &&
    (onlyKeys(value.trigger, ["kind"]) && value.trigger.kind === "manual" ||
      onlyKeys(value.trigger, ["kind", "scheduledForMs"]) && value.trigger.kind === "scheduled" &&
      nonNegativeInteger(value.trigger.scheduledForMs) && value.trigger.scheduledForMs % 60_000 === 0) &&
    TOKEN.test(value.idempotencyKey ?? "") && LAUNCH_STATES.has(value.launchState) &&
    (value.operationId === undefined || TOKEN.test(value.operationId)) &&
    (value.errorCode === undefined || TOKEN.test(value.errorCode)) &&
    (value.launchState === "pending" ? value.errorCode === undefined : value.launchState === "started"
      ? value.operationId !== undefined && value.errorCode === undefined : value.errorCode !== undefined) &&
    validRun(value.run) && nonNegativeInteger(value.createdAtMs) &&
    nonNegativeInteger(value.updatedAtMs) && value.updatedAtMs >= value.createdAtMs
  );
}

function parseBackendPayload(value, action, scheduleId) {
  if (!record(value) || value.schemaVersion !== SCHEDULE_CLIENT_SCHEMA_VERSION) {
    return { error: "backend_schedule_payload_invalid" };
  }
  if (action === "list") {
    if (
      !onlyKeys(value, ["schemaVersion", "complete", "schedules"]) ||
      typeof value.complete !== "boolean" ||
      !Array.isArray(value.schedules) ||
      value.schedules.length > MAX_SCHEDULE_ITEMS ||
      value.schedules.some((item) => !validSchedule(item)) ||
      value.schedules.some(
        (item, index) => index > 0 && value.schedules[index - 1].scheduleId >= item.scheduleId,
      )
    ) {
      return { error: "backend_schedule_payload_invalid" };
    }
    return { complete: value.complete, schedules: value.schedules };
  }
  if (action === "run_once" || action === "inspect") {
    if (!onlyKeys(value, ["schemaVersion", "occurrence", ...(action === "inspect" ? ["resultMarkdown"] : [])]) ||
        !validOccurrence(value.occurrence, scheduleId) ||
        (action === "inspect" && value.resultMarkdown !== null &&
          (typeof value.resultMarkdown !== "string" || !value.occurrence.run?.completed))) {
      return { error: "backend_schedule_payload_invalid" };
    }
    return { occurrence: value.occurrence, ...(action === "inspect" ? { resultMarkdown: value.resultMarkdown } : {}) };
  }
  if (action === "occurrences") {
    if (
      !onlyKeys(value, ["schemaVersion", "occurrences"]) ||
      !Array.isArray(value.occurrences) ||
      value.occurrences.length > MAX_SCHEDULE_OCCURRENCES ||
      value.occurrences.some((item) => !validOccurrence(item, scheduleId))
    ) {
      return { error: "backend_schedule_payload_invalid" };
    }
    return { occurrences: value.occurrences };
  }
  if (
    !onlyKeys(value, ["schemaVersion", "schedule"]) ||
    !validSchedule(value.schedule, scheduleId) ||
    (action === "delete" && value.schedule.deletedAtMs === undefined) ||
    (action !== "delete" && value.schedule.deletedAtMs !== undefined)
  ) {
    return { error: "backend_schedule_payload_invalid" };
  }
  return { schedule: value.schedule };
}

function errorReport(action, code, observedAtMs, durationMs, details = {}) {
  const { deadlineMs = DEFAULT_SCHEDULE_COMMAND_DEADLINE_MS, ...error } = details;
  return {
    schemaVersion: SCHEDULE_CLIENT_SCHEMA_VERSION,
    apiVersion: "dure.schedules/v1",
    kind: "dure.schedules.error",
    action,
    complete: false,
    observedAtMs,
    durationMs,
    source: { kind: "backend_profile", appDaemonRequired: false },
    limits: {
      deadlineMs,
      maxItems: MAX_SCHEDULE_ITEMS,
      maxOccurrences: MAX_SCHEDULE_OCCURRENCES,
      maxOutputBytes: MAX_SCHEDULE_OUTPUT_BYTES,
    },
    error: { code, ...error },
  };
}

function backendErrorReport(action, error, profile, startedAt, deadlineMs) {
  const observedAtMs = Date.now();
  const { code, ...detail } = backendRequestFailure(error, profile);
  return errorReport(
    action,
    code,
    observedAtMs,
    Math.max(0, observedAtMs - startedAt),
    {
      deadlineMs,
      ...(profile ? { profileId: profile.id } : {}),
      ...detail,
    },
  );
}

function validCommand(options) {
  const {
    action,
    deadlineMs,
    enabled,
    expectedRevision,
    expression,
    idempotencyKey,
    name,
    permissionMode,
    projectId,
    projectPath,
    prompt,
    providerId,
    scheduleId,
    timezone,
  } = options;
  if (
    !["put", "list", "show", "delete", "occurrences", "run_once", "inspect"].includes(action) ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > MAX_SCHEDULE_COMMAND_DEADLINE_MS
  ) {
    return false;
  }
  if (action === "inspect") return TOKEN.test(idempotencyKey ?? "");
  if (action === "list") return scheduleId === undefined;
  if (action === "occurrences") {
    return scheduleId === undefined || TOKEN.test(scheduleId);
  }
  if (!TOKEN.test(scheduleId ?? "")) return false;
  if (action === "show") return true;
  if (action === "delete" || action === "run_once") {
    return (
      Number.isSafeInteger(expectedRevision) &&
      expectedRevision > 0 &&
      TOKEN.test(idempotencyKey ?? "")
    );
  }
  return (
    nonNegativeInteger(expectedRevision) &&
    TOKEN.test(idempotencyKey ?? "") &&
    boundedText(name, 256) &&
    typeof enabled === "boolean" &&
    boundedText(expression, 256) &&
    boundedText(timezone, 128) &&
    (projectId === undefined) !== (projectPath === undefined) &&
    validRunTemplate(
      {
        ...(projectId === undefined ? { projectPath } : { projectId }),
        providerId,
        prompt,
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        ...(options.executionProfile === undefined ? {} : { executionProfile: options.executionProfile }),
        ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
      },
      { allowProjectPath: true },
    )
  );
}

function requestBody(options) {
  switch (options.action) {
    case "list":
      return { schemaVersion: SCHEDULE_CLIENT_SCHEMA_VERSION, maxItems: MAX_SCHEDULE_ITEMS };
    case "show":
      return { schemaVersion: SCHEDULE_CLIENT_SCHEMA_VERSION, scheduleId: options.scheduleId };
    case "run_once":
    case "delete":
      return {
        schemaVersion: SCHEDULE_CLIENT_SCHEMA_VERSION,
        scheduleId: options.scheduleId,
        expectedRevision: options.expectedRevision,
        idempotencyKey: options.idempotencyKey,
      };
    case "inspect":
      return { schemaVersion: 1, idempotencyKey: options.idempotencyKey };
    case "occurrences":
      return {
        schemaVersion: SCHEDULE_CLIENT_SCHEMA_VERSION,
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
        maxItems: MAX_SCHEDULE_OCCURRENCES,
      };
    default:
      return {
        schemaVersion: SCHEDULE_CLIENT_SCHEMA_VERSION,
        scheduleId: options.scheduleId,
        expectedRevision: options.expectedRevision,
        idempotencyKey: options.idempotencyKey,
        name: options.name,
        enabled: options.enabled,
        expression: options.expression,
        timezone: options.timezone,
        runTemplate: {
          ...(options.projectId === undefined
            ? { projectPath: options.projectPath }
            : { projectId: options.projectId }),
          providerId: options.providerId,
          prompt: options.prompt,
          ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.effort === undefined ? {} : { effort: options.effort }),
          ...(options.executionProfile === undefined ? {} : { executionProfile: options.executionProfile }),
          ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
        },
      };
  }
}

export async function collectScheduleCommand(options = {}) {
  const startedAt = Date.now();
  const normalized = {
    ...options,
    deadlineMs: options.deadlineMs ?? DEFAULT_SCHEDULE_COMMAND_DEADLINE_MS,
  };
  if (!validCommand(normalized)) {
    return errorReport(
      normalized.action,
      "backend_schedule_request_invalid",
      Date.now(),
      0,
    );
  }
  const profile = normalized.backend?.profile;
  if (normalized.backend?.error || !profile) {
    return backendErrorReport(
      normalized.action,
      normalized.backend?.error,
      profile,
      startedAt,
      normalized.deadlineMs,
    );
  }
  let response;
  try {
    response = await (normalized.requestBackend ?? performBackendProfileRequest)(
      profile,
      {
        body: requestBody(normalized),
        operation: `schedule.${normalized.action}`,
        requiredCapabilities: [`schedule.${normalized.action}`],
      },
      {
        ...normalized.backend.transportOptions,
        deadlineMs: normalized.deadlineMs,
        maxResponseBytes: MAX_SCHEDULE_OUTPUT_BYTES,
      },
    );
  } catch (error) {
    return backendErrorReport(
      normalized.action,
      error,
      profile,
      startedAt,
      normalized.deadlineMs,
    );
  }
  const parsed = parseBackendPayload(
    response.result,
    normalized.action,
    normalized.scheduleId,
  );
  const observedAtMs = Date.now();
  const durationMs = Math.max(0, observedAtMs - startedAt);
  if (!parsed.error && ["run_once", "inspect"].includes(normalized.action) &&
      parsed.occurrence.idempotencyKey !== normalized.idempotencyKey) {
    parsed.error = "backend_schedule_payload_invalid";
  }
  if (parsed.error) {
    return errorReport(normalized.action, parsed.error, observedAtMs, durationMs, {
      deadlineMs: normalized.deadlineMs,
      profileId: profile.id,
    });
  }
  const base = {
    schemaVersion: SCHEDULE_CLIENT_SCHEMA_VERSION,
    apiVersion: "dure.schedules/v1",
    kind: `dure.schedules.${normalized.action}`,
    action: normalized.action,
    complete: normalized.action === "list" ? parsed.complete : true,
    observedAtMs,
    durationMs,
    source: {
      kind: "backend_profile",
      appDaemonRequired: false,
      profileId: profile.id,
      transport: profile.transport.kind,
      backend: response.backend,
    },
    limits: {
      deadlineMs: normalized.deadlineMs,
      maxItems: MAX_SCHEDULE_ITEMS,
      maxOccurrences: MAX_SCHEDULE_OCCURRENCES,
      maxOutputBytes: MAX_SCHEDULE_OUTPUT_BYTES,
    },
  };
  const report =
    normalized.action === "list"
      ? { ...base, schedules: parsed.schedules }
      : normalized.action === "occurrences"
        ? { ...base, occurrences: parsed.occurrences }
        : normalized.action === "run_once" || normalized.action === "inspect"
          ? { ...base, ...parsed }
          : { ...base, schedule: parsed.schedule };
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_SCHEDULE_OUTPUT_BYTES) {
    return errorReport(
      normalized.action,
      "backend_schedule_output_limit",
      observedAtMs,
      durationMs,
      { deadlineMs: normalized.deadlineMs, profileId: profile.id },
    );
  }
  return report;
}

export function scheduleCommandExitCode(report) {
  return report.kind === "dure.schedules.error" ? 2 : 0;
}

export function formatScheduleCommand(report) {
  if (report.kind === "dure.schedules.error") {
    return `Dure schedules unavailable: ${report.error.remoteCode ?? report.error.code}`;
  }
  if (["dure.schedules.run_once", "dure.schedules.inspect"].includes(report.kind)) {
    const occurrence = report.occurrence;
    return `${occurrence.idempotencyKey} — ${occurrenceStatus(occurrence)}${report.resultMarkdown == null ? "" : `\n\n${report.resultMarkdown}`}`;
  }
  if (report.kind === "dure.schedules.occurrences") {
    if (report.occurrences.length === 0) return "No Dure schedule occurrences.";
    return [
      "SCHEDULE\tTRIGGER\tWHEN\tSTATUS\tRUN KEY",
      ...report.occurrences.map((item) =>
        [
          item.scheduleId,
          item.trigger.kind,
          new Date(item.trigger.scheduledForMs ?? item.createdAtMs).toISOString(),
          occurrenceStatus(item),
          item.idempotencyKey,
        ].join("\t"),
      ),
    ].join("\n");
  }
  const schedules = report.kind === "dure.schedules.list" ? report.schedules : [report.schedule];
  if (schedules.length === 0) return "No Dure schedules.";
  return [
    "SCHEDULE\tREVISION\tSTATE\tCRON\tTIMEZONE\tPROJECT\tPROVIDER\tNAME",
    ...schedules.map((item) =>
      [
        item.scheduleId,
        item.revision,
        item.deletedAtMs === undefined ? (item.enabled ? "enabled" : "disabled") : "deleted",
        item.expression,
        item.timezone,
        item.runTemplate.projectId,
        item.runTemplate.providerId,
        item.name,
      ].join("\t"),
    ),
  ].join("\n");
}

function occurrenceStatus(occurrence) {
  if (occurrence.run?.completed) return "Report received";
  if (occurrence.run?.blockedBy) return "Awaiting decision";
  if (occurrence.launchState === "failed") return `Start failed: ${occurrence.errorCode}`;
  if (occurrence.launchState === "pending") return "Queued";
  return occurrence.run ? "Awaiting report" : "Started; awaiting report";
}
