import {
	Check,
	Folder,
	LayoutPanelLeft,
	Terminal,
	User,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { ProviderInstallCommandRow } from "@/components/agents/ProviderInstallCommandRow";
import { AgentLaunchPreferences } from "@/components/settings/AgentLaunchPreferences";
import { OnboardingHero } from "@/components/onboarding/OnboardingHero";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	NODE_NPM_INSTALL_GUIDE,
	type ProviderInstallCommand,
	providerInstallUsesNpm,
} from "@/lib/agents/providerInstallCommand";
import { t } from "@/lib/i18n";
import type { OnboardingStep } from "@/lib/onboarding/onboardingSteps";
import { openExternalUrl } from "@/lib/platform/externalOpen";
import { cn } from "@/lib/utils";
import { PROVIDERS, type Provider } from "@/types";

/** 확인 항목 한 줄 — 도메인 아이콘 상자 + 제목/설명, 오른쪽에 필요한 행동만. */
function CheckRow({
	icon,
	title,
	detail,
	action,
	children,
	first = false,
	last = false,
}: {
	icon: ReactNode;
	title: string;
	detail: ReactNode;
	action?: ReactNode;
	children?: ReactNode;
	first?: boolean;
	last?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex w-full items-center gap-2.5 px-4 pb-5 pt-4",
				first && "border-t border-border",
				!last && "border-b border-border",
			)}
		>
			<div className="flex min-w-0 flex-1 items-start gap-2">
				<span className="flex shrink-0 items-center justify-center rounded-sm border border-border p-1 text-muted-foreground">
					{icon}
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-3">
					<div className="flex min-w-0 items-start gap-3">
						<div className="flex min-w-0 flex-1 flex-col gap-1.5">
							<p className="pt-1 text-sm/none font-medium text-foreground">
								{title}
							</p>
							<div className="text-[13px]/4 text-muted-foreground">{detail}</div>
						</div>
						{action}
					</div>
					{children}
				</div>
			</div>
		</div>
	);
}

/** 접었을 때 보여 주는 배지 수 — Figma 2491:57812이 한 줄에 담는 개수. */
const COLLAPSED_AGENT_BADGES = 6;

/** 감지된 CLI 하나 (Figma 2491:57839) — 아이콘 상자 + 이름. */
function AgentBadge({ provider }: { provider: Provider }) {
	return (
		<Badge
			variant="secondary"
			className="h-6 gap-1 rounded-md px-2 py-1 text-[13px]/4 font-normal"
		>
			<span className="flex size-3.5 shrink-0 items-center justify-center rounded-[4px]">
				<ProviderGlyph provider={provider} className="size-3" />
			</span>
			<span className="pb-px">{PROVIDERS[provider].label}</span>
			<Check className="size-3 text-status-done" />
			<span className="pb-px text-status-done">{t("common.installed")}</span>
		</Badge>
	);
}

function stepDetail(
	step: OnboardingStep,
	done: ReactNode,
	pending: string,
	unknown?: string,
): ReactNode {
	if (step.state === "done") return done;
	if (step.state === "unknown" && unknown) return unknown;
	return pending;
}

/** 세션 없이 폴더에서 시작하는 화면 (Figma dure-UI 2443:90298).
 *  세션 가져오기와 같은 껍데기를 쓰되, 본문은 환경 확인 목록이다. */
export function OnboardingFolderStart({
	steps,
	projectCount,
	installedProviders,
	missingCommands,
	onInstallProvider,
	actionBarTarget,
	onOpenFolder,
	onStart,
	onOpenTerminal,
	onBack,
}: {
	steps: readonly OnboardingStep[];
	projectCount: number;
	installedProviders: readonly Provider[];
	missingCommands: readonly ProviderInstallCommand[];
	onInstallProvider: (entry: ProviderInstallCommand) => void;
	actionBarTarget?: HTMLElement | null;
	onOpenFolder: () => void;
	onStart: () => void;
	onOpenTerminal: () => void;
	onBack?: () => void;
}) {
	const [folder, cli, login, firstPane] = steps;
	const [agentsExpanded, setAgentsExpanded] = useState(false);
	const shownProviders = agentsExpanded
		? installedProviders
		: installedProviders.slice(0, COLLAPSED_AGENT_BADGES);
	const hiddenCount = installedProviders.length - shownProviders.length;
	const npmProviders = missingCommands
		.filter((entry) => providerInstallUsesNpm(entry.provider))
		.map((entry) => PROVIDERS[entry.provider].label);

	const actionBar = (
		<div className="flex items-center justify-between gap-4">
			<p className="min-w-0 truncate pb-0.5 pr-1 text-xs text-muted-foreground">
				{t("onboarding.start.detectionSummary", {
					folders: projectCount,
					cli:
						cli.state === "done"
							? t("onboarding.start.cliDetectedCount", { n: installedProviders.length })
							: cli.state === "unknown"
								? t("onboarding.start.cliChecking")
								: t("onboarding.start.cliUnverified"),
				})}
			</p>
			<div className="flex shrink-0 items-center gap-3">
				{onBack && (
					<Button
						size="lg"
						variant="ghost"
						className="h-10 rounded-md px-8"
						onClick={onBack}
					>
						{t("onboarding.start.fromSessions")}
					</Button>
				)}
				<Button
					size="lg"
					className="h-10 rounded-md px-8"
					onClick={onStart}
				>
					{t("onboarding.start.openFolderAndStart")}
				</Button>
			</div>
		</div>
	);

	return (
		<section className="flex items-start justify-center px-6 pb-8 pt-10">
			<div className="flex w-full min-w-0 max-w-[896px] flex-col gap-3">
				<OnboardingHero
					title={t("onboarding.start.title")}
					description={t("onboarding.start.description")}
				/>
				<AgentLaunchPreferences className="py-6" />
				<div className="flex w-full flex-col py-9">
					<CheckRow
						first
						icon={<Folder className="size-3" />}
						title={t("common.workingFolder")}
						detail={stepDetail(
							folder,
							t("onboarding.checklist.foldersRegistered", { count: String(projectCount) }),
							t("onboarding.checklist.foldersEmpty"),
						)}
						action={
							<Button
								size="default"
								variant="outline"
								className="h-8 shrink-0 rounded-md px-3"
								onClick={onOpenFolder}
							>
								{t("onboarding.checklist.openFolder")}
							</Button>
						}
					/>
					<CheckRow
						icon={<Terminal className="size-3" />}
						title={t("onboarding.checklist.agentCliTitle")}
						detail={
							cli.state === "done"
								? t("onboarding.checklist.agentsDetected", {
										n: installedProviders.length,
									})
								: cli.state === "unknown"
									? t("onboarding.checklist.stillChecking")
									: t("onboarding.checklist.agentsNotDetected")
						}
						action={
							<Button
								size="default"
								variant="outline"
								className="h-8 shrink-0 rounded-md px-3"
								onClick={onOpenTerminal}
							>
								{t("common.openTerminal")}
							</Button>
						}
					>
						{cli.state === "done" || missingCommands.length > 0 ? (
							<div className="flex w-full flex-col gap-2">
								{cli.state === "done" ? (
									// 감지된 CLI는 이름표로 늘어놓는다 — 한 줄을 넘기면 접고,
									// 남은 개수를 눌러 펼친다(2491:57812 / 2491:57639).
									<div className="flex w-full flex-wrap content-start items-start gap-1.5">
										{shownProviders.map((provider) => (
											<AgentBadge key={provider} provider={provider} />
										))}
										{hiddenCount > 0 || agentsExpanded ? (
											<Button
												variant="ghost"
												size="sm"
												aria-expanded={agentsExpanded}
												className="h-6 rounded-md px-3 text-xs font-normal text-muted-foreground"
												onClick={() => setAgentsExpanded((value) => !value)}
											>
												{agentsExpanded ? t("onboarding.checklist.showLess") : t("onboarding.checklist.showMoreCount", { n: hiddenCount })}
											</Button>
										) : null}
									</div>
								) : null}
								{missingCommands.length > 0 ? (
									<div className="flex w-full flex-col gap-1" data-selectable>
										{missingCommands.map((entry) => (
											<ProviderInstallCommandRow
												key={entry.provider}
												entry={entry}
												onInstall={onInstallProvider}
											/>
										))}
										{npmProviders.length > 0 && (
											<div className="flex flex-wrap items-center gap-x-2 pt-2 text-xs text-muted-foreground">
												<p>
													{t("onboarding.install.npmRequired", {
														providers: npmProviders.join(", "),
													})}
												</p>
												<Button
													variant="link"
													size="sm"
													className="h-auto px-0 text-xs"
													onClick={() =>
														void openExternalUrl(NODE_NPM_INSTALL_GUIDE)
													}
												>
													{t("onboarding.install.nodeSetup")}
												</Button>
											</div>
										)}
									</div>
								) : null}
							</div>
						) : null}
					</CheckRow>
					<CheckRow
						icon={<User className="size-3" />}
						title={t("common.login")}
						detail={stepDetail(
							login,
							t("onboarding.checklist.signedIn"),
							t("onboarding.checklist.signInOnFirstRun"),
						)}
					/>
					<CheckRow
						last
						icon={<LayoutPanelLeft className="size-3" />}
						title={t("onboarding.checklist.firstPaneTitle")}
						detail={stepDetail(
							firstPane,
							t("onboarding.checklist.firstPaneOpen"),
							t("onboarding.checklist.firstPaneAuto"),
						)}
					/>
				</div>
			</div>
			{actionBarTarget ? createPortal(actionBar, actionBarTarget) : null}
		</section>
	);
}
