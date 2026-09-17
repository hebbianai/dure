import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DockviewApi } from "dockview-react";
import { useEffect, useState } from "react";
import {
	notificationActivationTake,
	notificationClickQaArm,
	notificationClickQaAuthorize,
	notificationClickQaBegin,
	notificationClickQaComplete,
	notificationClickQaContext,
	notificationClickQaExit,
	notificationClickQaFail,
	notificationClickQaTargetIsReady,
	notificationClickQaTargetReady,
} from "@/lib/ipc/notifications";
import { installNotificationActivationHandler } from "@/lib/settings/notificationActivation";
import { registerDockview, unregisterDockview } from "@/lib/workspace/dock/dockRegistry";
import { applyPendingPanelFocus } from "@/lib/workspace/dock/panelFocusHandoff";
import { useStore } from "@/store";
import {
	notificationClickQaLayout,
	notificationClickQaPlan,
} from "./notificationClickScenario";

interface NotificationClickQaWindowState {
	windowLabel: string;
	visible: boolean;
	minimized: boolean;
	focused: boolean;
}

function fakeDockview(
	panelId: string,
	onActive: (panelId: string) => void,
): DockviewApi {
	let visible = true;
	const groupApi = {
		get isVisible() {
			return visible;
		},
		location: { type: "grid" },
		width: 720,
		height: 480,
		setVisible(next: boolean) {
			visible = next;
		},
		setSize() {},
	};
	const panel = (id: string) => ({
		id,
		api: { setActive: () => onActive(id) },
		group: { api: groupApi, panels: [] as unknown[] },
	});
	const target = panel(panelId);
	target.group.panels = [target];
	return {
		getPanel: (candidate: string) =>
			candidate === panelId ? target : undefined,
	} as unknown as DockviewApi;
}

async function observedWindowState(): Promise<NotificationClickQaWindowState> {
	const window = getCurrentWindow();
	return {
		windowLabel: window.label,
		visible: await window.isVisible(),
		minimized: await window.isMinimized(),
		focused: await window.isFocused(),
	};
}

async function waitForTargetReady(
	runId: string,
	expectedWindowLabel: string,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await notificationClickQaTargetIsReady(runId, expectedWindowLabel)) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(
		"the exact target window did not install its activation handler",
	);
}

async function waitForFocusedWindow(): Promise<NotificationClickQaWindowState> {
	const deadline = Date.now() + 5_000;
	let state = await observedWindowState();
	while (
		(!state.visible || state.minimized || !state.focused) &&
		Date.now() < deadline
	) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		state = await observedWindowState();
	}
	return state;
}

async function waitForPresentation(
	presentation: "terminating" | "minimized" | "hidden",
): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const state = await observedWindowState();
		if (
			(presentation === "terminating" && state.visible) ||
			(presentation === "minimized" && state.minimized) ||
			(presentation === "hidden" && !state.visible)
		) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`window did not reach the ${presentation} pre-click state`);
}

async function exitNotificationClickQa(runId: string): Promise<void> {
	await notificationClickQaExit(runId);
}

export function NotificationClickQaRoot() {
	const [message, setMessage] = useState(
		"Preparing signed Dure notification click QA…",
	);
	const [result, setResult] = useState<
		"running" | "passed" | "skipped" | "failed"
	>("running");

	useEffect(() => {
		let disposed = false;
		let activeRunId: string | undefined;
		let unregister = () => {};
		let uninstallActivation = () => {};
		let unsubscribe = () => {};
		let failureReported = false;

		const reportFailure = async (error: unknown) => {
			if (failureReported) return;
			failureReported = true;
			console.error("[notification-click-qa]", error);
			if (activeRunId) {
				const runId = activeRunId;
				await notificationClickQaFail(runId, String(error)).catch(
					(failureError) => {
						console.error(
							"[notification-click-qa:failure-receipt]",
							failureError,
						);
					},
				);
				setTimeout(() => void exitNotificationClickQa(runId), 300);
			}
			if (!disposed) {
				setResult("failed");
				setMessage(`FAIL — ${String(error)}`);
			}
		};

		void (async () => {
			const context = await notificationClickQaContext();
			activeRunId = context.runId;
			const plan = notificationClickQaPlan(context.scenario);
			const currentWindowLabel = getCurrentWindow().label;
			const targetRenderer =
				new URLSearchParams(location.search).get("qaNotificationClickRole") ===
					"target" || currentWindowLabel === "win-notification-click-target";
			if (targetRenderer && !plan.targetWindow) {
				await getCurrentWindow().hide();
				await waitForPresentation("hidden");
				setMessage("Idle QA target window — this scenario is owned by main.");
				return;
			}
			const registrationDesktopId = targetRenderer
				? context.expectedTarget.desktopId
				: plan.targetWindow
					? context.initialDesktopId
					: context.expectedTarget.desktopId;
			const registrationPanelId = targetRenderer
				? context.expectedTarget.panelId
				: plan.targetWindow
					? context.initialPanelId
					: context.expectedTarget.panelId;
			let panelActiveCount = 0;
			let currentActivePanelId = context.initialPanelId;
			let completing = false;
			const api = fakeDockview(registrationPanelId, (panelId) => {
				currentActivePanelId = panelId;
				if (panelId === context.expectedTarget.panelId) panelActiveCount += 1;
			});

			useStore.setState({
				desktops: [
					{ id: context.initialDesktopId, name: "QA initial" },
					{ id: context.expectedTarget.desktopId, name: "QA target" },
				],
				activeDesktopId:
					targetRenderer || context.scenario === "minimized"
						? context.expectedTarget.desktopId
						: context.initialDesktopId,
				layouts: {
					[context.expectedTarget.desktopId]: notificationClickQaLayout(
						context.expectedTarget.panelId,
					),
				},
			});
			registerDockview(registrationDesktopId, api);
			unregister = () => unregisterDockview(registrationDesktopId, api);
			unsubscribe = useStore.subscribe((state, previous) => {
				if (
					state.activeDesktopId === context.expectedTarget.desktopId &&
					previous.activeDesktopId !== state.activeDesktopId
				) {
					applyPendingPanelFocus(context.expectedTarget.desktopId);
				}
			});
			uninstallActivation = installNotificationActivationHandler();

			const completeWhenFocused = async (): Promise<void> => {
				if (completing || panelActiveCount === 0) return;
				completing = true;
				await new Promise((resolve) => setTimeout(resolve, 150));
				const queueEmpty = (await notificationActivationTake()) === null;
				const observedWindow = await waitForFocusedWindow();
				await notificationClickQaComplete(context.runId, {
					windowLabel: observedWindow.windowLabel,
					activeSpaceId: useStore.getState().activeSpaceId,
					activeDesktopId: useStore.getState().activeDesktopId,
					panelId: context.expectedTarget.panelId,
					panelActiveCount,
					activationQueueEmpty: queueEmpty,
					window: {
						visible: observedWindow.visible,
						minimized: observedWindow.minimized,
						focused: observedWindow.focused,
					},
				});
				if (!disposed) {
					setResult("passed");
					setMessage("PASS — the actual macOS click restored the exact pane.");
				}
				setTimeout(() => void exitNotificationClickQa(context.runId), 300);
			};
			if (!plan.targetWindow || targetRenderer) {
				const completionPoll = window.setInterval(
					() => void completeWhenFocused().catch(reportFailure),
					50,
				);
				const priorUnregister = unregister;
				unregister = () => {
					window.clearInterval(completionPoll);
					priorUnregister();
				};
			}

			if (targetRenderer) {
				const expectedWindowLabel = context.expectedTarget.windowLabel;
				if (
					!expectedWindowLabel ||
					currentWindowLabel !== expectedWindowLabel
				) {
					throw new Error(
						"QA target renderer has the wrong native window label",
					);
				}
				const targetWindow = getCurrentWindow();
				await targetWindow.hide();
				await waitForPresentation("hidden");
				await notificationClickQaTargetReady(context.runId);
				setMessage(
					"Target window ready; waiting for the exact native activation…",
				);
				return;
			}

			if (plan.targetWindow) {
				const expectedWindowLabel = context.expectedTarget.windowLabel;
				if (!expectedWindowLabel) {
					throw new Error("multi-window QA has no exact target window label");
				}
				await waitForTargetReady(context.runId, expectedWindowLabel);
			}

			if (context.authorize) {
				setMessage(
					"Waiting for the dedicated QA notification permission decision…",
				);
				await notificationClickQaAuthorize(context.runId);
			}

			const journal = await notificationClickQaBegin(
				context.runId,
				context.scenario,
			);
			if (journal.stage === "skipped") {
				setResult("skipped");
				setMessage(
					`SKIP — ${journal.reason ?? "notification permission unavailable"}`,
				);
				setTimeout(() => void exitNotificationClickQa(context.runId), 500);
				return;
			}
			if (journal.stage === "failed") {
				throw new Error(journal.reason ?? "notification dispatch failed");
			}
			if (journal.stage === "armed") {
				setMessage(
					"Click the QA notification; waiting for the native activation…",
				);
				return;
			}
			if (journal.stage === "completed") {
				setResult("passed");
				setMessage("PASS — the actual macOS click restored the exact pane.");
				setTimeout(() => void exitNotificationClickQa(context.runId), 300);
				return;
			}
			if (journal.stage !== "dispatched") {
				throw new Error(`unexpected notification QA stage: ${journal.stage}`);
			}

			if (!plan.targetWindow) {
				const currentWindow = getCurrentWindow();
				switch (plan.presentation) {
					case "terminating":
						break;
					case "minimized":
						await currentWindow.minimize();
						break;
					case "hidden":
						await currentWindow.hide();
						break;
				}
				await waitForPresentation(plan.presentation);
			}
			await notificationClickQaArm(
				context.runId,
				plan.presentation,
				currentActivePanelId,
			);
			setMessage(
				"Click the QA notification; waiting for the native activation…",
			);
			if (plan.exitBeforeClick) {
				setTimeout(() => void exitNotificationClickQa(context.runId), 300);
			}
		})().catch(reportFailure);

		return () => {
			disposed = true;
			unsubscribe();
			uninstallActivation();
			unregister();
		};
	}, []);

	return (
		<main
			data-notification-click-qa={result}
			style={{
				fontFamily: "system-ui, sans-serif",
				padding: 32,
				background: "#111827",
				color: "#f9fafb",
				minHeight: "100vh",
			}}
		>
			<h1>Signed Dure notification click QA</h1>
			<p>{message}</p>
			<p>
				This bundle uses a dedicated QA identity and never changes production
				Dure permissions.
			</p>
		</main>
	);
}
