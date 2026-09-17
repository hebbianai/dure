/**
 * Answering a phone that tapped one row of a session's changed-file list.
 *
 * The twin of [`gitStatusBridge`], and it exists for the same reason: the phone
 * sends an hmux session id, and the table that turns one into a worktree path
 * lives in this window. What is different is that this request also carries a
 * **path**, and a path becomes argv.
 *
 * # Where the path is admitted
 *
 * Not here. The reader on the far side — `agent_file_diff` locally, the box's
 * gateway over SSH — lists the repository first and refuses a path its own
 * listing did not produce. Re-checking it here would put the rule in two
 * places, and the copy that matters is the one standing next to the repository:
 * only it knows what that repository actually contains at this moment.
 *
 * So this module is the mapping and nothing else: session id → location →
 * patch. It takes its dependencies as arguments so the mapping can be tested
 * without a repository, a window, or a phone.
 */

import { t } from "@/lib/i18n";
import type { SessionLocation } from "@/lib/hub/gitStatusBridge";

/** What the host hands over when a phone taps a row. */
export interface HubFileDiffDispatch {
	request_id: string;
	session_id: string;
	/** The path the phone chose, from a list this laptop or that box produced. */
	path: string;
	/** Present when the tap came from a commit's file list rather than the worktree's. */
	commit?: string;
}

export interface HubFileDiffReply {
	/** Echoed so the phone can line the answer up with the row that asked. */
	path: string;
	/**
	 * The unified diff body.
	 *
	 * Absent for a binary file — which is not the same as an empty string. An
	 * empty body means "nothing in this file changed"; a PNG has no body to
	 * show, and drawing one as the other tells somebody the image is identical
	 * when nobody compared it.
	 */
	patch?: string;
	binary?: boolean;
	/**
	 * The answering side already cut the body.
	 *
	 * The laptop's own ceiling is larger than a box's, so a patch a box cut is
	 * comfortably under it — and would be re-encoded as whole. Losing this flag
	 * makes the phone draw a truncated file as the end of the file, which is the
	 * one thing that screen must never claim.
	 */
	truncated?: boolean;
	added?: number;
	deleted?: number;
	/** Present only when the answer failed. The phone prints it as written. */
	detail?: string;
	/** The kind of refusal, for a caller that must branch rather than print. */
	code?: string;
}

/** One file's patch, as the local backend reports it. Mirrors `AgentFileDiff`. */
export interface AgentFileDiff {
	path: string;
	/** `null` is a binary file. */
	patch: string | null;
	added: number | null;
	deleted: number | null;
}

/** What a box answered about one file. Mirrors the Tauri command. */
export interface RemoteFileDiff {
	kind: "read" | "binary" | "unavailable";
	reason: string | null;
	path: string;
	patch: string | null;
	truncated: boolean;
	added: number | null;
	deleted: number | null;
}

export interface HubFileDiffDeps {
	/** Where this session runs, or `undefined` if this window has no such session. */
	readonly locate: (sessionId: string) => SessionLocation | undefined;
	/** One file's patch from a worktree on this machine. */
	readonly fileDiff: (
		worktreePath: string,
		path: string,
		commit: string | undefined,
	) => Promise<AgentFileDiff>;
	/** One file's patch from a box this window reaches over SSH. */
	readonly remoteFileDiff: (
		boxId: string,
		sessionId: string,
		workspaceId: string,
		path: string,
		commit: string | undefined,
	) => Promise<RemoteFileDiff>;
	/** Hand the answer back to the round trip that is waiting for it. */
	readonly report: (requestId: string, reply: HubFileDiffReply) => Promise<unknown>;
}

/**
 * Answer for a session running on a box this window reaches over SSH.
 *
 * Every failure of *this window* is `session_elsewhere`, exactly as in
 * `gitStatusBridge`: the phone falls back to its own SSH connection on that
 * code, and this laptop can fail where the phone succeeds. Only an answer the
 * box actually produced may say anything else.
 */
async function remoteReply(
	dispatch: HubFileDiffDispatch,
	location: Extract<SessionLocation, { kind: "remote" }>,
	deps: HubFileDiffDeps,
): Promise<HubFileDiffReply> {
	const elsewhere: HubFileDiffReply = {
		path: dispatch.path,
		detail: t("sessions.hubGitStatus.remoteUnavailable"),
		code: "session_elsewhere",
	};
	if (location.boxId === undefined || location.workspaceId === undefined) return elsewhere;

	let answer: RemoteFileDiff;
	try {
		answer = await deps.remoteFileDiff(
			location.boxId,
			dispatch.session_id,
			location.workspaceId,
			dispatch.path,
			dispatch.commit,
		);
	} catch {
		return elsewhere;
	}
	if (answer.kind === "unavailable") {
		// The box answered, and said why. That is not the phone's cue to ask the
		// box itself — it just did, through us.
		return {
			path: dispatch.path,
			detail: t(`sessions.hubFileDiff.remote.${answer.reason ?? "failed"}`),
			code: `remote_${answer.reason ?? "failed"}`,
		};
	}
	if (answer.kind === "binary") return { path: dispatch.path, binary: true };
	return {
		path: dispatch.path,
		patch: answer.patch ?? "",
		...(answer.truncated ? { truncated: true } : {}),
		...(answer.added === null ? {} : { added: answer.added }),
		...(answer.deleted === null ? {} : { deleted: answer.deleted }),
	};
}

async function replyFor(
	dispatch: HubFileDiffDispatch,
	deps: HubFileDiffDeps,
): Promise<HubFileDiffReply> {
	const location = deps.locate(dispatch.session_id);
	if (location === undefined) {
		return { path: dispatch.path, detail: t("sessions.hubGitStatus.sessionMissing") };
	}
	if (location.kind === "remote") return await remoteReply(dispatch, location, deps);
	let answer: AgentFileDiff;
	try {
		answer = await deps.fileDiff(location.worktreePath, dispatch.path, dispatch.commit);
	} catch (error) {
		// The backend's own sentence, not a rewrite of it: "no such path in this
		// comparison" and "this is not a repository" send somebody to different
		// places, and the reader is the only side that knows which one it was.
		return { path: dispatch.path, detail: reasonOf(error) };
	}
	if (answer.patch === null) return { path: dispatch.path, binary: true };
	return {
		path: dispatch.path,
		patch: answer.patch,
		...(answer.added === null ? {} : { added: answer.added }),
		...(answer.deleted === null ? {} : { deleted: answer.deleted }),
	};
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Answer one request.
 *
 * Every failure becomes a refusal with a sentence rather than a throw, for the
 * reason `answerHubGitStatus` gives: the round trip on the other side is
 * waiting, and a thrown error leaves the phone on a spinner until the deadline.
 */
export async function answerHubFileDiff(
	dispatch: HubFileDiffDispatch,
	deps: HubFileDiffDeps,
): Promise<void> {
	await deps.report(dispatch.request_id, await replyFor(dispatch, deps));
}
