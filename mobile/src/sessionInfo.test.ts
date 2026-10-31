import { describe, expect, it } from "vitest";
import { type HubSessions, type UnifiedRow, flattenRows } from "./allSessions";
import type { CensusRow } from "./census";
import { t } from "./i18n";
import type { HubProbeSession } from "./ipc";
import {
  type SessionInfoFact,
  sessionInfoFacts,
  sessionInfoText,
  withAttachFailure,
  withoutAttachFailure,
} from "./sessionInfo";
import type { RemoteSession } from "./sessions";

const NOW = 1_800_000_000_000;

function remote(sessionId: string, overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    session_id: sessionId,
    session_name: null,
    workspace_id: "workspace_64532e59",
    session_class: "managed",
    lifecycle: "ready",
    provider_id: "claude-code",
    runner_principal: "local-user",
    runner_instance: "runner-1",
    channel_epoch: "1",
    host_instance_id: "host-1",
    terminal_epoch: "terminal-1",
    capabilities: [],
    ready: true,
    ...overrides,
  };
}

function hubSession(sessionId: string, overrides: Partial<HubProbeSession> = {}): HubProbeSession {
  return {
    ...remote(sessionId),
    launch_program: null,
    box_id: "this-laptop",
    box_label: "맥북",
    ...overrides,
  };
}

function laptop(sessions: HubProbeSession[], reachable = true): HubSessions {
  return { hubId: "SHA256:hub", hubLabel: "맥북", reachable, sessions };
}

function rowOf(input: { census?: CensusRow[]; hubs?: HubSessions[] }, sessionId: string): UnifiedRow {
  const row = flattenRows({ census: input.census ?? [], hubs: input.hubs ?? [] })
    .find((candidate) => candidate.sessionId === sessionId);
  if (!row) throw new Error(`no row ${sessionId}`);
  return row;
}

const byId = (facts: readonly SessionInfoFact[]) =>
  Object.fromEntries(facts.map((fact) => [fact.id, fact.value]));

describe("sessionInfoFacts", () => {
  /**
   * The case #227 reported: the sidebar title is the only name on the row, and
   * another agent carries the same one. The hmux name, project and id are what
   * tell the two apart on the computer.
   */
  it("names a laptop session the way the computer does", () => {
    const hubs = [
      laptop([
        hubSession("hub-live", {
          session_name: "claude-2",
          hmux_session_name: "fix-login-redirect",
          presentation: {
            kind: "agent",
            projectName: "storefront",
            cwd: "/Users/me/storefront/.worktrees/fix-login-redirect",
          },
        }),
      ]),
    ];
    const facts = sessionInfoFacts({
      row: rowOf({ hubs }, "hub-live"),
      hubs,
      seat: { desktop: "Main", project: "storefront", order: 0, branch: "fix/login-redirect" },
      now: NOW,
    });

    expect(facts.map((fact) => fact.id)).toEqual([
      "status", "provider", "name", "space", "project", "branch", "folder", "computer", "workspace", "session",
    ]);
    expect(byId(facts)).toMatchObject({
      status: t("session.status.running"),
      provider: "claude-code",
      name: "fix-login-redirect",
      space: "Main",
      project: "storefront",
      branch: "fix/login-redirect",
      folder: "/Users/me/storefront/.worktrees/fix-login-redirect",
      computer: "맥북",
      workspace: "workspace_64532e59",
      session: "hub-live",
    });
    expect(facts.find((fact) => fact.id === "name")?.label).toBe(t("sessionInfo.agentName"));
  });

  /** A line nobody reported is left out, never drawn as a dash. */
  it("omits what the computer did not report", () => {
    const hubs = [laptop([hubSession("bare", { session_name: "zsh" })])];
    const facts = sessionInfoFacts({ row: rowOf({ hubs }, "bare"), hubs, now: NOW });
    expect(facts.map((fact) => fact.id)).toEqual(["status", "provider", "computer", "workspace", "session"]);
  });

  /** The account line comes from the computer that can switch it (#287). */
  it("says which account the session runs on, when the computer said", () => {
    const hubs = [laptop([hubSession("acct", {
      presentation: { kind: "agent", account: { label: "Work", pending: { label: "Spare" } } },
    })])];
    const facts = sessionInfoFacts({ row: rowOf({ hubs }, "acct"), hubs, now: NOW });
    expect(facts.map((fact) => fact.id).slice(0, 3)).toEqual(["status", "provider", "account"]);
    expect(byId(facts).account).toBe(t("account.summaryPending", { current: "Work", next: "Spare" }));
  });

  it("does not repeat the title as the session name", () => {
    const hubs = [laptop([hubSession("same", { session_name: "codex-14", hmux_session_name: "codex-14" })])];
    const facts = sessionInfoFacts({ row: rowOf({ hubs }, "same"), hubs, now: NOW });
    expect(facts.some((fact) => fact.id === "name")).toBe(false);
  });

  /**
   * A row drawn from the SSH census still gets the laptop's description of the
   * same session, because the person is looking for it on that laptop.
   */
  it("describes an SSH row with the laptop's listing of the same session", () => {
    const census: CensusRow[] = [{
      serverId: "srv-1",
      serverLabel: "Gate1",
      reachable: true,
      session: remote("shared", { session_name: "feat/mobile", launch_program: "ssh", provider_id: "local-shell" }),
    }];
    const hubs = [laptop([hubSession("shared", {
      session_name: "mobile",
      presentation: { kind: "term", projectName: "agent-ide" },
    })])];
    const facts = byId(sessionInfoFacts({ row: rowOf({ census, hubs }, "shared"), hubs, now: NOW }));

    expect(facts.name).toBe("feat/mobile");
    expect(facts.program).toBe("ssh");
    expect(facts.project).toBe("agent-ide");
    expect(facts.computer).toBe(t("sessionInfo.computerSsh", { computer: "Gate1" }));
  });

  it("says which laptop relays a remote box and when a computer stopped answering", () => {
    const relayed = [laptop([hubSession("remote", { box_id: "gate", box_label: "gate1" })])];
    expect(byId(sessionInfoFacts({ row: rowOf({ hubs: relayed }, "remote"), hubs: relayed, now: NOW })).computer)
      .toBe(t("sessionInfo.computerVia", { computer: "gate1", hub: "맥북" }));

    const offline = [laptop([hubSession("gone")], false)];
    expect(byId(sessionInfoFacts({ row: rowOf({ hubs: offline }, "gone"), hubs: offline, now: NOW })).computer)
      .toBe(t("sessionInfo.computerOffline", { computer: "맥북" }));
  });

  it("keeps the lifecycle word only where the state label folds several", () => {
    const status = (lifecycle: string) => {
      const hubs = [laptop([hubSession("s", { lifecycle, ready: lifecycle === "ready" })])];
      return byId(sessionInfoFacts({ row: rowOf({ hubs }, "s"), hubs, now: NOW })).status;
    };
    expect(status("running")).toBe(t("session.status.running"));
    expect(status("exited")).toBe(t("common.exited"));
    expect(status("restoring")).toBe(`${t("session.status.attention")} · restoring`);
    expect(status("terminating")).toBe(`${t("session.status.unknown")} · terminating`);
  });

  it("ends with the last refused attach and how long ago it was", () => {
    const hubs = [laptop([hubSession("refused")])];
    const failures = withAttachFailure({}, "refused", "Another client controls this Hmux session (hmux_controller_conflict)", NOW - 120_000);
    const facts = sessionInfoFacts({ row: rowOf({ hubs }, "refused"), hubs, failure: failures.refused, now: NOW });

    const last = facts[facts.length - 1];
    expect(last?.id).toBe("lastError");
    expect(last?.value).toBe(t("sessionInfo.lastErrorValue", {
      when: t("{count}분 전", { count: 2 }),
      detail: "Another client controls this Hmux session (hmux_controller_conflict)",
    }));
  });
});

describe("attach failures", () => {
  it("replaces a session's reason and clears it once a controlling attach succeeds", () => {
    const first = withAttachFailure({}, "s-1", "first", 1);
    const second = withAttachFailure(first, "s-1", "second", 2);
    expect(second["s-1"]).toEqual({ detail: "second", atUnixMs: 2 });
    expect(withoutAttachFailure(second, "s-1")).toEqual({});
    expect(withoutAttachFailure(first, "other")).toBe(first);
  });
});

describe("sessionInfoText", () => {
  it("copies the same lines in the same order as the sheet", () => {
    expect(sessionInfoText("claude-2", [
      { id: "provider", label: "Provider", value: "claude-code" },
      { id: "session", label: "Session ID", value: "hub-live", code: true },
    ])).toBe("claude-2\nProvider: claude-code\nSession ID: hub-live");
  });
});
