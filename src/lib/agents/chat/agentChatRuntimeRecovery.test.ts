import { describe, expect, it, vi } from "vitest";
import {
	type ProviderResumeSession,
	presentProviderExit,
	recoverConversationRuntime,
	resumeExitedProvider,
} from "@/lib/agents/chat/agentChatRuntimeRecovery";
import type { AgentChatSessionSnapshot } from "@/lib/agents/chat/agentChatSessionView";
import type {
	AgentTimelinePageV1,
	AgentTimelineRowV1,
} from "@/lib/agents/chat/agentConversationContract";
import { t } from "@/lib/i18n";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { chatComposerSessionFixture } from "@/test/chatComposerSessionFixture";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const routeAuthority = testDureBackendRouteAuthority("backend", "one");

function lifecycle(
	sequence: number,
	state: "session_ready" | "session_exited",
): AgentTimelineRowV1 {
	return {
		cursor: { epoch: "timeline-1", sequence },
		item: {
			itemId: `lifecycle-${sequence}`,
			turnId: null,
			clientMessageId: null,
			providerMessageId: null,
			createdAtMs: sequence,
			body: {
				type: "lifecycle",
				state,
				detail:
					state === "session_exited" ? '{"code":143,"signal":null}' : null,
			},
		},
	};
}

function page(...rows: AgentTimelineRowV1[]): AgentTimelinePageV1 {
	return { ...chatComposerSessionFixture("claude").page!, rows };
}

const EXITED = page(
	lifecycle(1, "session_ready"),
	lifecycle(2, "session_exited"),
);
const EXIT = { itemId: "lifecycle-2", reason: "exit 143" };

function refusal(
	code: string,
	kind: "operation" | "authority_changed" = "operation",
) {
	return new DureBackendRequestError(
		code,
		"backend request rejected",
		kind === "operation"
			? { kind, disposition: "retry_same" }
			: { kind: "authority_changed" },
	);
}

/** A session whose conversation shows `initial`; `reobserve` reads `next`. */
function resumeSession(
	recover: () => Promise<unknown>,
	next: Partial<AgentChatSessionSnapshot>,
	initial = EXITED,
) {
	let snapshot: AgentChatSessionSnapshot = {
		phase: "ready",
		reconnecting: false,
		sending: false,
		savingGoal: false,
		retryTurnAvailable: false,
		queuedMessages: [],
		interrupting: false,
		loadingOlder: false,
		page: initial,
	};
	const states: Array<AgentChatSessionSnapshot["providerResume"]> = [];
	const session: ProviderResumeSession = {
		client: { recover: vi.fn(recover) as never },
		snapshot: () => snapshot,
		update: (patch) => {
			snapshot = { ...snapshot, ...patch };
			states.push(patch.providerResume);
		},
		authority: () => ({ binding: snapshot.page!.binding, routeAuthority }),
		reobserve: vi.fn(async () => {
			snapshot = { ...snapshot, ...next };
		}),
	};
	return { session, states, current: () => snapshot };
}

describe("recoverConversationRuntime", () => {
	it.each([
		["a conflict", refusal("agent_conversation_conflict")],
		[
			"a changed route",
			refusal("agent_conversation_request_invalid", "authority_changed"),
		],
	])("treats %s as a runtime that already moved on", async (_name, error) => {
		const client = { recover: vi.fn(async () => Promise.reject(error)) };
		await expect(
			recoverConversationRuntime(
				client as never,
				EXITED.binding,
				routeAuthority,
			),
		).resolves.toBeUndefined();
	});

	it("rejects with any other refusal", async () => {
		const error = refusal("agent_conversation_runtime_unavailable");
		const client = { recover: vi.fn(async () => Promise.reject(error)) };
		await expect(
			recoverConversationRuntime(
				client as never,
				EXITED.binding,
				routeAuthority,
			),
		).rejects.toBe(error);
	});
});

describe("resumeExitedProvider", () => {
	it("asks the backend once and clears when the relaunch is observed", async () => {
		const { session, states, current } = resumeSession(
			async () => EXITED.binding,
			{ page: page(...EXITED.rows, lifecycle(3, "session_ready")) },
		);
		await resumeExitedProvider(session);
		expect(session.client.recover).toHaveBeenCalledWith(
			EXITED.binding,
			routeAuthority,
		);
		expect(session.reobserve).toHaveBeenCalledOnce();
		expect(states).toEqual([
			{ exitItemId: "lifecycle-2", state: "resuming" },
			undefined,
		]);
		expect(current().providerResume).toBeUndefined();
	});

	it("records an answer that left the same exit current as not restarted", async () => {
		const { session, current } = resumeSession(async () => EXITED.binding, {});
		await resumeExitedProvider(session);
		expect(current().providerResume).toEqual({
			exitItemId: "lifecycle-2",
			state: "not_restarted",
		});
	});

	it("claims nothing while the conversation is still being read again", async () => {
		const { session, current } = resumeSession(async () => EXITED.binding, {
			reconnecting: true,
		});
		await resumeExitedProvider(session);
		expect(current().providerResume).toBeUndefined();
	});

	it("records the backend's refusal and rethrows it", async () => {
		const error = refusal("agent_conversation_runtime_unavailable");
		const { session, current } = resumeSession(
			async () => Promise.reject(error),
			{},
		);
		await expect(resumeExitedProvider(session)).rejects.toBe(error);
		expect(session.reobserve).not.toHaveBeenCalled();
		expect(current().providerResume).toEqual({
			exitItemId: "lifecycle-2",
			state: "failed",
			failure: "agent_conversation_runtime_unavailable",
		});
	});

	it("does nothing without an exit or while the same Resume runs", async () => {
		const running = resumeSession(async () => EXITED.binding, {});
		running.session.update({
			providerResume: { exitItemId: "lifecycle-2", state: "resuming" },
		});
		await resumeExitedProvider(running.session);
		const live = resumeSession(
			async () => EXITED.binding,
			{},
			page(lifecycle(1, "session_ready")),
		);
		await resumeExitedProvider(live.session);
		expect(running.session.client.recover).not.toHaveBeenCalled();
		expect(live.session.client.recover).not.toHaveBeenCalled();
	});
});

describe("presentProviderExit", () => {
	const resume = t("agents.chat.resumeSession");
	it.each([
		["no Resume yet", undefined, resume, false, undefined],
		[
			"a Resume running",
			{ exitItemId: "lifecycle-2", state: "resuming" } as const,
			t("agents.chat.resumingSession"),
			true,
			undefined,
		],
		[
			"a Resume that did not restart it",
			{ exitItemId: "lifecycle-2", state: "not_restarted" } as const,
			resume,
			false,
			{ text: t("agents.chat.resumeNotRestarted") },
		],
		[
			"a refused Resume",
			{
				exitItemId: "lifecycle-2",
				state: "failed",
				failure: "agent_conversation_runtime_unavailable",
			} as const,
			resume,
			false,
			{
				text: t("agents.chat.resumeFailed", {
					reason: t("agents.chat.error.runtimeUnavailable"),
				}),
				detail: "agent_conversation_runtime_unavailable",
			},
		],
		[
			"a Resume of an earlier exit",
			{ exitItemId: "lifecycle-0", state: "not_restarted" } as const,
			resume,
			false,
			undefined,
		],
	])("presents %s", (_name, state, action, pending, outcome) => {
		expect(presentProviderExit(EXIT, state)).toEqual({
			message: t("agents.chat.providerExitedWithReason", {
				reason: "exit 143",
			}),
			action,
			pending,
			...(outcome && { outcome }),
		});
	});

	it("names no reason for a clean exit", () => {
		expect(
			presentProviderExit({ itemId: "lifecycle-2", reason: null }, undefined)
				.message,
		).toBe(t("agents.chat.providerExited"));
	});
});
