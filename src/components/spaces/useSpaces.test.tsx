// @vitest-environment jsdom
//
// Perf contract for the rows derivation (Batch 5 item 1):
// - project resolution is longest-prefix over the shared project index, and
// - a prompt on a session that owns NO Spaces row must not re-derive the rows
//   (sessionActivity is consumed through a projection narrowed to the
//   sessions the open/hidden panes actually reference).
// Derivation work is observed by counting detail calls — it runs
// exactly once per row per recompute.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/spaces/spaceRowDetail", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@/lib/spaces/spaceRowDetail")>();
	return { spaceRowDetail: vi.fn(original.spaceRowDetail) };
});

import { useSpaces } from "@/components/spaces/useSpaces";
import { publishConversationMetadata } from "@/lib/agents/chat/conversationPresentationState";
import { t } from "@/lib/i18n";
import { spaceRowDetail } from "@/lib/spaces/spaceRowDetail";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import { useStore } from "@/store";
import type { Agent, Project } from "@/types";

const detailCalls = () => vi.mocked(spaceRowDetail).mock.calls.length;

const PROJECTS: Project[] = [
	{ id: "p-root", name: "Repo", path: "/repo", kind: "local", isRepo: true },
	{
		id: "p-nested",
		name: "Repo A",
		path: "/repo/a",
		kind: "local",
		isRepo: true,
	},
];

function seedStore() {
	useStore.setState({
		spaces: [{ id: "desk-1", name: "One" }],
		activeSpaceId: "desk-1",
		projects: PROJECTS,
		layouts: {
			"desk-1": {
				panels: {
					"term:one": {
						contentComponent: "terminal",
						params: { sessionId: "session-1", cwd: "/repo/a" },
					},
					"term:two": {
						contentComponent: "terminal",
						params: { sessionId: "session-2", cwd: "/repo/b" },
					},
				},
			},
		},
		sessionActivity: {
			"session-1": { text: "first prompt", at: 1_000 },
		},
	});
}

afterEach(() => {
	cleanup();
	useHiddenPanes.setState({ hidden: {} });
	useStore.setState({
		layouts: {},
		projects: [],
		sessionActivity: {},
		sessionAgent: {},
		sessionCwd: {},
		sessionTitle: {},
		agents: [],
	});
	vi.clearAllMocks();
});

describe("useSpaces rows derivation cost", () => {
	it("follows exact conversation activity and clears it after conversation changes", () => {
		seedStore();
		useStore.setState({
			agents: [
				{
					id: "history-agent",
					name: "History",
					provider: "codex",
					projectId: "p-root",
					worktreePath: "/repo",
					branch: "main",
					sessionId: "history-session",
					sessionKind: "pty",
					conversationId: "thread-1",
				},
			],
			layouts: {
				"desk-1": {
					panels: {
						"agent:history-agent": { contentComponent: "agent", params: {} },
					},
				},
			},
			sessionActivity: {},
		});
		const hook = renderHook(() => useSpaces());
		expect(hook.result.current[0]?.activityAt).toBeUndefined();
		act(() =>
			publishConversationMetadata("history-agent", "thread-1", {
				title: "History",
				activityAt: new Date(120_000).toISOString(),
				recentPrompts: [
					"Analyze the image",
					"<task-notification><task-id>one</task-id></task-notification>",
				],
			}),
		);
		expect(hook.result.current[0]?.activityAt).toBe(120_000);
		expect(hook.result.current[0]?.detail).toBe("Analyze the image");
		act(() =>
			useStore
				.getState()
				.setSessionActivity("history-session", "Prompt", 180_000),
		);
		expect(hook.result.current[0]?.activityAt).toBe(180_000);
		expect(hook.result.current[0]?.detail).toBe("Prompt");
		act(() =>
			useStore.setState((state) => ({
				agents: state.agents.map((agent) => ({
					...agent,
					conversationId: "thread-2",
				})),
				sessionActivity: {},
			})),
		);
		expect(hook.result.current[0]?.activityAt).toBeUndefined();
		expect(hook.result.current[0]?.detail).not.toBe("Analyze the image");
	});
	it("maps each row to its longest-prefix project via the shared index", () => {
		seedStore();
		const hook = renderHook(() => useSpaces());
		const byKey = new Map(hook.result.current.map((row) => [row.key, row]));
		expect(byKey.get("term:one")?.projectId).toBe("p-nested");
		expect(byKey.get("term:two")?.projectId).toBe("p-root");
		expect(byKey.get("term:one")?.activityAt).toBe(1_000);
	});

	it("does not re-derive rows for a prompt on a session with no row", () => {
		seedStore();
		const hook = renderHook(() => useSpaces());
		const rowsBefore = hook.result.current;
		const baseline = detailCalls();
		expect(baseline).toBeGreaterThan(0);

		act(() => {
			useStore.setState((state) => ({
				sessionActivity: {
					...state.sessionActivity,
					"session-unrelated": { text: "noise", at: 2_000 },
				},
			}));
		});

		// Red on the pre-index tree: every row re-derives (+2 calls) even
		// though no visible row references session-unrelated.
		expect(detailCalls() - baseline).toBe(0);
		// Row identity must also be preserved for downstream memos.
		expect(hook.result.current).toBe(rowsBefore);
	});

	it("does not re-derive rows for cwd updates on sessions with no row", () => {
		seedStore();
		const hook = renderHook(() => useSpaces());
		const rows = hook.result.current;
		const baseline = detailCalls();
		for (let index = 0; index < 32; index += 1) {
			act(() =>
				useStore.getState().setSessionCwd("unrelated", `/noise/${index}`),
			);
		}
		expect(useStore.getState().sessionCwd.unrelated).toBe("/noise/31");
		expect(hook.result.current).toBe(rows);
		expect(detailCalls() - baseline).toBe(0);
	});

	it("follows cwd removal and a newly bound terminal session", () => {
		seedStore();
		const hook = renderHook(() => useSpaces());
		act(() => useStore.getState().setSessionCwd("session-1", "/repo/moved"));
		expect(hook.result.current[0]).toMatchObject({
			cwd: "/repo/moved",
			title: "moved",
			projectId: "p-root",
		});
		act(() =>
			useStore.setState({ sessionCwd: { "session-next": "/repo/a/next" } }),
		);
		expect(hook.result.current[0]).toMatchObject({
			cwd: "/repo/a",
			title: "a",
			projectId: "p-nested",
		});
		act(() =>
			useStore.setState({
				layouts: {
					"desk-1": {
						panels: {
							"term:one": {
								contentComponent: "terminal",
								params: { sessionId: "session-next", cwd: "/fallback" },
							},
						},
					},
				},
			}),
		);
		expect(hook.result.current[0]).toMatchObject({
			sessionId: "session-next",
			cwd: "/repo/a/next",
			title: "next",
		});
		const rows = hook.result.current;
		const baseline = detailCalls();
		act(() => useStore.getState().setSessionCwd("session-1", "/old-session"));
		expect(hook.result.current).toBe(rows);
		expect(detailCalls() - baseline).toBe(0);
		act(() =>
			useStore.getState().setSessionCwd("session-next", "/repo/current"),
		);
		expect(hook.result.current[0]).toMatchObject({
			cwd: "/repo/current",
			title: "current",
		});
	});

	it("keeps hidden agent cwd current across session replacement", () => {
		seedStore();
		useStore.setState({
			agents: [
				{
					id: "hidden-agent",
					name: "Hidden",
					provider: "codex",
					projectId: "p-root",
					worktreePath: "/repo/fallback",
					branch: "main",
					sessionId: "hidden-session",
					sessionKind: "pty",
				},
			],
		});
		useHiddenPanes.getState().markHidden("hidden-agent", "desk-1", "agent:hidden-agent");
		const hook = renderHook(() => useSpaces());
		const hidden = () =>
			hook.result.current.find((row) => row.agentId === "hidden-agent");
		act(() =>
			useStore
				.getState()
				.setSessionCwd("hidden-session", "/repo/hidden-current"),
		);
		expect(hidden()).toMatchObject({
			hidden: true,
			cwd: "/repo/hidden-current",
		});
		act(() =>
			useStore.setState((state) => ({
				agents: state.agents.map((agent) => ({
					...agent,
					sessionId: "hidden-next",
				})),
				sessionCwd: { ...state.sessionCwd, "hidden-next": "/repo/next" },
			})),
		);
		expect(hidden()).toMatchObject({
			hidden: true,
			sessionId: "hidden-next",
			cwd: "/repo/next",
		});
		const baseline = detailCalls();
		act(() => useStore.getState().setSessionCwd("hidden-session", "/old"));
		expect(detailCalls() - baseline).toBe(0);
		act(() => useStore.setState({ sessionCwd: {} }));
		expect(hidden()).toMatchObject({ hidden: true, cwd: "/repo/fallback" });
	});

	it("titles a provider-running terminal by its provider and follows the live cwd", () => {
		seedStore();
		const hook = renderHook(() => useSpaces());
		const before = hook.result.current.find((r) => r.key === "term:one");
		expect(before?.title).toBe("a");
		expect(before?.projectId).toBe("p-nested");

		// The Host's process inspection detects a provider and a cd out of the
		// launch directory; both must reflect without any pane interaction.
		act(() => {
			useStore.setState((state) => ({
				sessionAgent: { ...state.sessionAgent, "session-1": "codex" },
				sessionCwd: { ...state.sessionCwd, "session-1": "/repo/moved" },
			}));
		});

		const row = hook.result.current.find((r) => r.key === "term:one");
		expect(row?.title).toBe("Codex");
		expect(row?.provider).toBe("codex");
		expect(row?.cwd).toBe("/repo/moved");
		expect(row?.projectId).toBe("p-root");
	});

	it("describes a native agent row by the title its CLI set, unless it is only the opaque conversation id", () => {
		// Claude Code and Codex name the terminal through OSC 0/2 and the Host
		// projects that into sessionTitle. The row must follow it the way the
		// pane header does, without the user renaming anything — and must never
		// show a raw conversation id as if it were a name.
		seedStore();
		const agent: Agent = {
			id: "agent-1",
			name: "Claude Code",
			provider: "claude",
			projectId: "p-root",
			worktreePath: "/repo/a/wt",
			branch: "agent/auth",
			sessionId: "session-a",
			sessionKind: "pty",
			conversationId: "01a06261-93d4-7fe3-9d7c-81fba39271bc",
		};
		act(() => {
			useStore.setState({
				agents: [agent],
				// An agent row exists once its pane is in the layout (classifyPanel);
				// the seeded terminals stay so the row set matches the other tests.
				layouts: {
					"desk-1": {
						panels: {
							"term:one": {
								contentComponent: "terminal",
								params: { sessionId: "session-1", cwd: "/repo/a" },
							},
							"term:two": {
								contentComponent: "terminal",
								params: { sessionId: "session-2", cwd: "/repo/b" },
							},
							"agent:agent-1": { contentComponent: "agent", params: {} },
						},
					},
				},
			});
		});
		const hook = renderHook(() => useSpaces());
		const before = hook.result.current.find((r) => r.key === "agent:agent-1");
		expect(before, "the agent row must exist").toBeDefined();
		expect(before?.title).toBe("wt");
		expect(before?.detail).not.toContain("Ship auth flow");

		act(() => {
			useStore.setState((state) => ({
				sessionTitle: { ...state.sessionTitle, "session-a": "Ship auth flow" },
			}));
		});
		expect(
			hook.result.current.find((r) => r.key === "agent:agent-1")?.title,
		).toBe("Ship auth flow");

		act(() => {
			useStore.setState((state) => ({
				agents: state.agents.map((entry) =>
					entry.id === agent.id ? { ...entry, displayName: "fix-uiux" } : entry,
				),
			}));
		});
		const renamed = hook.result.current.find((r) => r.key === "agent:agent-1");
		expect(renamed?.title).toBe("fix-uiux");
		expect(renamed?.detail).toContain("Ship auth flow");

		act(() => {
			useStore.setState((state) => ({
				sessionTitle: {
					...state.sessionTitle,
					"session-a": "01a06261-93d4-7fe3-9d7c-81fba39271bc",
				},
			}));
		});
		expect(
			hook.result.current.find((r) => r.key === "agent:agent-1")?.title,
		).toBe("fix-uiux");
		expect(
			hook.result.current.find((r) => r.key === "agent:agent-1")?.detail,
		).not.toContain("01a06261");
	});

	it("still re-derives when a session with a row reports activity", () => {
		seedStore();
		const hook = renderHook(() => useSpaces());
		const baseline = detailCalls();

		act(() => {
			useStore.setState((state) => ({
				sessionActivity: {
					...state.sessionActivity,
					"session-1": { text: "second prompt", at: 3_000 },
				},
			}));
		});

		expect(detailCalls() - baseline).toBeGreaterThan(0);
		const row = hook.result.current.find((r) => r.key === "term:one");
		expect(row?.activityAt).toBe(3_000);
	});
});

describe("useSpaces remote hmux panes", () => {
	// A remote standalone shell opens under a `term:` key with its host carried
	// only by the binding. On 2026-09-02 such a pane on a WSL host rendered as
	// "Local · ~" under the Local group, indistinguishable from a local shell.
	it("labels a term pane by the host its binding names", () => {
		useStore.setState({
			spaces: [{ id: "desk-1", name: "One" }],
			activeSpaceId: "desk-1",
			projects: [],
			sshHosts: [
				{
					id: "host-1",
					name: "jay-wsl",
					host: "100.109.95.46",
					port: 2222,
					user: "hongj",
					auth: "auto",
				},
			],
			layouts: {
				"desk-1": {
					panels: {
						"term:standalone_remote": {
							contentComponent: "terminal",
							params: {
								sessionId: "standalone_remote",
								binding: {
									schemaVersion: 1,
									runtime: "hmux_standalone_v1",
									source: "ssh",
									hostId: "host-1",
									sessionId: "standalone_remote",
									workspaceId: "workspace-1",
									commandBridgeNonce: "nonce-1",
								},
							},
						},
						"term:local": {
							contentComponent: "terminal",
							params: {
								sessionId: "standalone_local",
								binding: {
									schemaVersion: 1,
									runtime: "hmux_standalone_v1",
									source: "local",
									hostId: "local",
									sessionId: "standalone_local",
									workspaceId: "workspace-1",
									commandBridgeNonce: "nonce-2",
								},
							},
						},
					},
				},
			},
		});
		const hook = renderHook(() => useSpaces());
		const byKey = new Map(hook.result.current.map((row) => [row.key, row]));
		const remote = byKey.get("term:standalone_remote");
		expect(remote?.hostId).toBe("host-1");
		expect(remote?.hostLabel).toBe("jay-wsl");
		expect(remote?.projectName).toBe("jay-wsl");
		const local = byKey.get("term:local");
		expect(local?.hostId).toBeUndefined();
		expect(local?.hostLabel).toBe(t("common.local"));
	});
});
