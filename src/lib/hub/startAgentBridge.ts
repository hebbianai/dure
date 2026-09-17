/**
 * Answering a phone that asked this computer to start an agent.
 *
 * The one round trip that *writes*. Everything else the phone asks for is a
 * read, and a read that arrives twice costs nothing; this one costs an agent.
 *
 * # Why the journal, and not `addAgent`
 *
 * Starting an agent is a saga: a durable request, then a worktree, then a
 * registration, then a managed session, each compensatable. `addAgent` is the
 * one step in the middle. Calling it directly would give the phone an agent
 * with no worktree and no journal — and a second way to create one, which is
 * how two paths drift until somebody gets two agents from one press.
 *
 * # Why the press has a name
 *
 * A phone whose answer never arrived cannot tell "it did not start" from "I
 * did not hear". It retries with the same `action_id`, and that id becomes the
 * saga's idempotency key: the backend hands back the *same* receipt, and the
 * resume path finishes the run already in flight. So the retry is free and the
 * second press — a new id — is a second agent, which is what was asked.
 *
 * # Why a seat can be refused
 *
 * The offer is a snapshot. A folder or its SSH host can be removed between the
 * phone reading it and somebody pressing it. An unsupported worktree request
 * also comes back as a refusal with a code, because "nothing happened" is the
 * one answer a phone cannot act on.
 */

import { seatOfLaunchTarget } from "@/lib/hub/launchOffer";
import { t } from "@/lib/i18n";

/** What the hub emits when a phone presses start. */
export interface HubStartAgentDispatch {
	request_id: string;
	target_id: string;
	kind_id: string;
	/** The phone's name for this press. A retry reuses it; a second press does not. */
	action_id: string;
	/** Start in a fresh worktree. Absent from an older phone, which means yes. */
	use_worktree?: boolean;
	/** The branch that worktree gets. Absent means the desk names it. */
	branch?: string | null;
	/** A local folder selected from the phone's folder browser. */
	folder_path?: string | null;
}

/** What this computer sends back. Matches `HubStartAgentReply` in `hub/commands.rs`. */
export interface HubStartAgentReply {
	started: boolean;
	agentId?: string;
	sessionId?: string;
	detail?: string;
	code?: string;
}

/** One seat, as this computer sees it right now. */
export interface StartAgentSeat {
	readonly spaceId: string;
	readonly projectId: string;
	/** Whether this exact project and its host are still registered. */
	readonly startable: boolean;
	readonly worktreeSupported?: boolean;
}

export interface StartAgentPorts {
	/** The seat an offer id names, or nothing when it names none any more. */
	readonly seat: (targetId: string) => StartAgentSeat | undefined;
	/** Whether the space half of a browsed-folder anchor still exists. */
	readonly space: (spaceId: string) => boolean;
	/** Register or reuse a local folder selected outside the published offer. */
	readonly folder: (
		path: string,
	) => Promise<{ projectId: string; startable: boolean }>;
	/** Target eligibility, not a remote installation claim. Undefined is a local browsed folder. */
	readonly kindAllowed: (
		kindId: string,
		projectId: string | undefined,
	) => boolean;
	/**
	 * Make a space able to receive a pane.
	 *
	 * A space that is not mounted has no dock to open a pane in, and the desk
	 * keeps only as many mounted as the machine can afford. Resolves false when
	 * the space could not be brought up, which is a refusal rather than a
	 * crash-landing in whichever space happened to be in front.
	 */
	readonly reveal: (spaceId: string) => Promise<boolean>;
	/** Run the spawn saga. Returns the agent it registered. */
	readonly start: (plan: StartAgentPlan) => Promise<{ agentId: string }>;
	/** That agent's session id, once it has one. */
	readonly session: (agentId: string) => string | undefined;
	/** Hand the answer back to the round trip waiting for it. */
	readonly report: (
		requestId: string,
		reply: HubStartAgentReply,
	) => Promise<unknown>;
}

export interface StartAgentPlan {
	readonly projectId: string;
	readonly spaceId: string;
	readonly kindId: string;
	/** The saga's idempotency key — the phone's press, not a fresh id. */
	readonly actionId: string;
	/** Start in a fresh worktree rather than the folder's own checkout. */
	readonly useWorktree: boolean;
	/**
	 * The branch that worktree gets, when somebody typed one.
	 *
	 * Empty means they left it alone, which is not the same as an empty branch
	 * name: the desk then derives the branch the way its own dialog does.
	 */
	readonly branch?: string;
}

/**
 * The saga is still going and this screen stopped waiting.
 *
 * Distinct from a failure because the two ask different things of a person:
 * a failure invites another press, and this one must not — the run may still
 * be about to succeed. The phone keeps the press's name on this code, so
 * pressing again reaches the laptop as the same press.
 */
export class StartAgentStillRunningError extends Error {
	constructor() {
		super("start_agent_still_running");
		this.name = "StartAgentStillRunningError";
	}
}

function refuse(detail: string, code: string): HubStartAgentReply {
	return { started: false, detail, code };
}

export async function answerHubStartAgent(
	dispatch: HubStartAgentDispatch,
	ports: StartAgentPorts,
): Promise<void> {
	await ports.report(dispatch.request_id, await decide(dispatch, ports));
}

async function decide(
	dispatch: HubStartAgentDispatch,
	ports: StartAgentPorts,
): Promise<HubStartAgentReply> {
	const named = seatOfLaunchTarget(dispatch.target_id);
	const anchor = ports.seat(dispatch.target_id);
	if (!named || (!dispatch.folder_path && !anchor)) {
		return refuse(t("sessions.hubStartAgent.targetMissing"), "target_missing");
	}
	if (!dispatch.folder_path && !anchor?.startable) {
		return refuse(t("sessions.hubStartAgent.targetMissing"), "target_missing");
	}
	if (
		!dispatch.folder_path &&
		anchor?.worktreeSupported === false &&
		dispatch.use_worktree !== false
	) {
		return refuse(
			t("sessions.spawn.remoteWorktreeUnsupported"),
			"remote_worktree_unsupported",
		);
	}
	if (
		!ports.kindAllowed(
			dispatch.kind_id,
			dispatch.folder_path ? undefined : anchor?.projectId,
		)
	) {
		return refuse(t("sessions.hubStartAgent.kindMissing"), "kind_missing");
	}
	let projectId = anchor?.projectId;
	if (dispatch.folder_path) {
		if (!ports.space(named.spaceId)) {
			return refuse(
				t("sessions.hubStartAgent.targetMissing"),
				"target_missing",
			);
		}
		try {
			const folder = await ports.folder(dispatch.folder_path);
			if (!folder.startable)
				return refuse(
					t("sessions.hubStartAgent.targetRemote"),
					"target_remote",
				);
			projectId = folder.projectId;
		} catch (cause) {
			return refuse(
				t("sessions.hubStartAgent.failed", {
					error: cause instanceof Error ? cause.message : String(cause),
				}),
				"folder_unavailable",
			);
		}
	}
	if (!projectId) {
		return refuse(t("sessions.hubStartAgent.targetMissing"), "target_missing");
	}
	if (!(await ports.reveal(named.spaceId))) {
		return refuse(
			t("sessions.hubStartAgent.spaceUnavailable"),
			"space_unavailable",
		);
	}
	try {
		const { agentId } = await ports.start({
			projectId,
			spaceId: named.spaceId,
			kindId: dispatch.kind_id,
			actionId: dispatch.action_id,
			// An older phone says nothing here. Reading that as "no worktree"
			// would put its agent inside somebody's own checkout, so absence
			// means the safer of the two.
			useWorktree: dispatch.use_worktree !== false,
			...(dispatch.branch?.trim() ? { branch: dispatch.branch.trim() } : {}),
		});
		// A started agent without a session id is still started. Reporting it as
		// a failure would send somebody to press again, and the second press is
		// a second agent.
		const sessionId = ports.session(agentId);
		return { started: true, agentId, ...(sessionId ? { sessionId } : {}) };
	} catch (cause) {
		// "아직 도는 중" 은 실패가 아니다. 실패로 접으면 폰이 다시 누르라고 권하고,
		// 그 누름은 이미 뜨고 있는 에이전트 옆에 하나를 더 만든다.
		if (cause instanceof StartAgentStillRunningError) {
			return refuse(
				t("sessions.hubStartAgent.stillStarting"),
				"still_starting",
			);
		}
		return refuse(
			t("sessions.hubStartAgent.failed", {
				error: cause instanceof Error ? cause.message : String(cause),
			}),
			"failed",
		);
	}
}
