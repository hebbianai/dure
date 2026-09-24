import React from "react";
import ReactDOM from "@/lib/platform/reactDomClient";
import App from "./App";
import { AppErrorBoundary, RenderFailure } from "./components/AppErrorBoundary";
import "dockview-react/dist/styles/dockview.css";
import "./index.css";
import { startCliServer } from "@/lib/cli/cliServer";
import { removeRetiredInteractionInboxProjection } from "@/lib/persistence/persistStorage";
import { autoReloadForStaleModule } from "@/lib/platform/staleModuleReload";
import { installWindowPerformanceReporter } from "@/lib/workspace/performance/windowPerformanceReporter";
import { agentSessionSourceFromSearch } from "@/lib/workspace/window/agentSessionWindowSource";
import { installAppRestartParticipant } from "@/lib/workspace/window/appRestart";
import { installQa } from "./qa";

removeRetiredInteractionInboxProjection();
installQa();
const restartParticipant = installAppRestartParticipant().catch((error) => {
	console.error("[app-restart] window preparation unavailable", error);
	return undefined;
});
const cliServer = (
	import.meta.env.DEV &&
	new URLSearchParams(location.search).has("qaPaneAppRestart")
		? import("./qa/paneAppRestart").then((probe) =>
				startCliServer(probe.claimPaneAppRestartRequest),
			)
		: startCliServer()
).catch((error) => {
	console.error("[cli] server failed", error);
	return undefined;
});
const windowPerformanceReporter = installWindowPerformanceReporter();
windowPerformanceReporter.catch((error) =>
	console.error("[performance] window reporter failed", error),
);
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		void restartParticipant.then((stop) => stop?.());
		void cliServer.then((stop) => stop?.());
		void windowPerformanceReporter.then((stop) => stop());
	});
}

// 배포·재설치 뒤 vite 모듈 그래프가 바뀌면 떠 있던 페이지의 lazy 청크
// import가 옛 URL로 죽는다 — Refresh를 시키는 대신 쿨다운 안에서 1회 자동
// 리로드한다(설정 다이얼로그 등 lazy 표면의 "module script failed" 제보).
window.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason as { message?: string } | undefined;
	if (autoReloadForStaleModule(reason ?? {})) event.preventDefault();
});
window.addEventListener("error", (event) => {
	autoReloadForStaleModule({ message: event.message });
});

const root = ReactDOM.createRoot(
	document.getElementById("root") as HTMLElement,
);

// 엔트리 청크 import가 실패하면(vite 재시작 창 등) render가 아예 호출되지 않아
// 흰 화면이 된다 — 실패를 잡아 새로고침 가능한 화면이라도 그린다.
const renderEntryFailure = (
	error: unknown,
	surface:
		| "main"
		| "diff-window"
		| "session-window"
		| "source-control-window"
		| "popout-window" = "main",
) => {
	console.error("[main] entry import failed", error);
	root.render(
		<RenderFailure boundary="entry" error={error} surface={surface} />,
	);
};
const qaParams = new URLSearchParams(location.search);
const windowFocusQa =
	import.meta.env.DEV &&
	(qaParams.has("qaWindowSmoke") || qaParams.has("qaWindowSmokeController"));
const largeViewQa =
	import.meta.env.DEV &&
	qaParams.has("qaLargeView") &&
	qaParams.has("sessionWindow");
const notificationClickQa =
	qaParams.has("qaNotificationClick") &&
	(import.meta.env.VITE_DURE_NOTIFICATION_CLICK_QA === "1" ||
		import.meta.env.DEV);
const workspacePerformanceQa =
	import.meta.env.DEV &&
	import.meta.env.VITE_DURE_WORKSPACE_PERFORMANCE_QA === "1" &&
	qaParams.has("qaWorkspacePerformance");
const imePreeditQa =
	import.meta.env.DEV &&
	import.meta.env.VITE_DURE_IME_PREEDIT_QA === "1" &&
	qaParams.has("qaImePreedit");
// ?diff=<agentId> — 사이드바·데스크탑 chrome 없이 한 에이전트의 diff만 띄우는
// 단독 창(에이전트 pane의 "새 창에서 diff" 버튼). App 대신 bare 루트를 렌더한다.
const diffAgentId = qaParams.get("diff");
// ?panel=source-control — 소스 제어 패널 미러 단독 창 (slds)
const bareRootPanel = qaParams.get("panel");
// ?popout=<desktopId> — pane 분리 경량 창 (사이드바·데스크탑 바 없음)
const popoutDesktopId = qaParams.get("popout");
// ?sessionWindow=<agentId> — pane/layout은 유지하고 같은 Hmux 세션에 붙는 큰 창
const sessionWindowAgentId = qaParams.get("sessionWindow");
const sessionWindowSource = agentSessionSourceFromSearch(location.search);
// DockviewReact creates its imperative layout and React portal bridge in a
// mount effect. Root StrictMode replays that effect in development, disposing
// and rebuilding every restored pane before the first paint. Keep the main
// workspace root single-pass; focused auxiliary roots retain StrictMode below.
const renderAppRoot = () =>
	root.render(
		<AppErrorBoundary label="app">
			<App />
		</AppErrorBoundary>,
	);
// Design Mode B단계 실기 프로브 — qa.autorun에 designmode가 있을 때만 돈다.
if (import.meta.env.DEV) {
	if (qaParams.has("qaFeedbackPanes")) {
		void import("./qa/feedbackPanes").then(async (probe) => {
			if (!(await cliServer))
				throw new Error("Feedback QA requires CLI observers");
			await probe.runFeedbackPaneProbe();
		});
	}
	if (qaParams.has("qaPaneAppRestart")) {
		void import("./qa/paneAppRestart").then(async (probe) => {
			if (!(await cliServer) || !(await restartParticipant))
				throw new Error(
					"Pane restart QA requires CLI and restart participants",
				);
			await probe.runPaneAppRestartProbe();
		});
	}
	if (qaParams.has("qaRecoveryAdmission")) {
		void import("./qa/recoveryAdmission").then(async (probe) => {
			if (!(await cliServer))
				throw new Error("Recovery QA requires CLI observers");
			await probe.runRecoveryAdmissionProbe();
		});
	}
	if (qaParams.has("qaManagedSuccessorAdoption")) {
		void import("./qa/managedSuccessorAdoption").then(async (probe) => {
			if (!(await cliServer))
				throw new Error("Successor QA requires CLI observers");
			await probe.runManagedSuccessorAdoptionProbe();
		});
	}
	if (qaParams.has("qaMobileSimulator")) {
		void import("./qa/mobileSimulator").then((probe) =>
			probe.runMobileSimulatorProbe(),
		);
	}
	if (qaParams.has("qaBrowserPanel")) {
		void import("./qa/browserPanel").then((probe) =>
			probe.runBrowserPanelProbe(),
		);
	}
	if (qaParams.has("qaChatDraftWindows")) {
		void import("./qa/chatDraftWindows").then(async (probe) => {
			if (!(await cliServer))
				throw new Error("Chat draft QA requires CLI observers");
			await probe.runChatDraftWindowsProbe();
		});
	}
	if (qaParams.has("qaManagedRehostSync")) {
		void import("./qa/managedRehostSync").then(async (probe) => {
			if (!(await cliServer))
				throw new Error("Rehost QA requires CLI observers");
			await probe.runManagedRehostSyncProbe();
		});
	}
	void import("./qa/designModeProbe").then((probe) =>
		probe.maybeRunDesignModeProbe(),
	);
	if (qaParams.has("qaFloatingPaneDrag")) {
		void import("./qa/floatingPaneDragProbe").then((probe) =>
			probe.runFloatingPaneDragProbe(),
		);
	}
}

if (
	import.meta.env.DEV &&
	import.meta.env.VITE_DURE_PANE_FOCUS_HISTORY_QA === "1" &&
	qaParams.has("qaPaneFocusHistory")
) {
	import("./qa/paneFocusHistory")
		.then(({ PaneFocusHistoryQaRoot }) =>
			root.render(<PaneFocusHistoryQaRoot />),
		)
		.catch((error) => renderEntryFailure(error));
} else if (
	import.meta.env.DEV &&
	import.meta.env.VITE_DURE_BROWSER_RUNTIME_QA === "1" &&
	qaParams.has("qaBrowserRuntime")
) {
	import("./qa/browserRuntime")
		.then(({ BrowserRuntimeQaRoot }) => root.render(<BrowserRuntimeQaRoot />))
		.catch((error) => renderEntryFailure(error));
} else if (imePreeditQa) {
	import("./qa/imePreedit")
		.then(({ ImePreeditQaRoot }) => {
			root.render(
				<AppErrorBoundary label="app">
					<ImePreeditQaRoot />
				</AppErrorBoundary>,
			);
		})
		.catch((error) => renderEntryFailure(error));
} else if (notificationClickQa) {
	import("./qa/notificationClick")
		.then(({ NotificationClickQaRoot }) => {
			root.render(<NotificationClickQaRoot />);
		})
		.catch((error) => renderEntryFailure(error));
} else if (largeViewQa && sessionWindowAgentId) {
	import("./qa/hmuxWindowFocusRoots")
		.then(({ HmuxLargeViewQaRoot }) => {
			root.render(
				<AppErrorBoundary label="session-window">
					<HmuxLargeViewQaRoot
						agentId={sessionWindowAgentId}
						sourceWindowLabel={sessionWindowSource.windowLabel}
						sourcePaneOwnerId={sessionWindowSource.paneOwnerId}
					/>
				</AppErrorBoundary>,
			);
		})
		.catch((error) => renderEntryFailure(error, "session-window"));
} else if (import.meta.env.DEV && qaParams.has("qaSlackShare")) {
	import("./qa/slackShare")
		.then(({ SlackShareQaRoot }) => root.render(<SlackShareQaRoot />))
		.catch((error) => renderEntryFailure(error));
} else if (import.meta.env.DEV && qaParams.has("qaSlackConnections")) {
	import("./qa/slackConnections")
		.then(({ SlackConnectionsQaRoot }) =>
			root.render(<SlackConnectionsQaRoot />),
		)
		.catch((error) => renderEntryFailure(error));
} else if (import.meta.env.DEV && qaParams.has("qaWebviewRealm")) {
	import("./qa/webviewRealm")
		.then(({ WebviewRealmQaRoot }) => root.render(<WebviewRealmQaRoot />))
		.catch((error) => renderEntryFailure(error));
} else if (import.meta.env.DEV && qaParams.has("qaSpacesPaneMove")) {
	import("./qa/spacesPaneMove")
		.then(({ SpacesPaneMoveQaRoot }) => root.render(<SpacesPaneMoveQaRoot />))
		.catch((error) => renderEntryFailure(error));
} else if (import.meta.env.DEV && qaParams.has("qaRepositoryQuickStart")) {
	import("./qa/repositoryQuickStart")
		.then(({ RepositoryQuickStartQaRoot }) =>
			root.render(<RepositoryQuickStartQaRoot />),
		)
		.catch((error) => renderEntryFailure(error));
} else if (windowFocusQa) {
	import("./qa/hmuxWindowFocusRoots")
		.then(({ HmuxWindowFocusQaRoot }) => {
			root.render(<HmuxWindowFocusQaRoot />);
		})
		.catch((error) => renderEntryFailure(error));
} else if (bareRootPanel === "source-control") {
	import("./components/scm/SourceControlWindow")
		.then(({ SourceControlWindowRoot }) => {
			root.render(
				<React.StrictMode>
					<AppErrorBoundary label="source-control-window">
						<SourceControlWindowRoot />
					</AppErrorBoundary>
				</React.StrictMode>,
			);
		})
		.catch((error) => renderEntryFailure(error, "source-control-window"));
} else if (popoutDesktopId) {
	import("./components/workspace/PopoutWindow")
		.then(({ PopoutWindowRoot }) => {
			root.render(
				<React.StrictMode>
					<AppErrorBoundary label="popout-window">
						<PopoutWindowRoot desktopId={popoutDesktopId} />
					</AppErrorBoundary>
				</React.StrictMode>,
			);
		})
		.catch((error) => renderEntryFailure(error, "popout-window"));
} else if (sessionWindowAgentId) {
	import("./components/workspace/AgentSessionWindow")
		.then(({ AgentSessionWindowRoot }) => {
			root.render(
				<React.StrictMode>
					<AppErrorBoundary label="session-window">
						<AgentSessionWindowRoot
							agentId={sessionWindowAgentId}
							sourceWindowLabel={sessionWindowSource.windowLabel}
							sourcePaneOwnerId={sessionWindowSource.paneOwnerId}
						/>
					</AppErrorBoundary>
				</React.StrictMode>,
			);
		})
		.catch((error) => renderEntryFailure(error, "session-window"));
} else if (diffAgentId) {
	import("./components/scm/DiffWindow")
		.then(({ DiffWindowRoot }) => {
			root.render(
				<React.StrictMode>
					<AppErrorBoundary label="diff-window">
						<DiffWindowRoot agentId={diffAgentId} />
					</AppErrorBoundary>
				</React.StrictMode>,
			);
		})
		.catch((error) => renderEntryFailure(error, "diff-window"));
} else if (
	import.meta.env.DEV &&
	qaParams.has("qaSshRegistration") &&
	import.meta.env.VITE_DURE_SSH_REGISTRATION_QA_RUN_ID
) {
	import("./qa/sshRegistrationRecovery")
		.then(async (probe) => {
			const setup = await probe.prepareSshRegistrationQa();
			try {
				renderAppRoot();
				if (!(await cliServer))
					throw new Error("SSH registration QA requires CLI observers");
				await setup.run();
			} finally {
				setup.release();
			}
		})
		.catch((error) => renderEntryFailure(error));
} else if (workspacePerformanceQa) {
	import("./qa/workspacePerformance/run")
		.then(async (performanceQa) => {
			let setup:
				| Awaited<
						ReturnType<typeof performanceQa.prepareWorkspacePerformanceQa>
				  >
				| undefined;
			try {
				setup = await performanceQa.prepareWorkspacePerformanceQa();
				renderAppRoot();
				performanceQa.startWorkspacePerformanceQa(setup);
			} catch (error) {
				let failure = error;
				if (setup) {
					try {
						await setup.release();
					} catch (cleanupError) {
						failure = new performanceQa.WorkspacePerformanceCleanupError(
							"workspace performance render compensation failed",
							error,
							cleanupError,
						);
					}
				}
				performanceQa.failWorkspacePerformanceQa("setup", failure);
				throw failure;
			}
		})
		.catch((error) => renderEntryFailure(error));
} else {
	renderAppRoot();
	// ⌥⇧N — every floating notice at once, drawn in place by the real
	// components, for judging the family as one. Dev only.
	if (import.meta.env.DEV) {
		void import("./qa/noticeShowcase").then((showcase) =>
			showcase.installNoticeShowcase(),
		);
	}
}
