import type { MouseEventHandler } from "react";
import { SessionStatusBadge } from "@/components/sessions/SessionListRow";
import {
	type ProgramStatusNotice,
	type ProgramStatusNoticeKind,
	programStatusNotice,
} from "@/lib/agents/programStatus";
import { t } from "@/lib/i18n";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";

function noticeLabel(kind: ProgramStatusNoticeKind): string {
	switch (kind) {
		case "permission":
			return t("agents.programStatus.permission");
		case "question":
			return t("agents.programStatus.question");
		case "auth":
			return t("agents.programStatus.auth");
		case "blocked":
			return t("agents.programStatus.blocked");
		case "error":
			return t("agents.programStatus.error");
	}
}

/** Program text never appears without saying who wrote it, so a status a
 * program prints cannot pass for Dure's own guidance. */
function noticeDescription({ app, message }: ProgramStatusNotice): string {
	if (message === undefined) {
		return app
			? t("agents.programStatus.reportedBy", { app })
			: t("agents.programStatus.reportedByProgram");
	}
	return app
		? t("agents.programStatus.messageFromApp", { app, message })
		: t("agents.programStatus.messageFromProgram", { message });
}

/** One program report, always with its author. */
export function ProgramStatusNoticeBadge({
	notice,
	onClick,
}: {
	notice: ProgramStatusNotice;
	onClick?: MouseEventHandler<HTMLButtonElement>;
}) {
	return (
		<SessionStatusBadge
			status={noticeLabel(notice.kind)}
			tone={notice.kind === "error" ? "danger" : "attention"}
			description={noticeDescription(notice)}
			onClick={onClick}
		/>
	);
}

/** What the program in this terminal says it needs, beside the Host-owned
 * agent glyph. It stays the program's own report: it never becomes Host
 * attention or a notification, and the next-up list repeats its words only on
 * a row Host attention already put there (NextUpChip). The Spaces row and
 * heading rollup repeat a waiting report, attributed, so a pane out of sight
 * can be noticed while the app is in use (#408). */
export function ProgramStatusBadge({
	runtime,
}: {
	runtime: HmuxAgentRuntimeState | undefined;
}) {
	const notice =
		runtime?.lifecycle === "running"
			? programStatusNotice(runtime.programStatus)
			: undefined;
	return notice ? <ProgramStatusNoticeBadge notice={notice} /> : null;
}
