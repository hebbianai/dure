import { describe, expect, it } from "vitest";
import {
  projectHmuxManagedAgentPaneLayout,
  resolveHmuxManagedAgentPromotion,
  type HmuxManagedAgentPromotion,
} from "@/lib/hmux/conversion/hmuxAgentPanePromotion";
import {
  hmuxManagedBinding,
  hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import type { Agent, Project } from "@/types";


const source = hmuxStandaloneBinding("standalone-source", "workspace-1");
const target = {
  ...hmuxManagedBinding("managed-target", "workspace-1"),
  createIdempotencyKey: "convert-1",
};
const sourcePanelId = "term:standalone-source";

const projects: Project[] = [
  {
    id: "project-1",
    name: "HebbianIDE",
    path: "/repo",
    kind: "local",
    isRepo: true,
  },
];

function promotion(): HmuxManagedAgentPromotion {
  return {
    agentId: "agent-hmux-deadbeef",
    agentName: "hmux-codex",
    projectId: "project-1",
    branch: "agent/hmux-codex",
    sourcePanelId,
    targetPanelId: "agent:agent-hmux-deadbeef",
    conversionId: "convert-deadbeef",
    terminalEnvironment: {},
  };
}

function layout(
  binding:
    | ReturnType<typeof hmuxStandaloneBinding>
    | ReturnType<typeof hmuxManagedBinding> = source,
) {
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: {
              id: "group-1",
              views: ["term:other", sourcePanelId],
              activeView: sourcePanelId,
              tabGroups: [{ panelIds: [sourcePanelId] }],
            },
            size: 777,
          },
        ],
      },
      width: 1200,
      height: 800,
      orientation: "HORIZONTAL",
    },
    panels: {
      "term:other": {
        id: "term:other",
        contentComponent: "terminal",
        params: { sessionId: "other" },
      },
      [sourcePanelId]: {
        id: sourcePanelId,
        contentComponent: "terminal",
        title: "hmux-codex",
        params: {
          cwd: "/repo/.worktrees/hmux-codex",
          sessionId: binding.sessionId,
          binding,
        },
      },
    },
    activeGroup: "group-1",
  };
}

describe("Hmux standalone Agent pane promotion", () => {
  it.each(["agent", "launcher", "other"])("does not overwrite %s content carrying the previous terminal binding", (component) => {
    const before = layout();
    before.panels[sourcePanelId].contentComponent = component;
    const sameSlot = { ...promotion(), targetPanelId: sourcePanelId };
    expect(projectHmuxManagedAgentPaneLayout(before, sameSlot, source, target)).toEqual({ state: "conflict", layout: before });
  });

  it.each([sourcePanelId, promotion().targetPanelId])("rejects a late promotion at %s when its explicit Agent reference changed", (panelId) => {
    const accepted = { ...promotion(), targetPanelId: panelId };
    for (const agentRef of [null, {}, { agentId: "replacement" }]) {
      const before = { panels: { [panelId]: { id: panelId, contentComponent: "agent", params: { agentRef } } } };
      expect(projectHmuxManagedAgentPaneLayout(before, accepted, source, target)).toEqual({ state: "conflict", layout: before });
    }
  });

  it("derives a deterministic Agent identity from the fenced conversion", () => {
    const first = resolveHmuxManagedAgentPromotion({
      sourcePanelId,
      conversionId: "convert-deadbeefcafebabe",
      providerId: "codex",
      cwd: "/repo/.worktrees/hmux-codex",
      sourceBinding: source,
      currentBinding: source,
      preferredName: "hmux-codex",
      terminalEnvironment: {},
      projects,
      detected: {
        "project-1": [
          {
            path: "/repo/.worktrees/hmux-codex",
            branch: "agent/hmux-codex",
            isMain: false,
            claudeSessions: 0,
            codexSessions: 1,
          },
        ],
      },
      agents: [],
    });
    const replay = resolveHmuxManagedAgentPromotion({
      sourcePanelId,
      conversionId: "convert-deadbeefcafebabe",
      providerId: "codex",
      cwd: "/repo/.worktrees/hmux-codex",
      sourceBinding: source,
      currentBinding: target,
      preferredName: "hmux-codex",
      terminalEnvironment: {},
      projects,
      detected: {},
      agents: [],
    });

    expect(first).toMatchObject({
      agentName: "hmux-codex",
      projectId: "project-1",
      branch: "agent/hmux-codex",
      sourcePanelId,
    });
    expect(replay.agentId).toBe(first.agentId);
    expect(first.targetPanelId).toBe(sourcePanelId);
  });

  it("resolves the same project identity for a fenced standalone terminal", () => {
    const legacy = hmuxStandaloneBinding("term-legacy", "workspace-legacy");
    const resolved = resolveHmuxManagedAgentPromotion({
      sourcePanelId: "term:term-legacy",
      conversionId: "legacy_terminal_deadbeef",
      providerId: "claude",
      cwd: "/repo/.worktrees/legacy-claude",
      sourceBinding: legacy,
      currentBinding: legacy,
      preferredName: "legacy-claude",
      terminalEnvironment: {},
      projects,
      detected: {
        "project-1": [
          {
            path: "/repo/.worktrees/legacy-claude",
            branch: "agent/legacy-claude",
            isMain: false,
            claudeSessions: 1,
            codexSessions: 0,
          },
        ],
      },
      agents: [],
    });

    expect(resolved).toMatchObject({
      agentName: "legacy-claude",
      projectId: "project-1",
      branch: "agent/legacy-claude",
      sourcePanelId: "term:term-legacy",
    });
  });

  it("refuses a same-project name collision without exact runtime identity", () => {
    const unrelated: Agent = {
      id: "agent-old",
      name: "hmux-codex",
      provider: "codex",
      projectId: "project-1",
      worktreePath: "/repo/.worktrees/hmux-codex",
      branch: "old",
      sessionId: "agent-old",
      sessionKind: "pty",
    };

    expect(() =>
      resolveHmuxManagedAgentPromotion({
        sourcePanelId,
        conversionId: "convert-deadbeefcafebabe",
        providerId: "codex",
        cwd: "/repo/.worktrees/hmux-codex",
        sourceBinding: source,
        currentBinding: source,
        preferredName: "hmux-codex",
        terminalEnvironment: {},
        projects,
        detected: {},
        agents: [unrelated],
      }),
    ).toThrow(/name conflict/);
  });

  it("reuses a same-name Agent only when its runtime identity is exact", () => {
    const existing: Agent = {
      id: "agent-existing",
      name: "hmux-codex",
      provider: "codex",
      projectId: "project-1",
      worktreePath: "/repo/.worktrees/hmux-codex",
      branch: "agent/existing",
      sessionId: source.sessionId,
      sessionKind: "pty",
      runtimeBinding: source,
      terminalEnv: {},
    };

    expect(
      resolveHmuxManagedAgentPromotion({
        sourcePanelId,
        conversionId: "convert-deadbeefcafebabe",
        providerId: "codex",
        cwd: "/repo/.worktrees/hmux-codex",
        sourceBinding: source,
        currentBinding: source,
        preferredName: "hmux-codex",
        terminalEnvironment: {},
        projects,
        detected: {},
        agents: [existing],
      }),
    ).toMatchObject({
      agentId: existing.id,
      agentName: existing.name,
      branch: existing.branch,
      targetPanelId: sourcePanelId,
    });
  });

  it("replays the recorded target of a legacy promotion without changing its grid position", () => {
    const before = layout();
    const projected = projectHmuxManagedAgentPaneLayout(
      before,
      promotion(),
      source,
      target,
    );

    expect(projected.state).toBe("source");
    expect(before.panels[sourcePanelId]).toBeDefined();
    const next = projected.layout as ReturnType<typeof layout> & {
      panels: Record<string, Record<string, unknown>>;
    };
    expect(next.panels[sourcePanelId]).toBeUndefined();
    expect(next.panels[promotion().targetPanelId]).toMatchObject({
      id: promotion().targetPanelId,
      contentComponent: "agent",
      title: "hmux-codex",
      params: { agentRef: { agentId: promotion().agentId } },
    });
    expect(next.grid.root.data[0]).toMatchObject({
      size: 777,
      data: {
        id: "group-1",
        views: ["term:other", promotion().targetPanelId],
        activeView: promotion().targetPanelId,
        tabGroups: [{ panelIds: [promotion().targetPanelId] }],
      },
    });
    expect(next.activeGroup).toBe("group-1");
  });

  it("replays after reload from the canonical Agent panel identity alone", () => {
    const afterRuntimeResponseLoss = projectHmuxManagedAgentPaneLayout(
      layout(target),
      promotion(),
      source,
      target,
    );
    expect(afterRuntimeResponseLoss.state).toBe("source");

    const replay = projectHmuxManagedAgentPaneLayout(
      afterRuntimeResponseLoss.layout,
      promotion(),
      source,
      target,
    );
    expect(replay.state).toBe("target");
    expect(replay.layout).toEqual(afterRuntimeResponseLoss.layout);
		const params = (
			(replay.layout as { panels: Record<string, { params: unknown }> }).panels[
				promotion().targetPanelId
			]?.params
		);
		expect(params).toEqual({ agentRef: { agentId: promotion().agentId } });
  });
});
