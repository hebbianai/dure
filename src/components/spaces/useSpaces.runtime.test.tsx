// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSpaces } from "@/components/spaces/useSpaces";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
import { spaceRowDetail } from "@/lib/spaces/spaceRowDetail";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import { useStore } from "@/store";

vi.mock("@/lib/spaces/spaceRowDetail", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@/lib/spaces/spaceRowDetail")>();
	return { spaceRowDetail: vi.fn(original.spaceRowDetail) };
});

const initial = useStore.getState();
const initialAttention = useAgentAttention.getState();
const initialHidden = useHiddenPanes.getState();
const calls = () => vi.mocked(spaceRowDetail).mock.calls.length;
const runtime = (
	attention: HmuxAgentRuntimeState["attention"],
	revision = "1",
): HmuxAgentRuntimeState => ({
	terminalEpoch: "epoch-1",
	revision,
	observedThroughOutputSeq: "1",
	lifecycle: "running",
	activity: "waiting",
	attention,
	source: "provider_event",
});

function seed() {
	useStore.setState({
		spaces: [{ id: "desk-1", name: "One" }],
		activeSpaceId: "desk-1",
		projects: [
			{
				id: "project-1",
				name: "Repo",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agents: [
			{
				id: "agent-1",
				name: "Agent",
				provider: "codex",
				projectId: "project-1",
				worktreePath: "/repo/agent",
				branch: "main",
				sessionId: "agent-session",
				sessionKind: "pty",
			},
		],
		layouts: {
			"desk-1": {
				panels: {
					"term:one": {
						contentComponent: "terminal",
						params: { sessionId: "terminal-session", cwd: "/repo/terminal" },
					},
					"agent:agent-1": { contentComponent: "agent", params: {} },
				},
			},
		},
	});
}

afterEach(() => {
	cleanup();
	useStore.setState(initial, true);
	useAgentAttention.setState(initialAttention, true);
	useHiddenPanes.setState(initialHidden, true);
	vi.clearAllMocks();
});

const unrelatedPublications = {
	"agent activity": () =>
		useStore.getState().setAgentActivity("unrelated", "working"),
	"semantic runtime": () =>
		useStore
			.getState()
			.setSessionAgentRuntimeState("unrelated", runtime("approval_required")),
	title: () =>
		useStore.getState().setSessionTitle("unrelated", "Unrelated title"),
	"detected provider": () =>
		useStore.getState().setSessionAgent("unrelated", "claude"),
	"pinned provider": () =>
		useStore.getState().setSessionAgentPin("unrelated", "codex"),
	"display state": () =>
		useAgentAttention.getState().applyAttentionResolution({
			displayStates: { unrelated: "working" },
			bumps: [],
			consumedArms: [],
		}),
	"unread episode": () =>
		useAgentAttention.getState().applyAttentionResolution({
			displayStates: {},
			bumps: [{ agentId: "unrelated", kind: "done" }],
			consumedArms: [],
		}),
	acknowledgement: () => useAgentAttention.getState().ack("unrelated"),
};

describe("Spaces row runtime subscriptions", () => {
	it.each(Object.entries(unrelatedPublications))(
		"ignores unrelated %s publications",
		(_name, publish) => {
			seed();
			useAgentAttention.setState({ episodes: { unrelated: 1 } });
			const hook = renderHook(() => useSpaces());
			const rows = hook.result.current;
			const before = calls();
			act(publish);
			expect(hook.result.current).toBe(rows);
			expect(calls() - before).toBe(0);
		},
	);

	it("preserves provider precedence, semantic attention and runtime removal", () => {
		seed();
		const hook = renderHook(() => useSpaces());
		const terminal = () =>
			hook.result.current.find((row) => row.key === "term:one");
		act(() => {
			useStore.getState().setSessionAgent("terminal-session", "claude");
			useStore.getState().setSessionAgentRuntimeState("terminal-session", {
				...runtime("none"),
				activity: "working",
			});
		});
		expect(terminal()).toMatchObject({
			provider: "claude",
			displayState: "working",
		});
		act(() =>
			useStore.getState().setSessionAgentPin("terminal-session", "codex"),
		);
		expect(terminal()?.provider).toBe("codex");
		act(() =>
			useStore
				.getState()
				.setSessionAgentRuntimeState(
					"terminal-session",
					runtime("approval_required", "2"),
				),
		);
		expect(terminal()?.displayState).toBe("blocked");
		act(() =>
			useStore
				.getState()
				.setSessionAgentRuntimeState("terminal-session", runtime("none", "3")),
		);
		expect(terminal()?.displayState).toBe("waiting");
		act(() =>
			useStore
				.getState()
				.setSessionAgentRuntimeState("terminal-session", runtime("error", "1")),
		);
		expect(terminal()?.displayState).toBe("waiting");
		act(() => useStore.getState().setSessionAgentPin("terminal-session", null));
		expect(terminal()?.provider).toBe("claude");
		act(() => useStore.getState().forgetSessionRuntime(["terminal-session"]));
		expect(terminal()).toMatchObject({
			provider: null,
			displayState: undefined,
		});
		act(() => {
			useStore.getState().setSessionAgent("terminal-session", "codex");
			useStore
				.getState()
				.setSessionAgentRuntimeState("terminal-session", runtime("none"));
		});
		expect(terminal()).toMatchObject({
			provider: "codex",
			displayState: "waiting",
		});
	});

	it("keeps hidden agent activity and unread facts fresh without reclassifying them", () => {
		seed();
		useStore.setState({ layouts: {} });
		useHiddenPanes.getState().markHidden("agent-1", "desk-1", "agent:agent-1");
		const hook = renderHook(() => useSpaces());
		act(() => useStore.getState().setAgentActivity("agent-1", "working"));
		expect(hook.result.current[0]).toMatchObject({
			hidden: true,
			displayState: "working",
			unread: false,
		});
		act(() =>
			useAgentAttention.getState().applyAttentionResolution({
				displayStates: { "agent-1": "blocked" },
				bumps: [{ agentId: "agent-1", kind: "approval" }],
				consumedArms: [],
			}),
		);
		expect(hook.result.current[0]).toMatchObject({
			displayState: "blocked",
			unread: true,
		});
		act(() => useAgentAttention.getState().ack("agent-1"));
		expect(hook.result.current[0]).toMatchObject({
			displayState: "blocked",
			unread: false,
		});
		act(() =>
			useAgentAttention.getState().applyAttentionResolution({
				displayStates: {},
				bumps: [],
				consumedArms: [],
			}),
		);
		expect(hook.result.current[0]?.displayState).toBe("working");
		act(() =>
			useStore.getState().setSessionTitle("agent-session", "Current task"),
		);
		expect(hook.result.current[0]?.title).toBe("Current task");
	});
});
