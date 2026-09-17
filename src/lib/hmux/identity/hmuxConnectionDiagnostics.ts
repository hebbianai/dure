import { configuredFrontendAppChannel } from "@/lib/platform/appChannel";

export { currentWebviewInstanceIdentity as hmuxDiagnosticWebviewIdentity } from "@/lib/platform/webviewInstanceIdentity";

const HMUX_CONNECTION_DIAGNOSTICS_FILE =
  "hmux-connection-diagnostics.json";

export function hmuxConnectionDiagnosticsPath(channel?: string) {
  return channel && channel !== "stable" && /^[a-z0-9-]{1,64}$/.test(channel)
    ? `~/.dure/channels/${channel}/${HMUX_CONNECTION_DIAGNOSTICS_FILE}`
    : `~/.dure/${HMUX_CONNECTION_DIAGNOSTICS_FILE}`;
}

export const HMUX_CONNECTION_DIAGNOSTICS_PATH =
  hmuxConnectionDiagnosticsPath(configuredFrontendAppChannel());

const MAX_EVENTS = 512;
const MAX_INCIDENTS = 64;
const MAX_DETAIL_BYTES = 8 * 1024;
const MAX_BATCH_EVENTS = 64;
const MAX_QUEUED_EVENTS = 512;
const BATCH_DELAY_MS = 1_000;

export interface HmuxConnectionDiagnosticInput {
  event: string;
  sessionId: string;
  workspaceId?: string;
  paneId: string;
  runtime?: string;
  state?: string;
  code?: string;
  details?: Record<string, unknown>;
}

export interface HmuxConnectionDiagnosticEvent
  extends HmuxConnectionDiagnosticInput {
  timestamp: string;
}

export interface HmuxConnectionDiagnosticJournal {
  schemaVersion: 2;
  updatedAt: string;
  events: HmuxConnectionDiagnosticEvent[];
  incidents: HmuxConnectionDiagnosticEvent[];
}

export interface HmuxConnectionDiagnosticJournalV1 {
  schemaVersion: 1;
  updatedAt: string;
  events: HmuxConnectionDiagnosticEvent[];
}

export interface HmuxConnectionDiagnosticBatchHost {
  schedule(callback: () => void): void;
}

const DEFAULT_BATCH_HOST: HmuxConnectionDiagnosticBatchHost = {
  schedule: (callback) => {
    setTimeout(callback, BATCH_DELAY_MS);
  },
};

/**
 * Amortizes the journal's read/parse/rewrite/fsync cost across an event burst.
 * Persistence stays ordered, one batch is in flight at a time, and a stalled
 * backend cannot grow the renderer queue without bound.
 */
export class HmuxConnectionDiagnosticBatchWriter {
  private readonly pending: HmuxConnectionDiagnosticEvent[] = [];
  private scheduled = false;
  private inFlight = false;

  constructor(
    private readonly persist: (
      events: HmuxConnectionDiagnosticEvent[],
    ) => Promise<void>,
    private readonly host: HmuxConnectionDiagnosticBatchHost = DEFAULT_BATCH_HOST,
  ) {}

  enqueue(event: HmuxConnectionDiagnosticEvent) {
    if (this.pending.length >= MAX_QUEUED_EVENTS) {
      const routineIndex = this.pending.findIndex(
        (candidate) => !isHmuxConnectionIncident(candidate),
      );
      this.pending.splice(Math.max(0, routineIndex), 1);
    }
    this.pending.push(event);
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.scheduled || this.inFlight || this.pending.length === 0) return;
    this.scheduled = true;
    this.host.schedule(() => {
      this.scheduled = false;
      void this.flush();
    });
  }

  private async flush() {
    if (this.inFlight) return;
    const events = this.pending.splice(0, MAX_BATCH_EVENTS);
    if (events.length === 0) return;
    this.inFlight = true;
    try {
      await this.persist(events);
    } catch {
      // Diagnostics must never delay terminal recovery with persistence retry.
    } finally {
      this.inFlight = false;
      this.scheduleFlush();
    }
  }
}

export function appendHmuxConnectionDiagnostic(
  journal:
    | HmuxConnectionDiagnosticJournal
    | HmuxConnectionDiagnosticJournalV1,
  input: HmuxConnectionDiagnosticInput,
  timestamp = new Date().toISOString(),
): HmuxConnectionDiagnosticJournal {
  const event: HmuxConnectionDiagnosticEvent = {
    ...input,
    event: boundedText(input.event, 96),
    sessionId: boundedText(input.sessionId, 256),
    workspaceId: boundedOptionalText(input.workspaceId, 256),
    paneId: boundedText(input.paneId, 512),
    runtime: boundedOptionalText(input.runtime, 96),
    state: boundedOptionalText(input.state, 96),
    code: boundedOptionalText(input.code, 256),
    details: boundedDetails(input.details),
    timestamp,
  };
  const retainedIncidents =
    journal.schemaVersion === 2
      ? journal.incidents
      : journal.events.filter(isHmuxConnectionIncident);
  return {
    schemaVersion: 2,
    updatedAt: timestamp,
    events: [...journal.events, event].slice(-MAX_EVENTS),
    incidents: (
      isHmuxConnectionIncident(event)
        ? [...retainedIncidents, event]
        : retainedIncidents
    ).slice(-MAX_INCIDENTS),
  };
}

function isHmuxConnectionIncident(
  event: Pick<HmuxConnectionDiagnosticEvent, "state" | "code">,
) {
  if (
    event.state === "disconnected" ||
    event.state === "error" ||
    event.state === "stale"
  ) {
    return true;
  }
  return /closed|failed|error|stalled|backlog|backpressure|resource_limit|timeout|gap|conflict|unavailable|exhausted/i.test(
    event.code ?? "",
  );
}

export function recordHmuxInputFailureDiagnostic(
  record: (
    event: string,
    state?: string,
    code?: string,
    details?: Record<string, unknown>,
  ) => void,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    message.match(/^(?:hmux|terminal)_[a-z0-9_]{1,128}\b/i)?.[0] ??
    (message.startsWith("Hmux controller pane lost focus")
      ? "hmux_input_cancelled_focus_handoff"
      : message.startsWith("Hmux input requires the focused controller pane")
        ? "hmux_input_missing_focus_authority"
        : message.startsWith("Hmux controller is not attached")
          ? "hmux_input_controller_missing"
          : undefined);
  const rawType = error instanceof Error ? error.name : typeof error;
  const errorType = rawType.match(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/)?.[0];
  record("input", "failed", code?.toLowerCase() ?? "hmux_input_write_failed", {
    errorType: errorType ?? "unknown",
  });
}

function boundedText(value: string, maximum: number) {
  return value.slice(0, maximum);
}

function boundedOptionalText(value: string | undefined, maximum: number) {
  return value === undefined ? undefined : boundedText(value, maximum);
}

function boundedDetails(details: Record<string, unknown> | undefined) {
  if (!details) return undefined;
  try {
    const serialized = JSON.stringify(details);
    if (serialized.length <= MAX_DETAIL_BYTES) {
      return JSON.parse(serialized) as Record<string, unknown>;
    }
    return {
      truncated: true,
      preview: serialized.slice(0, MAX_DETAIL_BYTES),
    };
  } catch {
    return { serializationError: true };
  }
}
