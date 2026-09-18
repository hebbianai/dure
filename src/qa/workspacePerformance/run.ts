import { getCurrentWindow } from "@tauri-apps/api/window";
import { type FrameStats, sampleFrames } from "@/lib/platform/frameSampler";
import { qaLog } from "@/lib/qa/qaLog";
import {
	clearQaPerformanceEvidence,
	freezeQaPerformanceEvidence,
} from "@/lib/qa/qaPerformanceEvidence";
import {
	type QaRuntimeErrorCursor,
	qaRuntimeErrorLedger,
} from "@/lib/qa/qaRuntimeErrorLedger";
import { qaRuntimeErrorMessage } from "@/lib/qa/qaRuntimeErrorProjection";
import { getFrameBudgetScheduler } from "@/lib/scheduling/frameBudgetScheduler";
import { schedulePostPaint } from "@/lib/scheduling/postPaint";
import { terminalInputLatency } from "@/lib/terminal/interaction/terminalInputLatency";
import {
	terminalStableDiagnosticForPanel,
	terminalStableDiagnosticSnapshot,
} from "@/lib/terminal/qa/terminalStableDiagnostics";
import type { TerminalQaBufferState } from "@/lib/terminal/terminalViewContracts";
import { getDockview, waitForDesktopDockview } from "@/lib/workspace/dock/dockRegistry";
import { beginPaneContentFocus } from "@/lib/workspace/pane/paneContentFocusHandoff";
import {
	getWorkspacePerformanceSnapshot,
	type WorkspaceTransitionSample,
} from "@/lib/workspace/performance/workspacePerformance";
import { summarizeWorkspacePerformance } from "@/lib/workspace/performance/workspacePerformanceReport";
import { useStore } from "@/store";
import { WorkspacePerformanceCleanupError } from "./cleanupError";
import type {
	WorkspacePerformanceFailureEvidence,
	WorkspacePerformanceFocusSnapshot,
	WorkspacePerformanceFocusTraceEntry,
} from "./contracts";
import {
	buildWorkspacePerformanceFixture,
	type WorkspacePerformanceFixture,
	workspacePerformanceFixtureState,
} from "./fixture";
import {
	confirmSingleDesktopActivationIntent,
	focusWorkspacePerformanceTarget,
} from "./focusTarget";
import { runNativePaneFocus } from "./nativePaneFocus";
import { runNativeSashGeometry } from "./nativeSashGeometry";
import { workspacePerformanceQuiescence } from "./quiescence";
import {
	assertRetentionSurfacesReleased,
	createWorkspaceRetentionSessions,
	runWorkspaceRetention,
} from "./retention";
import {
	workspacePerformanceQaPhaseFromLocation,
	workspacePerformanceScenarioFromLocation,
} from "./scenario";
import { createWorkspacePerformanceSessions } from "./sessionRuntime";
import {
	createWorkspacePerformanceStructuredTerminalLease,
	type WorkspacePerformanceStructuredTerminalLease,
	type WorkspacePerformanceStructuredTerminalSurface,
} from "./structuredTerminalSurface";
import { detachWorkspacePerformanceSurfaces } from "./surfaceCleanup";

export { WorkspacePerformanceCleanupError } from "./cleanupError";

const PHASE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 20;
const QUIESCENCE_WINDOW_MS = 250;

const focusTrace: WorkspacePerformanceFocusTraceEntry[] = [];
const MAX_FOCUS_TRACE_ENTRIES = 48;
const structuredTerminalFocusedIds = new Set<string>();
const structuredTerminalHostReceiptIds = new Set<string>();
const structuredTerminalProjectedIds = new Set<string>();
let activeRuntimeErrorScope: QaRuntimeErrorCursor | undefined;

export async function prepareWorkspacePerformanceQa() {
	clearQaPerformanceEvidence(window);
	structuredTerminalFocusedIds.clear();
	structuredTerminalHostReceiptIds.clear();
	structuredTerminalProjectedIds.clear();
	activeRuntimeErrorScope = qaRuntimeErrorLedger.beginScope();
	setQaStatus("running", "setup");
	const startedAt = performance.now();
	const scenario = workspacePerformanceScenarioFromLocation();
	const lease = await (workspacePerformanceQaPhaseFromLocation() === "retention"
		? createWorkspaceRetentionSessions(scenario)
		: createWorkspacePerformanceSessions(scenario));
	let terminalSurfaces: WorkspacePerformanceStructuredTerminalLease | undefined;
	try {
		const fixture = buildWorkspacePerformanceFixture(lease.sessions, scenario);
		// Retention observes product-owned registrations, never a QA replacement.
		if (workspacePerformanceQaPhaseFromLocation() !== "retention") {
			terminalSurfaces =
				createWorkspacePerformanceStructuredTerminalLease(fixture);
		}
		qaLog("workspace-performance", {
			state: "running",
			phase: "setup_complete",
			sessionCount: Object.keys(fixture.sessionAgent).length,
			scenario: scenario.id,
			setupMs: performance.now() - startedAt,
		});
		useStore.setState((state) =>
			workspacePerformanceFixtureState(fixture, state.uiPrefs),
		);
		return {
			fixture,
			release: lease.release,
			terminalSurfaces,
			workloadStartedAt: performance.now(),
		};
	} catch (error) {
		terminalSurfaces?.dispose();
		try {
			await lease.release();
		} catch (cleanupError) {
			throw new WorkspacePerformanceCleanupError(
				"workspace performance setup compensation failed",
				error,
				cleanupError,
			);
		}
		throw error;
	}
}

export function failWorkspacePerformanceQa(
	phase: string,
	error: unknown,
	failureEvidence?: WorkspacePerformanceFailureEvidence,
) {
	const message = error instanceof Error ? error.message : String(error);
	setQaStatus("failed", phase, message, failureEvidence);
	qaLog("workspace-performance", { state: "failed", phase, error: message });
}

export function startWorkspacePerformanceQa(
	setup: Awaited<ReturnType<typeof prepareWorkspacePerformanceQa>>,
) {
	setQaStatus("running", "initial");
	void runWorkspacePerformanceQa(
		setup.fixture,
		setup.workloadStartedAt,
		setup.terminalSurfaces,
	).then(
		() => finishWorkspacePerformanceQa(setup),
		(error) => finishWorkspacePerformanceQa(setup, error),
	);
}

async function finishWorkspacePerformanceQa(
	setup: Awaited<ReturnType<typeof prepareWorkspacePerformanceQa>>,
	workloadError?: unknown,
) {
	const workloadPhase =
		window.__DURE_WORKSPACE_PERFORMANCE_QA__?.phase ?? "workload";
	const workloadSnapshot = getWorkspacePerformanceSnapshot();
	const failureEvidence: WorkspacePerformanceFailureEvidence = {
		terminalDiagnostics: terminalStableDiagnosticSnapshot(),
		transitions: workloadSnapshot.transitions.slice(-8),
		focusTrace: focusTrace.slice(),
	};
	freezeQaPerformanceEvidence(window, {
		report: summarizeWorkspacePerformance(workloadSnapshot),
		frameBudget: getFrameBudgetScheduler().getTelemetry(),
	});
	setQaStatus("running", "cleanup");
	const cleanupErrors: unknown[] = [];
	try {
		await detachWorkspacePerformanceSurfaces(setup.fixture);
		if (workspacePerformanceQaPhaseFromLocation() === "retention") {
			await assertRetentionSurfacesReleased();
		}
	} catch (error) {
		cleanupErrors.push(error);
	}
	try {
		setup.terminalSurfaces?.dispose();
	} catch (error) {
		cleanupErrors.push(error);
	}
	try {
		await setup.release();
	} catch (error) {
		cleanupErrors.push(error);
	}
	const cleanupError =
		cleanupErrors.length === 0
			? undefined
			: cleanupErrors.length === 1
				? cleanupErrors[0]
				: new WorkspacePerformanceCleanupError(
						"workspace performance surface and session cleanup failed",
						cleanupErrors[0],
						cleanupErrors[1],
					);
	// Browser errors raised by cleanup layout are delivered after the current
	// task. Keep them in the same native QA receipt before declaring success.
	await new Promise<void>((resolve) => schedulePostPaint(window, resolve));
	if (workloadError || cleanupError) {
		const message = [workloadError, cleanupError]
			.filter((error) => error !== undefined)
			.map(errorMessage)
			.join("; cleanup: ");
		const phase = workloadError ? workloadPhase : "cleanup";
		const error = new Error(message);
		setQaStatus("failed", phase, error.message, failureEvidence);
		qaLog("workspace-performance", {
			state: "failed",
			phase,
			error: error.message,
		});
		console.error("[workspace-performance-qa]", workloadError ?? cleanupError);
		return;
	}
	const runtimeErrors = activeRuntimeErrorScope
		? qaRuntimeErrorLedger.snapshot(activeRuntimeErrorScope)
		: undefined;
	if (runtimeErrors && runtimeErrors.total > 0) {
		failWorkspacePerformanceQa(
			workloadPhase,
			new Error(qaRuntimeErrorMessage(runtimeErrors)),
			failureEvidence,
		);
		return;
	}
	setQaStatus("complete", "complete");
	qaLog("workspace-performance", { state: "complete" });
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

async function runWorkspacePerformanceQa(
	fixture: WorkspacePerformanceFixture,
	workloadStartedAt: number,
	terminalSurfaces: WorkspacePerformanceStructuredTerminalLease | undefined,
) {
	if (workspacePerformanceQaPhaseFromLocation() === "retention") {
		await runWorkspaceRetention(fixture);
		return;
	}
	if (!terminalSurfaces) throw new Error("workspace performance probes missing");
	const stopFocusTrace = installWorkspacePerformanceFocusTrace();
	try {
	await focusInitialWorkspace(fixture, terminalSurfaces);
	await waitForJourney(fixture.activeSpaceId, "initial");
	assertTerminalViewportFill(
		fixture.panelIdsByDesktop[fixture.activeSpaceId],
	);
	const qaPhase = workspacePerformanceQaPhaseFromLocation();
	if (qaPhase === "native_focus") {
		await runNativePaneFocus(fixture, terminalSurfaces, waitFor);
		return;
	}
	if (qaPhase === "sash") {
		await runNativeSashGeometry({
			fixture,
			terminalSurfaces,
			setQaStatus,
			waitFor,
			assertTerminalViewportFill,
		});
		return;
	}
	if (qaPhase === "focus") {
		for (const desktop of fixture.spaces.slice(1)) {
			setQaStatus("running", `focus_hydrate:${desktop.id}`);
			await activateWorkspaceTarget(fixture, desktop.id);
		}
		await activateWorkspaceTarget(fixture, fixture.activeSpaceId);
		await waitForGlobalQuiescence(
			fixture.scenario.panesPerDesktop,
			"focus diagnostic terminal quiescence",
		);
		await runMeasuredPaneFocus(fixture, false, terminalSurfaces);
		return;
	}

	for (const desktop of fixture.spaces.slice(1)) {
		setQaStatus("running", `first_visit:${desktop.id}`);
		await activateWorkspaceForJourney(
			fixture,
			desktop.id,
			"first_visit",
			terminalSurfaces,
		);
	}

	setQaStatus("running", "global_quiescence");
	await waitForGlobalQuiescence(
		fixture.scenario.panesPerDesktop,
		"global terminal quiescence",
	);
	recordQaMeasurement(
		"globalQuiescenceMs",
		Math.max(0, performance.now() - workloadStartedAt),
	);

	for (let index = 0; index < fixture.scenario.revisitSamples; index += 1) {
		const desktop = fixture.spaces[index % fixture.spaces.length];
		setQaStatus("running", `revisit:${index + 1}`);
		await activateWorkspaceForJourney(
			fixture,
			desktop.id,
			"revisit",
			terminalSurfaces,
		);
	}
	const steadyStateStartedAt = performance.now();
	setQaStatus("running", "steady_state_quiescence");
	await waitForGlobalQuiescence(
		fixture.scenario.panesPerDesktop,
		"steady-state terminal quiescence",
	);
	recordQaMeasurement(
		"steadyStateQuiescenceMs",
		Math.max(0, performance.now() - steadyStateStartedAt),
	);
	setQaStatus("running", "steady_state_frames");
	recordQaMeasurement("steadyStateFrames", await sampleFrames(1_000));

	await runMeasuredPaneFocus(fixture, true, terminalSurfaces);
	} finally {
		stopFocusTrace();
	}
}

async function runMeasuredPaneFocus(
	fixture: WorkspacePerformanceFixture,
	warmProviderInput: boolean,
	terminalSurfaces: WorkspacePerformanceStructuredTerminalLease,
) {
	const activeSpaceId = useStore.getState().activeSpaceId;
	const panelIds = fixture.panelIdsByDesktop[activeSpaceId];
	const api = await waitForDesktopDockview(activeSpaceId, PHASE_TIMEOUT_MS);
	if (!api || !panelIds?.length) {
		throw new Error("active performance workspace did not publish Dockview panes");
	}
	const refocusPanel = api.getPanel(panelIds[0]);
	if (!refocusPanel) throw new Error("refocus terminal pane is missing");
	refocusPanel.api.setActive();
	await waitForTerminalQaSurface(refocusPanel.id, terminalSurfaces);
	const search = document.createElement("input");
	document.body.append(search);
	try {
		// Reproduce a deferred navigation interrupted by search, followed by a
		// new pane focus. The QA surface's direct focus helper must not repair it.
		beginPaneContentFocus(refocusPanel.api);
		search.focus();
		api.focus();
		await waitFor("explicit pane refocus after interrupted navigation", () => {
			const input = refocusPanel.group.element.querySelector("textarea");
			return input !== null && document.activeElement === input;
		});
	} finally {
		search.remove();
	}
	if (warmProviderInput) {
		const startedAt = performance.now();
		setQaStatus("running", "provider_input_ready");
		for (let index = 0; index < panelIds.length; index += 1) {
			const panelId = panelIds[(index + 1) % panelIds.length];
			const previousFocusSequence = latestPaneFocusSequence();
			await focusAndDispatchMeasuredInput(
				activeSpaceId,
				panelId,
				index + 1,
				previousFocusSequence,
				terminalSurfaces,
			);
		}
		recordQaMeasurement(
			"providerInputReadyMs",
			Math.max(0, performance.now() - startedAt),
		);
	}
	// Provider startup is useful evidence, but it is not terminal interaction
	// latency. Start the application SLO from a proven input/output boundary.
	terminalInputLatency.resetMeasurements();
	const focusTargets = fixture.spaces.flatMap((desktop) => {
		const desktopPanelIds = fixture.panelIdsByDesktop[desktop.id] ?? [];
		// Workspace activation selects pane 1. Start at pane 2 so every measured
		// semantic focus also crosses a real Dockview pane-focus transition.
		return desktopPanelIds.map((_, index) => ({
			desktopId: desktop.id,
			panelId: desktopPanelIds[(index + 1) % desktopPanelIds.length],
		}));
	});
	if (focusTargets.length === 0) {
		throw new Error("workspace performance focus targets are missing");
	}
	for (let index = 0; index < fixture.scenario.focusInputSamples; index += 1) {
		const target = focusTargets[index % focusTargets.length];
		setQaStatus("running", `focus_input:${index + 1}`);
		const previousFocusSequence = latestPaneFocusSequence();
		if (useStore.getState().activeSpaceId !== target.desktopId) {
			await activateWorkspaceTarget(fixture, target.desktopId);
		}
		await focusAndDispatchMeasuredInput(
			target.desktopId,
			target.panelId,
			index + 1,
			previousFocusSequence,
			terminalSurfaces,
		);
	}
}

async function waitForGlobalQuiescence(
	expectedTerminalSurfaces: number,
	description: string,
) {
	let quietSince: number | undefined;
	await waitFor(description, () => {
		const state = workspacePerformanceQuiescence(
			getWorkspacePerformanceSnapshot(),
			expectedTerminalSurfaces,
		);
		if (!state.ready) {
			quietSince = undefined;
			return false;
		}
		quietSince ??= performance.now();
		return performance.now() - quietSince >= QUIESCENCE_WINDOW_MS;
	});
}

async function activateWorkspaceForJourney(
	fixture: WorkspacePerformanceFixture,
	desktopId: string,
	visitKind: NonNullable<WorkspaceTransitionSample["visitKind"]>,
	terminalSurfaces: WorkspacePerformanceStructuredTerminalLease,
) {
	const target = await activateWorkspaceTarget(fixture, desktopId);
	const terminalSurface = await waitForTerminalQaSurface(
		target.panelId,
		terminalSurfaces,
	);
	await focusTerminalQaSurface(
		terminalSurface,
		target.panelRoot,
		target.panelId,
	);
	await waitForJourney(desktopId, visitKind);
	assertTerminalViewportFill(fixture.panelIdsByDesktop[desktopId]);
}

function assertTerminalViewportFill(panelIds: string[] | undefined) {
	if (!panelIds?.length) {
		throw new Error("workspace performance viewport targets are missing");
	}
	for (const panelId of panelIds) {
		const details = terminalStableDiagnosticForPanel(panelId)?.details;
		const bufferState =
			details !== null && typeof details === "object" && "bufferState" in details
				? (details.bufferState as TerminalQaBufferState | undefined)
				: undefined;
		if (
			bufferState?.fitDimensionsMatch === true &&
			bufferState.viewportFill.fillsContainer &&
			!bufferState.concealed
		) {
			continue;
		}
		throw new Error(
			`workspace performance terminal viewport does not fill pane: panel=${panelId} state=${JSON.stringify(bufferState ?? null)}`,
		);
	}
}

async function activateWorkspaceTarget(
	fixture: WorkspacePerformanceFixture,
	desktopId: string,
) {
	const desktopTab = document.getElementById(`desktop-tab-${desktopId}`);
	if (!(desktopTab instanceof HTMLElement)) {
		throw new Error(
			`workspace performance desktop tab is missing: ${desktopId}`,
		);
	}
	await confirmSingleDesktopActivationIntent(desktopId, {
		dispatchDesktopActivation: () => desktopTab.click(),
		activeSpaceId: () => useStore.getState().activeSpaceId,
		wait: (milliseconds) =>
			new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
	});
	const panelId = fixture.panelIdsByDesktop[desktopId]?.[0];
	const api = await waitForDesktopDockview(desktopId, PHASE_TIMEOUT_MS);
	const panel = panelId ? api?.getPanel(panelId) : undefined;
	if (!api || !panel || !panelId) {
		throw new Error(`workspace performance target is missing: ${desktopId}`);
	}
	await focusWorkspacePerformanceTarget(
		{ panelId },
		{
			activatePanel: () => panel.api.setActive(),
			requestWindowFocus: () => getCurrentWindow().setFocus(),
			hasDocumentFocus: () => document.hasFocus(),
			activePanelId: () => api.activePanel?.id,
			wait: (milliseconds) =>
				new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
		},
	);
	return { panelId, panelRoot: panel.group.element };
}

async function focusInitialWorkspace(
	fixture: WorkspacePerformanceFixture,
	terminalSurfaces: WorkspacePerformanceStructuredTerminalLease,
) {
	const panelId = fixture.panelIdsByDesktop[fixture.activeSpaceId]?.[0];
	if (!panelId) throw new Error("initial performance pane is missing");
	const api = await waitForDesktopDockview(
		fixture.activeSpaceId,
		PHASE_TIMEOUT_MS,
	);
	const panel = api?.getPanel(panelId);
	if (!api || !panel) {
		throw new Error("initial performance workspace did not publish its pane");
	}
	await focusWorkspacePerformanceTarget(
		{ panelId },
		{
			activatePanel: () => panel.api.setActive(),
			requestWindowFocus: () => getCurrentWindow().setFocus(),
			hasDocumentFocus: () => document.hasFocus(),
			activePanelId: () => api.activePanel?.id,
			wait: (milliseconds) =>
				new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
		},
	);
	const terminalSurface = await waitForTerminalQaSurface(
		panelId,
		terminalSurfaces,
	);
	try {
		await focusTerminalQaSurface(terminalSurface, panel.group.element, panelId);
	} catch (error) {
		qaLog("workspace-performance-focus-failure", {
			...captureFocusSnapshot(),
			panelId,
			terminalSurface: "structured",
			terminalDiagnostics: terminalStableDiagnosticSnapshot(),
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		throw error;
	}
}

async function waitForTerminalQaSurface(
	panelId: string,
	terminalSurfaces: WorkspacePerformanceStructuredTerminalLease,
): Promise<WorkspacePerformanceStructuredTerminalSurface> {
	const deadline = performance.now() + PHASE_TIMEOUT_MS;
	while (performance.now() < deadline) {
		const structured = terminalSurfaces.surface(panelId);
		if (structured?.connected) return structured;
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	throw new Error(`terminal input surface is missing: ${panelId}`);
}

async function focusTerminalQaSurface(
	terminalSurface: WorkspacePerformanceStructuredTerminalSurface,
	panelRoot: HTMLElement,
	panelId: string,
) {
	await terminalSurface.focus();
	await waitFor(`structured terminal focus for ${panelId}`, () =>
		panelRoot.contains(document.activeElement),
	);
	structuredTerminalFocusedIds.add(panelId);
}

async function waitForJourney(
	desktopId: string,
	visitKind: NonNullable<WorkspaceTransitionSample["visitKind"]>,
) {
	await waitFor(`${visitKind} journey for ${desktopId}`, () => {
		const sample = [...getWorkspacePerformanceSnapshot().transitions]
			.reverse()
			.find(
				(candidate) =>
					candidate.desktopId === desktopId &&
					candidate.visitKind === visitKind,
			);
		return Boolean(
			sample &&
				sample.workspacePaintMs !== null &&
				sample.firstInteractivePaneMs !== null &&
				sample.firstTerminalPaintMs !== null &&
				sample.allTerminalStableMs !== null,
		);
	});
}

function latestPaneFocusSequence() {
	return Math.max(
		0,
		...(getWorkspacePerformanceSnapshot().paneFocus ?? []).map(
			(sample) => sample.sequence,
		),
	);
}

async function focusAndDispatchMeasuredInput(
	desktopId: string,
	panelId: string,
	sampleNumber: number,
	previousFocusSequence: number,
	terminalSurfaces: WorkspacePerformanceStructuredTerminalLease,
) {
	const api = getDockview(desktopId);
	if (!api) throw new Error(`performance desktop disappeared: ${desktopId}`);
	const panel = api.getPanel(panelId);
	if (!panel) throw new Error(`performance pane disappeared: ${panelId}`);
	const terminalSurface = await waitForTerminalQaSurface(
		panelId,
		terminalSurfaces,
	);
	panel.api.setActive();
	api.focus();
	await focusTerminalQaSurface(terminalSurface, panel.group.element, panelId);
	await waitFor(
		`focused terminal ${sampleNumber}`,
		() =>
			getWorkspacePerformanceSnapshot().paneFocus?.some(
				(sample) =>
					sample.sequence > previousFocusSequence &&
					sample.panelId === panelId &&
					sample.outcome === "complete",
			) ?? false,
	);
	const before =
		getWorkspacePerformanceSnapshot().terminalInput?.samples.length ?? 0;
	const marker = workspacePerformanceInputMarker();
	await terminalSurface.observeInput(marker, marker, {
		onReceipt: () => {
			structuredTerminalHostReceiptIds.add(panelId);
		},
		onProjection: () => {
			structuredTerminalProjectedIds.add(panelId);
		},
	});
	await waitFor(`input receipt and echo paint for ${panelId}`, () => {
		const samples =
			getWorkspacePerformanceSnapshot().terminalInput?.samples ?? [];
		return (
			samples.length > before &&
			samples[samples.length - 1]?.outcome === "complete"
		);
	});
	// The input tracker completes in a post-paint task. Yield through one more
	// rendering update before starting the next pane focus so WebKit's previous
	// terminal projection is not charged to the following focus sample.
	await new Promise<void>((resolve) => schedulePostPaint(window, resolve));
}

let workspacePerformanceInputSequence = 0;
const workspacePerformanceInputRun = (
	globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`
)
	.replace(/[^A-Za-z0-9]/g, "")
	.slice(-6)
	.toUpperCase()
	.padStart(6, "0");

function workspacePerformanceInputMarker() {
	workspacePerformanceInputSequence += 1;
	const sequence = workspacePerformanceInputSequence
		.toString(36)
		.toUpperCase()
		.padStart(3, "0");
	// Four-pane QA layouts can be as narrow as 23 columns. Keep the exact
	// per-run marker on one terminal row so projection matching is unambiguous.
	return `Q${workspacePerformanceInputRun}${sequence}`;
}

async function waitFor(description: string, predicate: () => boolean) {
	const deadline = performance.now() + PHASE_TIMEOUT_MS;
	while (performance.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	const snapshot = getWorkspacePerformanceSnapshot();
	const focus = captureFocusSnapshot();
	const nativeWindowFocused = await getCurrentWindow()
		.isFocused()
		.catch(() => null);
	qaLog("workspace-performance-timeout", {
		description,
		...focus,
		nativeWindowFocused,
		transitions: snapshot.transitions.slice(-8),
		workspaces: snapshot.workspaces,
		terminalAttaches: snapshot.terminalAttaches.slice(-30),
		terminalAttachIntegrity: snapshot.terminalAttachIntegrity,
		paneFocus: snapshot.paneFocus?.slice(-12),
		terminalInput: snapshot.terminalInput,
		terminalDiagnostics: terminalStableDiagnosticSnapshot(),
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
	throw new Error(`timed out waiting for ${description}`);
}

function setQaStatus(
	state: "running" | "complete" | "failed",
	phase: string,
	error?: string,
	failureEvidence?: WorkspacePerformanceFailureEvidence,
) {
	const current = window.__DURE_WORKSPACE_PERFORMANCE_QA__;
	const measurements = current?.measurements;
	const sashResize = current?.sashResize;
	const sashSelection = current?.sashSelection;
	const sashTarget = current?.sashTarget;
	const runtimeErrors = activeRuntimeErrorScope
		? qaRuntimeErrorLedger.snapshot(activeRuntimeErrorScope)
		: undefined;
	window.__DURE_WORKSPACE_PERFORMANCE_QA__ = {
		state,
		phase,
		...(error ? { error } : {}),
		focus: captureFocusSnapshot(),
		scenario: workspacePerformanceScenarioFromLocation().id,
		structuredTerminalObservations: {
			focusedTerminalIds: [...structuredTerminalFocusedIds].sort(),
			hostReceiptTerminalIds: [...structuredTerminalHostReceiptIds].sort(),
			projectedTerminalIds: [...structuredTerminalProjectedIds].sort(),
		},
		...(measurements ? { measurements } : {}),
		...(sashResize ? { sashResize } : {}),
		...(sashSelection ? { sashSelection } : {}),
		...(sashTarget ? { sashTarget } : {}),
		...(current?.nativeFocus ? { nativeFocus: current.nativeFocus } : {}),
		...(current?.retention ? { retention: current.retention } : {}),
		...(activeRuntimeErrorScope
			? { runtimeErrorScope: activeRuntimeErrorScope }
			: {}),
		...(runtimeErrors ? { runtimeErrors } : {}),
		...(state === "failed"
			? {
					terminalDiagnostics:
						failureEvidence?.terminalDiagnostics ??
						terminalStableDiagnosticSnapshot(),
					transitions:
						failureEvidence?.transitions ??
						getWorkspacePerformanceSnapshot().transitions.slice(-8),
					focusTrace: failureEvidence?.focusTrace ?? focusTrace.slice(),
				}
			: {}),
	};
}

function installWorkspacePerformanceFocusTrace() {
	const describe = (target: EventTarget | null | undefined) =>
		target instanceof HTMLElement
			? `${target.tagName.toLowerCase()}${target.className ? `.${String(target.className).split(/\s+/).filter(Boolean).join(".")}` : ""}`
			: undefined;
	const record = (
		event: WorkspacePerformanceFocusTraceEntry["event"],
		target?: EventTarget | null,
		relatedTarget?: EventTarget | null,
	) => {
		const describedTarget = describe(target);
		const describedRelatedTarget = describe(relatedTarget);
		focusTrace.push({
			atMs: performance.now(),
			event,
			...captureFocusSnapshot(),
			...(describedTarget ? { target: describedTarget } : {}),
			...(describedRelatedTarget
				? { relatedTarget: describedRelatedTarget }
				: {}),
		});
		if (focusTrace.length > MAX_FOCUS_TRACE_ENTRIES) focusTrace.shift();
	};
	const onFocus = (event: FocusEvent) =>
		record(event.type as "focusin" | "focusout", event.target, event.relatedTarget);
	const onPointer = (event: PointerEvent) => record("pointerdown", event.target);
	document.addEventListener("focusin", onFocus, true);
	document.addEventListener("focusout", onFocus, true);
	document.addEventListener("pointerdown", onPointer, true);
	return () => {
		document.removeEventListener("focusin", onFocus, true);
		document.removeEventListener("focusout", onFocus, true);
		document.removeEventListener("pointerdown", onPointer, true);
	};
}

function recordQaMeasurement(
	name:
		| "globalQuiescenceMs"
		| "providerInputReadyMs"
		| "steadyStateQuiescenceMs"
		| "steadyStateFrames",
	value: number | FrameStats,
) {
	const status = window.__DURE_WORKSPACE_PERFORMANCE_QA__;
	if (!status) return;
	status.measurements = { ...status.measurements, [name]: value };
}

function captureFocusSnapshot(): WorkspacePerformanceFocusSnapshot {
	const activeSpaceId = useStore.getState().activeSpaceId;
	const activeElement = document.activeElement;
	return {
		documentFocused: document.hasFocus(),
		documentVisibility: document.visibilityState,
		activeSpaceId,
		activePanelId: activeSpaceId
			? getDockview(activeSpaceId)?.activePanel?.id
			: undefined,
		activeElement:
			activeElement instanceof HTMLElement
				? `${activeElement.tagName.toLowerCase()}${activeElement.className ? `.${String(activeElement.className).split(/\s+/).filter(Boolean).join(".")}` : ""}`
				: null,
	};
}
