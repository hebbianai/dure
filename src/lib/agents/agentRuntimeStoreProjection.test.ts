import { describe, expect, it } from "vitest";
import type { AgentRuntimeActionProjectionV1 } from "@/lib/agents/agentRuntimeProfileSwitch";
import { agentRuntimeTransitionStatePatch } from "@/lib/agents/agentRuntimeStoreProjection";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { DeferredCredentialSwitchIntentV1 } from "@/types";

function transition(sessionId: string, selectionRevision: number) {
	return {
		routeAuthority: testDureBackendRouteAuthority("backend-a", "generation-a"),
		interactionProfile: "native_cli",
		sessionId,
		selectionRevision,
		launchSelection: { model: null, effort: null, permissionMode: "default" },
	} as AgentRuntimeActionProjectionV1;
}

describe("agent runtime store projection", () => {
	it("keeps the whole Agent snapshot with the newer backend selection", () => {
		const old = agentFixture({ sessionId: "session-old" });
		const current = { ...old, sessionId: "session-new" };
		const state = {
			...useStore.getState(),
			agents: [old],
			agentRuntimeLaunchPresentation: {},
		};
		const committed = {
			...state,
			...agentRuntimeTransitionStatePatch(
				state,
				old,
				current,
				transition("session-new", 4),
			),
		};
		const late = agentRuntimeTransitionStatePatch(
			committed,
			current,
			old,
			transition("session-old", 3),
		);
		expect({ ...committed, ...late }).toEqual(committed);
	});

	it("does not replay a committed snapshot over later user choices", () => {
		const current = agentFixture({ sessionId: "session-new" });
		const state = {
			...useStore.getState(),
			agents: [current],
			agentRuntimeLaunchPresentation: {},
		};
		const committed = {
			...state,
			...agentRuntimeTransitionStatePatch(
				state,
				current,
				current,
				transition("session-new", 4),
			),
		};
		const edited = {
			...current,
			pendingCmd: "next explicit command",
			skipPermissions: true,
		};
		const newer = {
			...committed,
			agents: [edited],
			agentActivity: { "agent-1": "working" as const },
		};
		const replay = agentRuntimeTransitionStatePatch(
			newer,
			edited,
			current,
			transition("session-new", 4),
		);
		expect({ ...newer, ...replay }).toEqual(newer);
	});

	it("accepts newly observed conversation identity at the same runtime revision", () => {
		const current = agentFixture({ sessionId: "session-new" });
		const state = {
			...useStore.getState(),
			agents: [current],
			agentRuntimeLaunchPresentation: {},
		};
		const committed = {
			...state,
			...agentRuntimeTransitionStatePatch(
				state,
				current,
				current,
				transition("session-new", 4),
			),
		};
		const observed = { ...current, conversationId: "conversation-learned" };
		const patch = agentRuntimeTransitionStatePatch(
			committed,
			current,
			observed,
			transition("session-new", 4),
		);
		expect({ ...committed, ...patch }.agents[0].conversationId).toBe(
			"conversation-learned",
		);
	});

	it("retires the old terminal records when a replacement generation commits", () => {
		const current = agentFixture({
			id: "agent-1",
			sessionId: "session-old",
			worktreePath: "/repo/.worktrees/agent-1",
		});
		const projected = { ...current, sessionId: "session-new" };
		const state = {
			...useStore.getState(),
			agents: [current],
			sessionCwd: { "session-old": "/repo/old" },
			sessionTitle: { "session-old": "Old generation" },
		};
		const transition = {
			routeAuthority: testDureBackendRouteAuthority(
				"backend-a",
				"generation-a",
			),
			interactionProfile: "native_cli",
			sessionId: "session-new",
			selectionRevision: 4,
			launchSelection: {
				model: "gpt-5.6-sol",
				effort: "high",
				permissionMode: "auto_edit",
			},
		} as AgentRuntimeActionProjectionV1;

		const patch = agentRuntimeTransitionStatePatch(
			state,
			current,
			projected,
			transition,
		);

		expect(patch.agents).toEqual([projected]);
		expect(patch.sessionCwd).toEqual({
			"session-new": "/repo/.worktrees/agent-1",
		});
		expect(patch.sessionTitle).toEqual({});
		expect(patch.agentActivity).toMatchObject({ "agent-1": "connecting" });
		expect(patch.agentRuntimeLaunchPresentation).toEqual({
			"agent-1": {
				ownerKey: expect.any(String),
				routeAuthority: transition.routeAuthority,
				selectionRevision: 4,
				launchSelection: transition.launchSelection,
			},
		});
	});
});

describe("hydrated deferred runtime request", () => {
	it.each([
		[4, "session-old", true],
		[5, "session-old", false],
		[4, "session-new", false],
	] as const)(
		"projects revision %s and %s with pending=%s",
		(revision, sessionId, preserved) => {
			const pendingCredentialSwitch = {
				sourceSelectionRevision: 4,
				requestId: "queued-1",
			} as DeferredCredentialSwitchIntentV1;
			const current = agentFixture({
				sessionId: "session-old",
				pendingCredentialSwitch,
			});
			const projected = {
				...current,
				sessionId,
				pendingCredentialSwitch: undefined,
			};
			const state = {
				...useStore.getState(),
				agents: [current],
				agentRuntimeLaunchPresentation: {},
			};
			const patch = agentRuntimeTransitionStatePatch(
				state,
				current,
				projected,
				transition(sessionId, revision),
			);
			expect(patch.agents?.[0].pendingCredentialSwitch).toEqual(
				preserved ? pendingCredentialSwitch : undefined,
			);
		},
	);
});
