// 우측 하단 사용량 배지 — provider 로고 미터 + 위로 펼쳐지는 상세 팝오버.
// 미터는 provider마다 자기 팝오버를 연다(사용자 요청 2026-07-29): Claude를
// 누르면 Claude 사용량만, Codex를 누르면 Codex 사용량만.
// 숫자는 활성 계정 범위다 — 계정별 귀속의 한계는 usageAccounts가 정한다.
// DesktopBar에서 추출(2026-07-29, god-file 다이어트 + 컴포넌트 테스트 가능화).
// 팝오버 본문은 설정 > 통계 및 사용량과 공유한다 → usage/ProviderUsageDetail.

import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { ClaudeUsagePopover } from "@/components/usage/ClaudeUsagePopover";
import { CodexUsagePopover } from "@/components/usage/CodexUsagePopover";
import { useRecentUsage } from "@/components/usage/useRecentUsage";
import { t } from "@/lib/i18n";
import { claudeCollectorInstall } from "@/lib/ipc";
import { useStore } from "@/store";

export function UsageBadge() {
	const showClaude = useStore((s) => s.uiPrefs?.showClaudeUsage ?? true);
	const showCodex = useStore((s) => s.uiPrefs?.showCodexUsage ?? true);
	const accounts = useStore((s) => s.accounts);
	const {
		u5,
		u24,
		collector,
		setCollector,
		refreshing,
		refreshError,
		refresh,
	} = useRecentUsage(accounts);
	const [installing, setInstalling] = useState(false);

	const installCollector = () => {
		setInstalling(true);
		claudeCollectorInstall()
			.then((s) => setCollector(s))
			.catch((error) => {
				void messageDialog(String(error), {
					title: t("usage.collector.installFailed"),
					kind: "error",
				});
			})
			.finally(() => setInstalling(false));
	};

	if (!u5) return null;
	const nowSec = Date.now() / 1000;

	// provider별로 팝오버를 분리한다 — Claude 미터를 누르면 Claude 사용량만,
	// Codex 미터를 누르면 Codex 사용량만 열린다 (사용자 요청 2026-07-29).
	return (
		<div className="flex items-center gap-1">
			{showClaude && (
				<ClaudeUsagePopover
					u5={u5}
					u24={u24}
					nowSec={nowSec}
					collector={collector}
					installing={installing}
					onInstall={installCollector}
					refresh={{
						busy: refreshing === "claude",
						disabled: refreshing != null,
						failed: refreshError === "claude",
						onRefresh: () => void refresh("claude"),
					}}
				/>
			)}
			{showCodex && (
				<CodexUsagePopover
					u5={u5}
					u24={u24}
					nowSec={nowSec}
					refresh={{
						busy: refreshing === "codex",
						disabled: refreshing != null,
						failed: refreshError === "codex",
						onRefresh: () => void refresh("codex"),
					}}
				/>
			)}
		</div>
	);
}
