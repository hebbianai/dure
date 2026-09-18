// 첫 실행 가이드 pane (hebbian-frontend-vfse).
//
// 모달 마법사가 아니라 pane인 이유: 온보딩 조사의 채택 패턴 #4(한 페이지·즉시
// 적용·재진입 가능). 모달은 뒤의 앱을 가리고 중간에 나가면 상태가 사라진다.
// pane이면 터미널 옆에 두고 오갈 수 있고, 닫았다 열어도 같은 상태다.
//
// 단계 판정은 lib/onboardingSteps(순수)에 있고 여기는 렌더·배선만 한다.
// 완료 상태를 저장하지 않는다 — 매번 라이브로 판정하므로 화면이 실제와
// 어긋나지 않는다.
import type { IDockviewPanelProps } from "dockview-react";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { OnboardingFolderStart } from "@/components/onboarding/OnboardingFolderStart";
import { OnboardingImportPreview } from "@/components/onboarding/OnboardingImportPreview";
import { useOnboardingPanelState } from "@/components/panels/useOnboardingPanelState";
import { useLocationAdd } from "@/components/spaces/useLocationAdd";
import { GitAvailabilityNotice } from "@/components/scm/GitAvailabilityNotice";
import { useGitAvailability } from "@/components/scm/useGitAvailability";
import { IconButton } from "@/components/ui/icon-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import {
	detectInstalledProviders,
	useVisibleProviders,
} from "@/lib/agents/agentInstalls";
import {
	INSTALLABLE_PROVIDER_IDS,
	type ProviderInstallCommand,
	providerInstallCommand,
	providerInstallExecutionCommand,
} from "@/lib/agents/providerInstallCommand";
import { t } from "@/lib/i18n";
import { hasPendingOnboardingImportJournal } from "@/lib/onboarding/onboardingImportJournal";
import { onboardingSteps } from "@/lib/onboarding/onboardingSteps";
import { cn } from "@/lib/utils";
import { openLocalTerminalPanel } from "@/lib/workspace/dock";
import { openCommandTerminalOn } from "@/lib/workspace/dock/openCommandTerminal";
import { PROVIDERS, type Provider } from "@/types";

export function OnboardingPanel(props: IDockviewPanelProps) {
	const git = useGitAvailability(null);
	const desktopId = useWorkspaceRuntimeDesktopId();
	const {
		projects,
		installedAgents: storeInstalled,
		accounts,
		activeAccounts,
		publishInstalledAgents,
	} = useOnboardingPanelState();
	// 가이드는 열릴 때마다 직접 프로브한다 — 재진입의 의미가 "다시 확인"이기
	// 때문이다. 기동 시 캐시된 store 값을 신뢰하면 방금 설치한 CLI를 계속
	// "감지되지 않음"으로 보여준다. undefined = 확인 중.
	const [probed, setProbed] = useState<Provider[] | undefined>();
	useEffect(() => {
		let disposed = false;
		void detectInstalledProviders()
			.then((providers) => {
				if (disposed) return;
				setProbed(providers);
				// 앱 전체가 같은 결과를 쓰게 store도 갱신한다(메뉴의 provider 목록 등).
				publishInstalledAgents(providers);
			})
			// 프로브 실패는 막지 않는다 — store 값으로 계속 진행한다(fail-open).
			.catch(() => {
				if (!disposed) setProbed(storeInstalled);
			});
		return () => {
			disposed = true;
		};
		// storeInstalled는 위 setInstalledAgents로 바뀌므로 의존성에 넣지 않는다.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const visibleProviders = useVisibleProviders();
	const installed = (probed ?? storeInstalled).filter((provider) =>
		visibleProviders.includes(provider),
	);
	const detectionPending = probed === undefined;
	const { pickLocalFolder } = useLocationAdd();
	const [paneCount, setPaneCount] = useState(0);
	const [sessionImportAvailable, setSessionImportAvailable] = useState<
		boolean | undefined
	>();
	const [importActionBarTarget, setImportActionBarTarget] =
		useState<HTMLDivElement | null>(null);
	const [folderActionBarTarget, setFolderActionBarTarget] =
		useState<HTMLDivElement | null>(null);
	// null = 아직 고르지 않음(발견 결과가 정한다). 사용자가 한 번 고르면 그 선택이
	// 이긴다 — 뒤늦게 도착한 스캔 결과가 화면을 빼앗지 않게 한다.
	const [chosenView, setChosenView] = useState<"sessions" | "folder" | null>(
		null,
	);

	// pane 수는 dockview가 들고 있다 — 이 pane 자신은 세지 않는다(가이드가 열려
	// 있다는 것이 "첫 pane을 열었다"가 될 수는 없다).
	useEffect(() => {
		const api = props.containerApi;
		const sync = () =>
			setPaneCount(
				api.panels.filter((panel) => panel.id !== props.api.id).length,
			);
		sync();
		const added = api.onDidAddPanel(sync);
		const removed = api.onDidRemovePanel(sync);
		return () => {
			added.dispose();
			removed.dispose();
		};
	}, [props.containerApi, props.api.id]);

	// 계정 프로필·활성 계정은 로그인한 적이 있다는 로컬 증거다 — 라이브 인증
	// 프로브는 쓰지 않는다(onboardingSteps 헤더의 실수 #3).
	const accountProviders = [
		...new Set([
			...accounts.map((account) => account.provider),
			...(Object.keys(activeAccounts) as Provider[]),
		]),
	].filter((provider) => visibleProviders.includes(provider));
	const steps = onboardingSteps({
		projectCount: projects.length,
		installedProviders: installed,
		detectionPending,
		accountProviders,
		paneCount,
	});
	// 설치 명령을 아는 provider 중 아직 감지되지 않은 것 — 더 쓸 수 있다는 안내.
	const missingCommands = INSTALLABLE_PROVIDER_IDS.flatMap(
		(candidate) => {
			if (!visibleProviders.includes(candidate) || installed.includes(candidate))
				return [];
			const command = providerInstallCommand(candidate);
			return command ? [{ provider: candidate, command }] : [];
		},
	);

	const openTerminal = () => {
		if (desktopId) openLocalTerminalPanel(desktopId);
	};
	const startFromFolder = async () => {
		const project = await pickLocalFolder();
		if (project) props.api.close();
	};
	const installProvider = (entry: ProviderInstallCommand) => {
		openCommandTerminalOn(props.containerApi, {
			title: `${PROVIDERS[entry.provider].label} ${t("common.install")}`,
			command: providerInstallExecutionCommand(
				entry.provider,
				entry.command,
			),
			closeOnSuccess: true,
		});
	};

	const onboardingImportVisible =
		projects.length === 0 || hasPendingOnboardingImportJournal();
	const sessionsReachable =
		onboardingImportVisible && sessionImportAvailable !== false;
	// 세션 화면을 골라 뒀더라도 가져올 세션이 사라지면(재검색 결과 0개 등) 폴더
	// 화면으로 되돌린다 — 그 화면은 아무것도 그리지 않으므로 선택을 존중하면
	// 빈 pane에 갇히고 빠져나갈 버튼조차 없다.
	const view =
		chosenView === "sessions" && !sessionsReachable
			? "folder"
			: (chosenView ?? (sessionsReachable ? "sessions" : "folder"));
	// 세션 화면은 발견된 세션이 있을 때만 하단 바를 갖는다(스캔 중에는 없음).
	const showActionSlot =
		view === "folder" || (sessionsReachable && sessionImportAvailable === true);

	return (
		<div className="relative flex h-full min-h-0 flex-col overflow-hidden">
			<IconButton
				title={t("common.close")}
				showTooltip={false}
				className="absolute right-2 top-2 z-10"
				onClick={() => props.api.close()}
			>
				<X />
			</IconButton>
			<ScrollArea type="hover" scrollHideDelay={0} className="min-h-0 flex-1">
				{git.state.status !== "available" && (
					<div className="px-6 pt-10"><GitAvailabilityNotice {...git} /></div>
				)}
				{/* 폴더 화면으로 넘어가도 가져오기 화면은 살려 둔다 — 언마운트하면
				    사용자가 편집한 초안이 사라지고 돌아올 때 전체 재검색이 돈다. */}
				{onboardingImportVisible && (
					<div className={cn(view !== "sessions" && "hidden")}>
						<OnboardingImportPreview
							onAvailabilityChange={setSessionImportAvailable}
							actionBarTarget={importActionBarTarget}
							onStartWithoutSessions={() => setChosenView("folder")}
						/>
					</div>
				)}
				{view === "folder" && (
					<OnboardingFolderStart
						steps={steps}
						projectCount={projects.length}
						installedProviders={installed}
						missingCommands={missingCommands}
						onInstallProvider={installProvider}
						actionBarTarget={folderActionBarTarget}
						onOpenFolder={() => void pickLocalFolder()}
						onStart={() => void startFromFolder()}
						onOpenTerminal={openTerminal}
						onBack={sessionsReachable ? () => setChosenView("sessions") : undefined}
					/>
				)}
			</ScrollArea>

			{showActionSlot && (
				// 본문 스크롤 영역 밖의 형제라 항상 pane 바닥에 붙어 있고, 내용이
				// 밑으로 지나가지 않으므로 배경을 칠하지 않는다 — pane 색을 그대로
				// 두고 위쪽 경계선만 얹는 것이 디자인(2443:82640)이다.
				<div
					data-onboarding-import-action-slot
					className="shrink-0 border-t border-border px-6 py-3"
				>
					<div
						ref={setImportActionBarTarget}
						className={cn(view !== "sessions" && "hidden")}
					/>
					<div
						ref={setFolderActionBarTarget}
						className={cn(view !== "folder" && "hidden")}
					/>
				</div>
			)}
		</div>
	);
}
