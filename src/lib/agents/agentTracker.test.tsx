// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notifierMocks = vi.hoisted(() => ({ notifyAgentEvent: vi.fn() }));
vi.mock("@/lib/agents/agentAttentionNotifier", () => notifierMocks);

import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import {
	clearHmuxPaneHealth,
	getHmuxPaneHealth,
	publishHmuxPaneHealthObservation,
} from "@/lib/terminal/hmuxPaneHealthStore";
import type { HmuxPaneHealthObservation } from "@/lib/terminal/terminalHealth";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";
import { installAgentTracker } from "./agentTracker";

const paneHealthId = "detached:term:health-sequence";

function publishPaneHealth(observation: HmuxPaneHealthObservation) {
	publishHmuxPaneHealthObservation(paneHealthId, observation);
}

describe("installAgentTracker", () => {
	let stop: (() => void) | undefined;

	beforeEach(() => {
		notifierMocks.notifyAgentEvent.mockClear();
		clearHmuxPaneHealth(paneHealthId);
		useStore.setState({
			agents: [],
			agentActivity: {},
			sessionAgentRuntimeState: {},
			stats: {
				agentsStarted: 0,
				prsCreated: 0,
				activeMs: 0,
				since: 1,
			},
		});
	});

	afterEach(() => {
		stop?.();
		stop = undefined;
		vi.useRealTimers();
	});

	it("does not scan agent runtime collections for sequence-only pane health", () => {
		let agentScans = 0;
		let semanticStateScans = 0;
		const trackedAgent = agentFixture({
			id: "agent-traversal-sentinel",
			sessionId: "session-traversal-sentinel",
		});
		const agents = new Proxy([trackedAgent] as Agent[], {
			get(target, property, receiver) {
				agentScans += 1;
				return Reflect.get(target, property, receiver);
			},
			ownKeys(target) {
				agentScans += 1;
				return Reflect.ownKeys(target);
			},
		});
		const sessionAgentRuntimeState = new Proxy(
			{
				"session-traversal-sentinel": {
					terminalEpoch: "epoch-sentinel",
					revision: "1",
					observedThroughOutputSeq: "1",
					lifecycle: "running",
					activity: "waiting",
					attention: "none",
					source: "controller_input",
				},
			} as Record<string, HmuxAgentRuntimeState>,
			{
				get(target, property, receiver) {
					semanticStateScans += 1;
					return Reflect.get(target, property, receiver);
				},
				ownKeys(target) {
					semanticStateScans += 1;
					return Reflect.ownKeys(target);
				},
			},
		);
		useStore.setState({ agents, sessionAgentRuntimeState });
		stop = installAgentTracker();

		act(() => {
			publishPaneHealth({
				kind: "frame_presented",
				terminalEpoch: "epoch-1",
				sequence: "41",
			});
		});
		agentScans = 0;
		semanticStateScans = 0;

		act(() => {
			publishPaneHealth({
				kind: "frame_received",
				terminalEpoch: "epoch-1",
				sequence: "42",
			});
		});
		act(() => {
			publishPaneHealth({
				kind: "frame_presented",
				terminalEpoch: "epoch-1",
				sequence: "42",
			});
		});

		expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
			state: "live",
			terminalEpoch: "epoch-1",
			receivedSequence: "42",
			presentedSequence: "42",
		});
		expect(agentScans).toBe(0);
		expect(semanticStateScans).toBe(0);
	});

	it("still projects a new Host semantic state into agent activity", () => {
		const agent = agentFixture({
			id: "agent-semantic",
			sessionId: "session-semantic",
		});
		useStore.setState({ agents: [agent] });
		stop = installAgentTracker();

		act(() => {
			useStore.getState().setSessionAgentRuntimeState("session-semantic", {
				terminalEpoch: "epoch-semantic",
				revision: "1",
				observedThroughOutputSeq: "7",
				lifecycle: "running",
				activity: "working",
				attention: "none",
				source: "controller_input",
			});
		});

		expect(useStore.getState().agentActivity["agent-semantic"]).toBe("working");
	});

	it("flushes completed working time on pagehide", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-29T00:00:10.000Z"));
		const agent = agentFixture({ id: "agent-timed" });
		useStore.setState({
			agents: [agent],
			agentActivity: { [agent.id]: "waiting" },
		});
		stop = installAgentTracker();

		act(() => useStore.getState().setAgentActivity(agent.id, "working"));
		act(() => vi.advanceTimersByTime(2_500));
		act(() => useStore.getState().setAgentActivity(agent.id, "waiting"));
		act(() => window.dispatchEvent(new Event("pagehide")));

		expect(useStore.getState().stats.activeMs).toBe(2_500);
	});

	it("preserves waiting and exited projections with one exit notification", () => {
		const agent = agentFixture({
			id: "agent-lifecycle",
			sessionId: "session-lifecycle",
		});
		useStore.setState({ agents: [agent] });
		stop = installAgentTracker();

		act(() => {
			useStore.getState().setSessionAgentRuntimeState("session-lifecycle", {
				terminalEpoch: "epoch-lifecycle",
				revision: "1",
				observedThroughOutputSeq: "8",
				lifecycle: "running",
				activity: "waiting",
				attention: "none",
				source: "provider_event",
			});
		});
		expect(useStore.getState().agentActivity[agent.id]).toBe("waiting");
		expect(notifierMocks.notifyAgentEvent).not.toHaveBeenCalled();

		act(() => {
			useStore.getState().setSessionAgentRuntimeState("session-lifecycle", {
				terminalEpoch: "epoch-lifecycle",
				revision: "2",
				observedThroughOutputSeq: "9",
				lifecycle: "exited",
				activity: "waiting",
				attention: "none",
				source: "process_lifecycle",
			});
		});

		expect(useStore.getState().agentActivity[agent.id]).toBe("exited");
		expect(notifierMocks.notifyAgentEvent).toHaveBeenCalledOnce();
		expect(notifierMocks.notifyAgentEvent).toHaveBeenCalledWith(
			agent.id,
			"exited",
			expect.any(String),
		);
	});

	it("does not announce an exit it never saw alive (boot replay)", () => {
		// After a reload, agentActivity is empty: nothing in this app lifetime
		// observed the process running. The Host replaying an already-exited
		// session is a baseline observation, not an event to notify.
		const agent = agentFixture({
			id: "agent-replay",
			sessionId: "session-replay",
		});
		useStore.setState({ agents: [agent] });
		stop = installAgentTracker();

		act(() => {
			useStore.getState().setSessionAgentRuntimeState("session-replay", {
				terminalEpoch: "epoch-replay",
				revision: "1",
				observedThroughOutputSeq: "3",
				lifecycle: "exited",
				activity: "waiting",
				attention: "none",
				source: "process_lifecycle",
			});
		});

		expect(useStore.getState().agentActivity[agent.id]).toBe("exited");
		expect(notifierMocks.notifyAgentEvent).not.toHaveBeenCalled();
	});

	it("does not re-announce an exit on a newer epoch of the same dead session", () => {
		// A reattach converges to the exit fact under a new terminal epoch; the
		// agent was already known exited, so the transition happened once.
		const agent = agentFixture({
			id: "agent-reattach",
			sessionId: "session-reattach",
		});
		useStore.setState({
			agents: [agent],
			agentActivity: { [agent.id]: "exited" },
		});
		stop = installAgentTracker();

		act(() => {
			useStore.getState().setSessionAgentRuntimeState("session-reattach", {
				terminalEpoch: "epoch-reattach-2",
				revision: "1",
				observedThroughOutputSeq: "1",
				lifecycle: "exited",
				activity: "waiting",
				attention: "none",
				source: "process_lifecycle",
			});
		});

		expect(useStore.getState().agentActivity[agent.id]).toBe("exited");
		expect(notifierMocks.notifyAgentEvent).not.toHaveBeenCalled();
	});

	it("announces an exit once when a connecting launch dies before running", () => {
		// A fresh launch is seeded as connecting; dying before the first running
		// snapshot is still a real transition the user should hear about.
		const agent = agentFixture({
			id: "agent-crash",
			sessionId: "session-crash",
		});
		useStore.setState({
			agents: [agent],
			agentActivity: { [agent.id]: "connecting" },
		});
		stop = installAgentTracker();

		act(() => {
			useStore.getState().setSessionAgentRuntimeState("session-crash", {
				terminalEpoch: "epoch-crash",
				revision: "1",
				observedThroughOutputSeq: "0",
				lifecycle: "exited",
				activity: "waiting",
				attention: "none",
				source: "process_lifecycle",
			});
		});

		expect(notifierMocks.notifyAgentEvent).toHaveBeenCalledOnce();
	});
});
