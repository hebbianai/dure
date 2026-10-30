/**
 * What the phone can say about one session row, as label/value lines. Tauri/DOM
 * 없이 시험된다.
 *
 * A row shows a title and little else, and two rows can share a title: a pane
 * the sidebar calls `claude-2` next to an agent whose name is also `claude-2`.
 * When one of them will not open, the person needs the identity the computer
 * itself uses — its hmux name, project, provider, session id — and the reason
 * the last attach was refused, to find it on the desktop or report it.
 *
 * # Only what the phone was told
 *
 * Every line comes from the listing, the laptop's placement or this phone's own
 * attach attempts. A field nobody reported is left out rather than drawn as a
 * dash: "unknown" and "none" would otherwise read the same, which is the rule
 * `HubPlacement.branch` already states.
 */

import { accountSummaryText } from "./accountSwitch";
import type { HubSessions, UnifiedRow } from "./allSessions";
import { t } from "./i18n";
import type { HubPlacement, HubProbeSession } from "./ipc";
import { relativeTime } from "./relativeTime";
import { RUN_STATE_LABEL } from "./sessionRows";

/** The last attach this phone saw refused, for one session. */
export interface AttachFailure {
  /** The sentence the banner showed. Not translated again — it may be the computer's. */
  readonly detail: string;
  readonly atUnixMs: number;
}

export type AttachFailures = Readonly<Record<string, AttachFailure>>;

export function withAttachFailure(
  failures: AttachFailures,
  sessionId: string,
  detail: string,
  atUnixMs: number,
): AttachFailures {
  return { ...failures, [sessionId]: { detail, atUnixMs } };
}

/** A controlling attach succeeded, so the earlier refusal no longer describes this session. */
export function withoutAttachFailure(failures: AttachFailures, sessionId: string): AttachFailures {
  if (!(sessionId in failures)) return failures;
  const { [sessionId]: _cleared, ...rest } = failures;
  return rest;
}

export type SessionInfoFactId =
  | "status"
  | "provider"
  | "account"
  | "program"
  | "name"
  | "space"
  | "project"
  | "branch"
  | "folder"
  | "computer"
  | "workspace"
  | "session"
  | "lastError";

export interface SessionInfoFact {
  readonly id: SessionInfoFactId;
  readonly label: string;
  readonly value: string;
  /** An identifier someone may need to compare or paste: drawn monospaced. */
  readonly code?: true;
}

export interface SessionInfoInput {
  readonly row: UnifiedRow;
  /** Every paired computer's listing: the row may have come by SSH while a laptop also lists it. */
  readonly hubs: readonly HubSessions[];
  /** Where the laptop's sidebar placed the session, if it published one. */
  readonly seat?: HubPlacement;
  readonly failure?: AttachFailure;
  readonly now: number;
}

/** The lines of the info sheet, in the order it draws them and the copy writes them. */
export function sessionInfoFacts(input: SessionInfoInput): SessionInfoFact[] {
  const { row, seat, failure, now } = input;
  const session = row.source.session;
  const listed = hubListing(row, input.hubs);
  const facts: SessionInfoFact[] = [];
  const add = (fact: SessionInfoFact): void => {
    if (fact.value.trim() !== "") facts.push(fact);
  };

  // The lifecycle word only where the label folds several into one: "Needs
  // attention" may be starting or restoring, and an unknown state has nothing
  // else to say. "Running · running" would say one thing twice.
  const lifecycle = session.lifecycle.trim();
  const state = t(RUN_STATE_LABEL[row.state]);
  const folded = row.state === "warn" || row.state === "blocked" || row.state === "unknown";
  add({
    id: "status",
    label: t("sessionInfo.status"),
    value: folded && lifecycle !== "" ? `${state} · ${lifecycle}` : state,
  });
  add({ id: "provider", label: t("sessionInfo.provider"), value: session.provider_id });
  // Only when the computer reported one: a session without an account line is
  // not "on the default account", it is one the phone was told nothing about.
  add({ id: "account", label: t("sessionInfo.account"), value: listed ? (accountSummaryText(listed) ?? "") : "" });
  const program = session.launch_program?.trim() ?? "";
  if (program !== session.provider_id.trim()) {
    add({ id: "program", label: t("sessionInfo.program"), value: program });
  }

  const name = hmuxName(row, listed);
  if (name !== undefined && name !== row.title) {
    add({
      id: "name",
      label: t(listed?.presentation?.kind === "agent" ? "sessionInfo.agentName" : "sessionInfo.sessionName"),
      value: name,
      code: true,
    });
  }

  add({ id: "space", label: t("common.space"), value: seat?.desktop ?? "" });
  add({
    id: "project",
    label: t("sessionInfo.project"),
    value: seat?.project.trim() || (listed?.presentation?.projectName ?? ""),
  });
  add({ id: "branch", label: t("sessionInfo.branch"), value: seat?.branch ?? row.branch ?? "", code: true });
  add({ id: "folder", label: t("sessionInfo.folder"), value: listed?.presentation?.cwd ?? "", code: true });
  add({ id: "computer", label: t("sessionInfo.computer"), value: computer(row) });
  add({ id: "workspace", label: t("sessionInfo.workspace"), value: session.workspace_id, code: true });
  add({ id: "session", label: t("sessionInfo.sessionId"), value: session.session_id, code: true });

  if (failure !== undefined) {
    add({
      id: "lastError",
      label: t("sessionInfo.lastError"),
      value: t("sessionInfo.lastErrorValue", {
        when: relativeTime(failure.atUnixMs, now),
        detail: failure.detail,
      }),
    });
  }
  return facts;
}

/**
 * The sheet as plain text, for a bug report or a message to whoever runs the
 * computer. The same lines in the same order, so what was pasted matches what
 * was on the screen.
 */
export function sessionInfoText(title: string, facts: readonly SessionInfoFact[]): string {
  return [title, ...facts.map((fact) => `${fact.label}: ${fact.value}`)].join("\n");
}

/**
 * The paired computer's entry for this session, whichever route the row took.
 *
 * The row's own source first, so two laptops listing the same server session
 * describe it the way the row was drawn. Otherwise the first listing that knows
 * it, in the order [`hubKnowing`] uses.
 */
function hubListing(row: UnifiedRow, hubs: readonly HubSessions[]): HubProbeSession | undefined {
  if (row.source.kind === "hub") return row.source.session;
  for (const hub of hubs) {
    const found = hub.sessions.find((session) => session.session_id === row.sessionId);
    if (found) return found;
  }
  return undefined;
}

/**
 * The name the computer's CLI knows the session by.
 *
 * A laptop listing folds its sidebar title into `session_name` and keeps the
 * hmux name aside; an SSH listing carries the hmux name as `session_name`.
 */
function hmuxName(row: UnifiedRow, listed: HubProbeSession | undefined): string | undefined {
  const name = listed?.hmux_session_name?.trim() ||
    (row.source.kind === "ssh" ? row.source.session.session_name?.trim() : undefined);
  return name && name.length > 0 ? name : undefined;
}

/** Which machine runs it and how the phone reaches it, in one line. */
function computer(row: UnifiedRow): string {
  const source = row.source;
  const where =
    source.kind === "ssh"
      ? t("sessionInfo.computerSsh", { computer: source.serverLabel })
      : source.session.box_label.trim() !== "" && source.session.box_label.trim() !== source.hubLabel
        ? t("sessionInfo.computerVia", { computer: source.session.box_label.trim(), hub: source.hubLabel })
        : source.hubLabel;
  return source.reachable ? where : t("sessionInfo.computerOffline", { computer: where });
}
