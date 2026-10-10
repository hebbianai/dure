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

/** What the program in this terminal says it needs. It stays in the pane the
 * program draws, beside the Host-owned agent glyph, and is never promoted to
 * Host attention, notifications or Spaces. */
export function ProgramStatusBadge({
	runtime,
}: {
	runtime: HmuxAgentRuntimeState | undefined;
}) {
	const notice =
		runtime?.lifecycle === "running"
			? programStatusNotice(runtime.programStatus)
			: undefined;
	if (!notice) return null;
	return (
		<SessionStatusBadge
			status={noticeLabel(notice.kind)}
			tone={notice.kind === "error" ? "danger" : "attention"}
			description={noticeDescription(notice)}
		/>
	);
}
