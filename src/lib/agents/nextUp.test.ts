import { describe, expect, it } from "vitest";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { deriveNeedsPerson, type NeedsPersonFailure } from "@/lib/agents/needsPerson";
import {
	deriveNextUp,
	type NextUpFacts,
	nextUpEntries,
	nextUpTarget,
} from "@/lib/agents/nextUp";

type Overrides = Partial<Omit<NextUpFacts, "needsPerson">> & {
	waitingSince?: Record<string, number>;
	failures?: Record<string, NeedsPersonFailure>;
};

/** Next up over the needs-person map the window derives from the same facts. */
function facts({ waitingSince = {}, failures = {}, ...overrides }: Overrides): NextUpFacts {
	const base = {
		agentIds: [],
		displayStates: {},
		episodes: {},
		acks: {},
		episodeKinds: {},
		episodeAt: {},
		...overrides,
	};
	return {
		...base,
		needsPerson: deriveNeedsPerson(
			base.agentIds.map((id) => ({ id })),
			{ displayStates: base.displayStates, waitingSince, failures },
		),
	};
}

function exitCapsule(patch: Partial<NeedsPersonFailure> = {}): NeedsPersonFailure {
	return {
		sessionId: "session-1",
		workspaceId: "workspace-1",
		terminalEpoch: "terminal-1",
		code: "provider_exited",
		occurredUnixMs: "1500",
		...patch,
	};
}

describe("deriveNextUp", () => {
	it("lists Host attention oldest wait first, with unobserved starts ahead", () => {
		const nextUp = deriveNextUp(
			facts({
				agentIds: ["late", "working", "unseen", "early", "failed"],
				displayStates: {
					late: "blocked",
					working: "working",
					unseen: "input",
					early: "input",
					failed: "error",
				},
				waitingSince: { late: 3_000, early: 1_000, failed: 2_000 },
			}),
		);
		expect(nextUp.needsYou).toEqual([
			{ agentId: "unseen", reason: "input", state: "input" },
			{ agentId: "early", reason: "input", state: "input", sinceMs: 1_000 },
			{ agentId: "failed", reason: "error", state: "error", sinceMs: 2_000 },
			{ agentId: "late", reason: "approval", state: "blocked", sinceMs: 3_000 },
		]);
		expect(nextUp.results).toEqual([]);
	});

	it("lists an unexpected exit by the Host's exit time, with its sign-in cause", () => {
		const nextUp = deriveNextUp(
			facts({
				agentIds: ["approval", "crashed", "signedOut", "stopped"],
				displayStates: {
					approval: "blocked",
					crashed: "exited",
					signedOut: "exited",
					stopped: "exited",
				},
				waitingSince: { approval: 2_000 },
				episodes: { stopped: 1 },
				episodeKinds: { stopped: "done" },
				failures: {
					crashed: exitCapsule(),
					signedOut: exitCapsule({
						code: "provider_exited_at_sign_in",
						occurredUnixMs: "2500",
					}),
				},
			}),
		);
		expect(nextUp.needsYou).toEqual([
			{ agentId: "crashed", reason: "unexpected_exit", state: "exited", sinceMs: 1_500 },
			{ agentId: "approval", reason: "approval", state: "blocked", sinceMs: 2_000 },
			{
				agentId: "signedOut",
				reason: "unexpected_exit",
				state: "exited",
				sinceMs: 2_500,
				signIn: true,
			},
		]);
		// A stop someone asked for leaves no capsule: its last turn is a result.
		expect(nextUp.results.map((entry) => entry.agentId)).toEqual(["stopped"]);
	});

	it("lists exactly the agents the needs-person map holds", () => {
		const nextUp = deriveNextUp(
			facts({
				agentIds: ["unresolved"],
				failures: { unresolved: exitCapsule() },
			}),
		);
		expect(nextUp.needsYou).toEqual([
			{ agentId: "unresolved", reason: "unexpected_exit", state: "unknown", sinceMs: 1_500 },
		]);
	});

	it("breaks equal waits by agent order", () => {
		const nextUp = deriveNextUp(
			facts({
				agentIds: ["b", "a"],
				displayStates: { a: "blocked", b: "blocked" },
			}),
		);
		expect(nextUp.needsYou.map((item) => item.agentId)).toEqual(["b", "a"]);
	});

	it("keeps an unread result until work resumes", () => {
		const states: Record<string, AgentDisplayState> = {
			resting: "waiting",
			unobserved: "unknown",
			exited: "exited",
			read: "waiting",
			resumed: "working",
			approval: "waiting",
		};
		const nextUp = deriveNextUp(
			facts({
				agentIds: Object.keys(states),
				displayStates: states,
				episodes: {
					resting: 2,
					unobserved: 1,
					exited: 1,
					read: 2,
					resumed: 3,
					approval: 1,
				},
				acks: { resting: 1, read: 2 },
				episodeKinds: {
					resting: "done",
					unobserved: "done",
					exited: "done",
					read: "done",
					resumed: "done",
					approval: "approval",
				},
				episodeAt: { resting: 4_000, exited: 5_000 },
			}),
		);
		expect(nextUp.results).toEqual([
			{ agentId: "unobserved", reason: "result", state: "unknown" },
			{ agentId: "resting", reason: "result", state: "waiting", sinceMs: 4_000 },
			{ agentId: "exited", reason: "result", state: "exited", sinceMs: 5_000 },
		]);
	});

	it("skips agents the watcher has not resolved", () => {
		expect(deriveNextUp(facts({ agentIds: ["a"] }))).toEqual({
			needsYou: [],
			results: [],
		});
	});
});

describe("nextUpTarget", () => {
	const nextUp = deriveNextUp(
		facts({
			agentIds: ["a", "b", "c"],
			displayStates: { a: "blocked", b: "blocked", c: "waiting" },
			episodes: { c: 1 },
			episodeKinds: { c: "done" },
		}),
	);
	const entries = nextUpEntries(nextUp);

	it("starts from the top when the focused agent is not waiting", () => {
		expect(nextUpTarget(entries, undefined)?.agentId).toBe("a");
		expect(nextUpTarget(entries, "elsewhere")?.agentId).toBe("a");
	});

	it("steps past the focused agent through needs-you and then results", () => {
		expect(nextUpTarget(entries, "a")?.agentId).toBe("b");
		expect(nextUpTarget(entries, "b")?.agentId).toBe("c");
		expect(nextUpTarget(entries, "c")?.agentId).toBe("a");
	});

	it("has nowhere to go when nothing waits", () => {
		expect(nextUpTarget([], "a")).toBeUndefined();
	});
});
