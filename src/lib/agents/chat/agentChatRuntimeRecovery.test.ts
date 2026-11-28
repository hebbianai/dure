import { describe, expect, it, vi } from "vitest";
import {
	type AgentChatSessionPort,
	currentProviderExit,
	recoverConversationRuntime,
	resumeExitedProvider,
} from "@/lib/agents/chat/agentChatRuntimeRecovery";
import type {
	AgentChatProviderResume,
	AgentChatSessionSnapshot,
} from "@/lib/agents/chat/agentChatSessionView";
import type {
	AgentInteractionBindingV1,
	AgentTimelinePageV1,
	AgentTimelineRowV1,
} from "@/lib/agents/chat/agentConversationContract";
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
const RELAUNCHED: AgentInteractionBindingV1 = {
	...EXITED.binding,
	runtime: { runtimeGeneration: "runtime-2", providerEpoch: "query-2" },
	bindingRevision: 2,
};

function refusal(
	code: string,
	kind: "operation" | "authority_changed" = "operation",
	message = code,
) {
	return new DureBackendRequestError(
		code,
		message,
		kind === "operation"
			? { kind, disposition: "retry_same" }
			: { kind: "authority_changed" },
	);
}

/** A session whose conversation shows `initial`; the backend's recover runs
 * `recover`, and reading the conversation again shows `next()`. */
function resumeSession(
	recover: () => Promise<AgentInteractionBindingV1>,
	next: () => Partial<AgentChatSessionSnapshot> = () => ({}),
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
	const states: Array<AgentChatProviderResume | undefined> = [];
	const port: AgentChatSessionPort = {
		client: { recover: vi.fn(recover) },
		snapshot: () => snapshot,
		update: (patch) => {
			snapshot = { ...snapshot, ...patch };
			states.push(patch.providerResume);
		},
		authority: () => ({ binding: snapshot.page!.binding, routeAuthority }),
		reobserve: vi.fn(async () => {
			snapshot = { ...snapshot, ...next() };
		}),
	};
	return { port, states, current: () => snapshot };
}

describe("recoverConversationRuntime", () => {
	it("returns the binding the backend answered with", async () => {
		const client = { recover: vi.fn(async () => RELAUNCHED) };
		await expect(
			recoverConversationRuntime(client, EXITED.binding, routeAuthority),
		).resolves.toEqual({ kind: "recovered", binding: RELAUNCHED });
		expect(client.recover).toHaveBeenCalledWith(EXITED.binding, routeAuthority);
	});

	it.each([
		["a conflict", refusal("agent_conversation_conflict")],
		[
			"a changed route",
			refusal("agent_conversation_request_invalid", "authority_changed"),
		],
	])("returns %s as a runtime that already moved on", async (_name, error) => {
		const client = { recover: vi.fn(async () => Promise.reject(error)) };
		await expect(
			recoverConversationRuntime(client, EXITED.binding, routeAuthority),
		).resolves.toEqual({ kind: "moved_on", refusal: error });
	});

	it("rejects with any other refusal", async () => {
		const error = refusal("agent_conversation_runtime_unavailable");
		const client = { recover: vi.fn(async () => Promise.reject(error)) };
		await expect(
			recoverConversationRuntime(client, EXITED.binding, routeAuthority),
		).rejects.toBe(error);
	});
});

describe("currentProviderExit", () => {
	const exit = { itemId: "lifecycle-2", reason: "exit 143" };
	const relaunched: AgentChatProviderResume = {
		exitItemId: "lifecycle-2",
		state: "relaunched",
		runtime: RELAUNCHED.runtime,
	};

	it("is the timeline's newest exit", () => {
		expect(currentProviderExit({ page: EXITED })).toEqual(exit);
		expect(
			currentProviderExit({
				page: page(...EXITED.rows, lifecycle(3, "session_ready")),
			}),
		).toBeUndefined();
	});

	it("is over once the conversation is bound to the runtime a Resume relaunched", () => {
		expect(
			currentProviderExit({
				page: { ...EXITED, binding: RELAUNCHED },
				providerResume: relaunched,
			}),
		).toBeUndefined();
		// Not yet read again: the page still names the runtime that exited.
		expect(
			currentProviderExit({ page: EXITED, providerResume: relaunched }),
		).toEqual(exit);
		// A later exit is a new episode.
		expect(
			currentProviderExit({
				page: {
					...page(...EXITED.rows, lifecycle(3, "session_exited")),
					binding: RELAUNCHED,
				},
				providerResume: relaunched,
			}),
		).toEqual({ itemId: "lifecycle-3", reason: "exit 143" });
	});
});

describe("resumeExitedProvider", () => {
	it("clears once the relaunched session's start is on the timeline", async () => {
		const { port, states, current } = resumeSession(
			async () => RELAUNCHED,
			() => ({
				page: {
					...page(...EXITED.rows, lifecycle(3, "session_ready")),
					binding: RELAUNCHED,
				},
			}),
		);
		await resumeExitedProvider(port);
		expect(port.client.recover).toHaveBeenCalledWith(
			EXITED.binding,
			routeAuthority,
		);
		expect(port.reobserve).toHaveBeenCalledOnce();
		expect(states).toEqual([
			{ exitItemId: "lifecycle-2", state: "resuming" },
			{
				exitItemId: "lifecycle-2",
				state: "relaunched",
				runtime: RELAUNCHED.runtime,
			},
			undefined,
		]);
		expect(current().providerResume).toBeUndefined();
	});

	it("ends the exit from the receipt when the backend records no start yet", async () => {
		const { port, current } = resumeSession(
			async () => RELAUNCHED,
			() => ({ page: { ...EXITED, binding: RELAUNCHED } }),
		);
		await resumeExitedProvider(port);
		expect(current().providerResume).toEqual({
			exitItemId: "lifecycle-2",
			state: "relaunched",
			runtime: RELAUNCHED.runtime,
		});
		expect(currentProviderExit(current())).toBeUndefined();
	});

	it("records an unchanged runtime as not restarted without reading again", async () => {
		const { port, current } = resumeSession(async () => EXITED.binding);
		await resumeExitedProvider(port);
		expect(port.reobserve).not.toHaveBeenCalled();
		expect(current().providerResume).toEqual({
			exitItemId: "lifecycle-2",
			state: "not_restarted",
		});
	});

	it("shows a refusal that the session's own recovery tolerates, then reads again", async () => {
		const error = refusal("agent_conversation_conflict");
		const { port, current } = resumeSession(async () => Promise.reject(error));
		await resumeExitedProvider(port);
		expect(port.reobserve).toHaveBeenCalledOnce();
		expect(current().providerResume).toEqual({
			exitItemId: "lifecycle-2",
			state: "failed",
			refusal: {
				code: "agent_conversation_conflict",
				message: "agent_conversation_conflict",
			},
		});
	});

	it("records any other refusal as the backend said it and rethrows it", async () => {
		const error = refusal(
			"agent_conversation_provider_failed",
			"operation",
			"launch_failed: Claude needs to sign in again",
		);
		const { port, current } = resumeSession(async () => Promise.reject(error));
		await expect(resumeExitedProvider(port)).rejects.toBe(error);
		expect(port.reobserve).not.toHaveBeenCalled();
		expect(current().providerResume).toEqual({
			exitItemId: "lifecycle-2",
			state: "failed",
			refusal: {
				code: "agent_conversation_provider_failed",
				message: "launch_failed: Claude needs to sign in again",
			},
		});
	});

	it("leaves an answer for another exit alone when it settles", async () => {
		let answer!: (binding: AgentInteractionBindingV1) => void;
		const { port, current } = resumeSession(
			() => new Promise((resolve) => (answer = resolve)),
		);
		const running = resumeExitedProvider(port);
		// While the backend answers, the session moved on to a later exit.
		const later: AgentChatProviderResume = {
			exitItemId: "lifecycle-3",
			state: "resuming",
		};
		port.update({ providerResume: later });
		answer(EXITED.binding);
		await running;
		expect(current().providerResume).toEqual(later);
	});

	it("does nothing without an exit or while the same Resume runs", async () => {
		for (const state of ["resuming", "relaunched"] as const) {
			const running = resumeSession(async () => EXITED.binding);
			running.port.update({
				providerResume:
					state === "resuming"
						? { exitItemId: "lifecycle-2", state }
						: { exitItemId: "lifecycle-2", state, runtime: RELAUNCHED.runtime },
			});
			await resumeExitedProvider(running.port);
			expect(running.port.client.recover).not.toHaveBeenCalled();
		}
		const live = resumeSession(
			async () => EXITED.binding,
			undefined,
			page(lifecycle(1, "session_ready")),
		);
		await resumeExitedProvider(live.port);
		expect(live.port.client.recover).not.toHaveBeenCalled();
	});
});
