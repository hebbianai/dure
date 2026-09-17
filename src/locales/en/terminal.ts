import type { EnglishTranslationDictionary } from "@/lib/settings/englishTranslationRegistry";

/** Terminal, command, and usage copy. */
export const terminalEnglishTranslations = {
	"terminal.reconnect.rehostPending": "Session recovery has not finished. Complete it on the computer, then reconnect.",
	"terminal.reconnect.updateRequired": "Update Dure on the computer running this session to reconnect after a host change.",
	"terminal.chrome.scrollToBottom": "Scroll to bottom",
	종료: "Kill",
	"{provider} 계정 전환": "Switch {provider} account",
	"통계 · 사용량": "Stats · Usage",
	"5시간 토큰": "5-hour tokens",
	"5시간": "5 hours",
	"주간 · 전체 모델": "Weekly · All models",
	"주간 · Opus": "Weekly · Opus",
	"입력 · 출력 · 캐시 쓰기": "Input · Output · Cache write",
	"한도 %는 로컬 로그에 없습니다. 수집기를 설치하면 실측 %가 표시됩니다.":
		"Limit % isn't in local logs. Install the collector to show the measured %.",
	"statusLine으로 측정": "Measured via statusLine",
	"실측 % 수집기 설치": "Install measured-% collector",
	"Shell 열기": "Open shell",
	"터미널 입력": "Terminal input",
	"terminal.failure.connection": "Could not connect to the terminal.",
	"terminal.failure.create": "Could not open the terminal: {detail}",
	"terminal.failure.unavailable": "The terminal backend is unavailable.",
	"terminal.recovery.title": "Session disconnected",
	"terminal.recovery.body": "The session process is gone, but the conversation is safe. Resume picks it up exactly where it left off.",
	"terminal.recovery.resume": "Resume session",
	"terminal.recovery.resuming": "Reopening the session…",
	"terminal.recovery.resumeFailed": "That did not work — it is safe to try again.",
	"terminal.recovery.worktreeMissingTitle": "Worktree missing",
	"terminal.recovery.worktreeMissingBody": "The conversation is safe, but the saved worktree for {branch} was removed. Recreate it, or resume in the repository root.",
	"terminal.recovery.recreateWorktree": "Recreate worktree and resume",
	"terminal.recovery.recreatingWorktree": "Recreating the worktree…",
	"terminal.recovery.resumeWithoutWorktree": "Resume without worktree",
	"terminal.recovery.worktreeRecreateFailed": "The worktree could not be recreated. Nothing else was changed.",
	"terminal.recovery.copyDetails": "Copy error details",
	"terminal.recovery.viewDetails": "View error details",
	"terminal.retiredPane.title":
		"This pane belongs to the retired legacy terminal",
	"terminal.retiredPane.body":
		"The legacy PTY runtime was replaced by hmux sessions, so this session can no longer be attached. Close this pane and open a new terminal.",
	"terminal.commandPane.openFailed":
		"Could not open the command pane: {detail}",
	"terminal.chrome.kill": "Kill",
	"terminal.largeView.bringToFront": "Bring the large window forward",
	"terminal.largeView.openNotice": "Open in a large window",
	"terminal.bell.rang": "Terminal bell rang",
	"terminal.input.ariaLabel": "Terminal input",
} satisfies EnglishTranslationDictionary;
