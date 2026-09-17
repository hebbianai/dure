import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";
import { preparedFilePaths } from "@/lib/files/externalFileDrop";
import type { SessionLocation } from "./gitStatusBridge";
import { t } from "@/lib/i18n";

export interface HubSessionFileDispatch {
	request_id: string;
	session_id: string;
	file: DroppedFilePayload;
}
export type HubSessionFileReply =
	| { kind: "saved"; path: string }
	| { kind: "refused"; detail: string };

export async function answerHubSessionFile(
	request: HubSessionFileDispatch,
	deps: {
		locate: (sessionId: string) => SessionLocation | undefined;
		save: (
			hostId: string | undefined,
			files: DroppedFilePayload[],
		) => Promise<unknown>;
		report: (requestId: string, reply: HubSessionFileReply) => Promise<unknown>;
	},
): Promise<void> {
	let reply: HubSessionFileReply;
	try {
		const location = deps.locate(request.session_id);
		if (!location || (location.kind === "remote" && !location.boxId)) {
			throw new Error(t("sessions.hubGitStatus.sessionMissing"));
		}
		const expected = { ...location };
		const paths = preparedFilePaths(
			await deps.save(location.kind === "remote" ? location.boxId : undefined, [
				request.file,
			]),
			1,
		);
		const current = deps.locate(request.session_id);
		if (
			!current ||
			current.kind !== expected.kind ||
			(current.kind === "local" &&
				expected.kind === "local" &&
				current.worktreePath !== expected.worktreePath) ||
			(current.kind === "remote" &&
				expected.kind === "remote" &&
				(current.boxId !== expected.boxId ||
					current.workspaceId !== expected.workspaceId))
		) {
			throw new Error(t("sessions.hubGitStatus.sessionMissing"));
		}
		reply = { kind: "saved", path: paths[0] };
	} catch (error) {
		reply = {
			kind: "refused",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	await deps.report(request.request_id, reply);
}
