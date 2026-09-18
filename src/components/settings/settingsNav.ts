// 설정 왼쪽 탐색 트리 데이터 — SettingsDialog에서 분리(god-file ratchet).
// 페이지를 추가할 때는 여기의 항목·검색 키워드와 SettingsDialog 본문의 페이지
// 스위치를 함께 고친다.
import {
	BarChart3,
	Bell,
	Bot,
	HardDrive,
	Keyboard,
	Lock,
	Palette,
	Shield,
	SlidersVertical,
	Smartphone,
	Wrench,
	TerminalSquare,
	User,
} from "lucide-react";
import { t } from "@/lib/i18n";
import type { SettingsNavigationGroup } from "@/lib/settings/settingsNavigation";

// 설정 페이지 id 유니언 — SettingsDialog와의 순환을 끊기 위해 nav가 소유한다
// (nav 항목의 id 리터럴이 이 유니언의 원천이다).
export type PageId =
	| "accounts"
	| "providers"
	| "agentTooling"
	| "general"
	| "terminal"
	| "appearance"
	| "notifications"
	| "shortcuts"
	| "storage"
	| "environments"
	| "usage"
	| "macos"
	| "mobile"
	| "privacy";


/** Basic mode folds advanced navigation, not page routing or deep links.
 * Accounts, Agent CLI and Agent tooling stay reachable for setup and
 * troubleshooting, regardless of account count.
 * General always stays visible because it hosts the mode toggle. */
export function basicFoldedSettingsPages(): ReadonlySet<PageId> {
	return new Set<PageId>([
		"terminal",
		"mobile",
		"shortcuts",
		"storage",
		"macos",
	]);
}

export function settingsNavigationGroups(
	macPlatform: boolean,
	foldedPages: ReadonlySet<PageId> = new Set(),
): readonly SettingsNavigationGroup<PageId, typeof User>[] {
	return ([
		{
			group: t("AI"),
			items: [
				{ id: "accounts" as const, icon: User, label: t("settings.accounts.title"), keywords: [t("settings.accounts.add"), t("common.systemDefault"), t("common.login"), t("settings.accounts.rename")] },
				{ id: "providers" as const, icon: Bot, label: t("settings.providers.title"), keywords: [t("common.provider"), t("settings.nav.keyword.wiring"), t("settings.providers.notifySource.title"), t("settings.nav.keyword.hooks"), t("settings.nav.keyword.version"), "notify", "CLI", "provider"] },
				{ id: "agentTooling" as const, icon: Wrench, label: t("settings.agentTooling.title"), keywords: [t("common.install"), t("settings.nav.keyword.hooks"), t("settings.nav.keyword.checkpoint"), t("settings.nav.keyword.skills"), "dure", "CLI", "hooks"] },
			],
		},
		{
			group: t("settings.common.app"),
			items: [
				{ id: "general" as const, icon: SlidersVertical, label: t("settings.common.general"), keywords: [t("settings.general.tabOrder.title"), t("settings.general.autoSaveFiles.title"), t("settings.general.autoSaveDelay.title"), t("settings.general.defaultDiffView.title"), t("settings.general.diffWordWrap.title"), t("settings.general.minimap.title"), t("settings.general.markdownReviewNotes.title"), t("settings.general.language.title"), t("settings.recovery.title")] },
				{ id: "terminal" as const, icon: TerminalSquare, label: t("common.terminal"), keywords: [t("settings.terminal.copyOnSelect.title"), t("settings.terminal.osc52.title"), t("settings.terminal.finalResponseOnly.title")] },
				{ id: "mobile" as const, icon: Smartphone, label: t("settings.mobilePairing.title") },
				{ id: "environments" as const, icon: HardDrive, label: t("environments.title"), keywords: ["VM", "SSH", "Pro"] },
			],
		},
		{
			group: t("settings.nav.group.interface"),
			items: [
				{ id: "appearance" as const, icon: Palette, label: t("settings.appearance.title"), keywords: [t("settings.appearance.theme.title"), t("settings.appearance.section.terminalFont"), t("settings.appearance.fontFamily.title"), t("settings.appearance.fontSize.title"), t("settings.appearance.lineHeight.title"), t("settings.appearance.section.statusBar")] },
				{ id: "notifications" as const, icon: Bell, label: t("settings.notifications.title"), keywords: [t("settings.notifications.enable.title"), t("settings.notifications.event.approvalRequired.title"), t("settings.notifications.event.terminalBell.title"), t("settings.notifications.sound.title"), t("settings.notifications.suppressFocused.title")] },
				{ id: "shortcuts" as const, icon: Keyboard, label: t("settings.shortcuts.title"), keywords: [t("settings.shortcuts.list.title"), t("settings.shortcuts.search.title"), t("settings.shortcuts.priority.title")] },
				{ id: "storage" as const, icon: HardDrive, label: t("settings.storage.title"), keywords: [t("settings.storage.appHome.name"), t("settings.nav.keyword.paths"), "DURE_HOME", ".dure", "agents.json", t("settings.nav.keyword.settingsFileLocation")] },
				{ id: "usage" as const, icon: BarChart3, label: t("settings.stats.title"), keywords: [t("settings.stats.activity.agentsStarted"), t("settings.stats.usage.overviewLabel"), t("settings.stats.dailyIntensity.title"), t("settings.stats.tokens.compositionTitle"), t("settings.stats.providers.title")] },
			],
		},
		{
			group: t("settings.nav.group.privacySecurity"),
			items: [
				...(macPlatform
					? [{ id: "macos" as const, icon: Shield, label: t("settings.macosPerms.title"), keywords: [t("settings.macosPerms.microphone.label"), t("settings.macosPerms.camera.label"), t("settings.macosPerms.screenRecording.label"), t("settings.macosPerms.accessibility.label"), t("settings.macosPerms.fullDisk.label"), t("settings.macosPerms.bluetooth.label")] }]
					: []),
				{ id: "privacy" as const, icon: Lock, label: t("settings.privacy.title"), keywords: [t("settings.privacy.title")] },
			],
		},
	] as const)
		.map((group) => ({
			...group,
			items: group.items.filter((item) => !foldedPages.has(item.id)),
		}))
		.filter((group) => group.items.length > 0);
}
