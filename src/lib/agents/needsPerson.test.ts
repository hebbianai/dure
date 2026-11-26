import { afterEach, describe, expect, it } from "vitest";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import {
	currentEpochFailure,
	deriveNeedsPerson,
	NEEDS_PERSON_DISPLAY_STATES,
	NEEDS_PERSON_REASON_BY_STATE,
	type NeedsPersonFailure,
	needsPersonOf,
	needsPersonReason,
} from "@/lib/agents/needsPerson";
import { readNeedsPerson, selectAgentExitFailures } from "@/lib/agents/needsPersonFacts";
import type { HmuxSessionFailure } from "@/lib/ipc/hmuxContracts";
import { useStore } from "@/store";
import {
	hmuxSessionMetadataFixture,
	hmuxSessionSummaryFixture,
	managedAgentFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";

function failure(patch: Partial<HmuxSessionFailure> = {}): HmuxSessionFailure {
	return {
		correlationId: "failure_1",
		sessionId: "session-1",
		workspaceId: "workspace-1",
		terminalEpoch: "terminal-1",
		code: "provider_exited",
		phase: "provider_runtime",
		summary: "Managed provider exited with status 1.",
		exitKind: "provider_error",
		exitCode: 1,
		occurredUnixMs: "1700000000000",
		retryPosture: "never",
		...patch,
	};
}

const DISPLAY_STATES: readonly AgentDisplayState[] = [
	"unknown",
	"connecting",
	"working",
	"error",
	"input",
	"blocked",
	"waiting",
	"exited",
];

afterEach(() => {
	useStore.setState({ agents: [], hmuxSessionMetadata: {} });
	useAgentAttention.setState(useAgentAttention.getInitialState(), true);
});

describe("needsPersonOf", () => {
	it("names every display state that needs a person, and only those", () => {
		expect(new Set(Object.keys(NEEDS_PERSON_REASON_BY_STATE))).toEqual(
			NEEDS_PERSON_DISPLAY_STATES,
		);
		expect(
			Object.fromEntries(
				DISPLAY_STATES.map((displayState) => [
					displayState,
					needsPersonReason({ displayState }),
				]),
			),
		).toEqual({
			unknown: undefined,
			connecting: undefined,
			working: undefined,
			error: "error",
			input: "input",
			blocked: "approval",
			waiting: undefined,
			exited: undefined,
		});
	});

	it("dates a wait by when this window saw it begin", () => {
		expect(needsPersonOf({ displayState: "blocked", waitingSinceMs: 5 })).toEqual({
			reason: "approval",
			sinceMs: 5,
		});
		expect(needsPersonOf({ displayState: "input" })).toEqual({ reason: "input" });
	});

	it("flags an exit capsule whatever its exit kind, dated by the Host", () => {
		expect(
			needsPersonOf({ displayState: "exited", failure: failure() }),
		).toEqual({ reason: "unexpected_exit", sinceMs: 1_700_000_000_000 });
		// A provider that exited cleanly before it had a conversation is still
		// an exit nobody asked for.
		expect(
			needsPersonOf({
				displayState: "exited",
				failure: failure({
					code: "provider_exited_before_conversation_identity",
					exitKind: "normal",
					exitCode: 0,
				}),
			})?.reason,
		).toBe("unexpected_exit");
	});

	it("names a sign-in exit, even with exit code 0", () => {
		expect(
			needsPersonOf({
				displayState: "exited",
				failure: failure({
					code: "provider_exited_at_sign_in",
					phase: "conversation_identity",
					exitKind: "normal",
					exitCode: 0,
				}),
			}),
		).toEqual({
			reason: "unexpected_exit",
			sinceMs: 1_700_000_000_000,
			signIn: true,
		});
	});

	it("lets the exit capsule win over a display state its process can no longer show", () => {
		expect(
			needsPersonReason({ displayState: "blocked", failure: failure() }),
		).toBe("unexpected_exit");
	});

	it("leaves an exit time it cannot read unknown", () => {
		expect(
			needsPersonOf({ failure: failure({ occurredUnixMs: "soon" }) }),
		).toEqual({ reason: "unexpected_exit" });
	});

	it("needs no one for an error its backend continues after the limit resets", () => {
		expect(
			needsPersonOf({ displayState: "error", continuesAtMs: 9_000 }),
		).toBeUndefined();
		// Waiting out the limit answers no question and grants no approval.
		expect(
			needsPersonOf({ displayState: "blocked", continuesAtMs: 9_000 }),
		).toEqual({ reason: "approval" });
		expect(
			needsPersonOf({ displayState: "input", continuesAtMs: 9_000 }),
		).toEqual({ reason: "input" });
		// A provider that exited is not continued in its terminal.
		expect(
			needsPersonOf({
				displayState: "error",
				failure: failure(),
				continuesAtMs: 9_000,
			})?.reason,
		).toBe("unexpected_exit");
	});

	it("flags nothing for an exited agent with no capsule (a stop someone asked for)", () => {
		expect(needsPersonOf({ displayState: "exited" })).toBeUndefined();
		expect(needsPersonOf({})).toBeUndefined();
	});
});

describe("currentEpochFailure", () => {
	it("keeps only the capsule of the session's current terminal epoch", () => {
		const current = hmuxSessionSummaryFixture({ failure: failure() });
		expect(currentEpochFailure(current)).toEqual(failure());
		const stale = hmuxSessionSummaryFixture({
			terminalEpoch: "terminal-2",
			failure: failure(),
		});
		expect(currentEpochFailure(stale)).toBeUndefined();
		const foreign = hmuxSessionSummaryFixture({
			failure: failure({ sessionId: "session-other" }),
		});
		expect(currentEpochFailure(foreign)).toBeUndefined();
		expect(currentEpochFailure(hmuxSessionSummaryFixture())).toBeUndefined();
		expect(currentEpochFailure(undefined)).toBeUndefined();
	});
});

describe("deriveNeedsPerson", () => {
	it("maps the registered agents that need a person and leaves the rest out", () => {
		const exit: NeedsPersonFailure = failure();
		const map = deriveNeedsPerson(
			[{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
			{
				displayStates: { a: "blocked", b: "working", c: "exited", gone: "error" },
				waitingSince: { a: 10 },
				failures: { c: exit },
			},
		);
		expect([...map]).toEqual([
			["a", { reason: "approval", sinceMs: 10 }],
			["c", { reason: "unexpected_exit", sinceMs: 1_700_000_000_000 }],
		]);
	});

	it("leaves out an agent whose failed turn continues after its limit resets", () => {
		const map = deriveNeedsPerson([{ id: "a" }, { id: "b" }], {
			displayStates: { a: "error", b: "error" },
			waitingSince: {},
			failures: {},
			recoveryWaits: { a: 9_000 },
		});
		expect([...map]).toEqual([["b", { reason: "error" }]]);
	});
});

describe("the window's needs-person map", () => {
	function seed(sessionPatch: Parameters<typeof hmuxSessionMetadataFixture>[0]) {
		useStore.setState({
			agents: [
				managedAgentFixture({ id: "managed" }),
				managedAgentFixture({
					id: "other",
					sessionId: "session-2",
					runtimeBinding: managedBindingFixture({ sessionId: "session-2" }),
				}),
			],
			hmuxSessionMetadata: hmuxSessionMetadataFixture(sessionPatch),
		});
	}

	it("reads a managed agent's exit capsule for its current epoch", () => {
		seed({ failure: failure() });
		useAgentAttention.setState({ displayStates: { managed: "exited", other: "input" } });
		expect(readNeedsPerson()).toEqual(
			new Map([
				["managed", { reason: "unexpected_exit", sinceMs: 1_700_000_000_000 }],
				["other", { reason: "input" }],
			]),
		);
	});

	it("drops an error while its backend waits to continue it, and restores it after", () => {
		seed({});
		useAgentAttention.setState({ displayStates: { managed: "error", other: "input" } });
		expect(readNeedsPerson().get("managed")).toEqual({ reason: "error" });
		useAgentAttention.getState().setRecoveryWaits({ managed: 9_000 });
		expect([...readNeedsPerson().keys()]).toEqual(["other"]);
		// Recovery stopped, so the error is the person's again.
		useAgentAttention.getState().setRecoveryWaits({});
		expect(readNeedsPerson().get("managed")).toEqual({ reason: "error" });
	});

	it("keeps its references while terminal output moves the session metadata", () => {
		seed({ failure: failure(), outputSeq: "1" });
		useAgentAttention.setState({ displayStates: { managed: "exited" } });
		const failures = selectAgentExitFailures(useStore.getState());
		const map = readNeedsPerson();
		useStore.setState({
			hmuxSessionMetadata: hmuxSessionMetadataFixture({
				failure: failure(),
				outputSeq: "2",
			}),
		});
		expect(selectAgentExitFailures(useStore.getState())).toBe(failures);
		expect(readNeedsPerson()).toBe(map);
		// A display-state change that leaves the map as it was keeps it too.
		useAgentAttention.setState({ displayStates: { managed: "exited", other: "working" } });
		expect(readNeedsPerson()).toBe(map);
	});

	it("drops an exit once the session starts a new terminal epoch", () => {
		seed({ failure: failure() });
		useAgentAttention.setState({ displayStates: { managed: "exited" } });
		expect(readNeedsPerson().size).toBe(1);
		useStore.setState({
			hmuxSessionMetadata: hmuxSessionMetadataFixture({
				terminalEpoch: "terminal-2",
				failure: failure(),
			}),
		});
		useAgentAttention.setState({ displayStates: { managed: "working" } });
		expect(readNeedsPerson().size).toBe(0);
	});
});
