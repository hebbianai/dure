// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const webviewWindowMocks = vi.hoisted(() => ({
	getAllWebviewWindows: vi.fn(async () => []),
	getCurrentWebviewWindow: vi.fn(() => ({ label: "main" })),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => webviewWindowMocks);

import {
	requestHmuxControlPlaneCensus,
	resetHmuxControlPlaneCensusObservationForTests,
} from "@/lib/hmux/identity/hmuxControlPlaneCensusObservation";
import { type HmuxControlPlaneCensus, hmux } from "@/lib/ipc";
import { terminalInputLatency } from "@/lib/terminal/interaction/terminalInputLatency";
import {
	MAX_PANE_DRAG_SAMPLES,
	PaneDragPerformanceTracker,
	paneDragPerformance,
} from "./paneDragPerformance";
import {
	emptyStructuredTerminalPresentationSnapshot,
	type TerminalPresentationRole,
} from "./structuredTerminalPresentationPerformance";
import { WINDOW_PERFORMANCE_SCHEMA_VERSION } from "./windowPerformanceDiagnostics";
import {
	collectWindowPerformanceDiagnostics,
	collectWindowTerminalInputDiagnostics,
	type WindowPerformanceCollectorBackend,
	type WindowPerformanceDiagnostics,
} from "./windowPerformanceReport";
import type { WindowReportCollectorBackend } from "./windowReportCollection";
import {
	readWindowTerminalInputDiagnostics,
	type WindowTerminalInputDiagnostics,
} from "./windowTerminalInputDiagnostics";
import { workspacePerformance } from "./workspacePerformance";

function sample(
	windowLabel: string,
	terminalModelBytes: number,
	presentationRole: TerminalPresentationRole = "background",
): WindowPerformanceDiagnostics {
	const terminalPresentation = emptyStructuredTerminalPresentationSnapshot();
	if (terminalModelBytes > 0) {
		terminalPresentation.total = { commits: 2, totalMs: 5, maxMs: 3 };
		terminalPresentation.byRole[presentationRole] = {
			commits: 2,
			totalMs: 5,
			maxMs: 3,
		};
		terminalPresentation.perSurface = [
			{
				id: `surface-${windowLabel}`,
				total: { commits: 2, totalMs: 5, maxMs: 3 },
				byRole: terminalPresentation.byRole,
			},
		];
	}
	return {
		schemaVersion: WINDOW_PERFORMANCE_SCHEMA_VERSION,
		windowLabel,
		generatedAtMs: 1,
		totals: {
			mountedWorkspaces: windowLabel === "main" ? 2 : 0,
			terminalSurfaces: terminalModelBytes > 0 ? 1 : 0,
			terminalGpuViewportBytes: 64,
			terminalModelBytes,
			webglContexts: terminalModelBytes > 0 ? 1 : 0,
			hmuxObservers: terminalModelBytes > 0 ? 1 : 0,
		},
		render: {
			bufferedBytes: terminalModelBytes / 2,
			peakBufferedBytes: terminalModelBytes,
			maxRecentWriteLatencyMs: terminalModelBytes > 0 ? 12 : 0,
			perSurface: [],
		},
		terminalPresentation,
		eventLoopLag: {
			visible: true,
			focused: true,
			contextChangedAtMs: 1,
			lastSampleAtMs: 1,
			sampleCount: 4,
			recentP95Ms: 8,
			recentMaxMs: 12,
		},
		animations: {
			documentVisibility: "visible",
			focusedEditable: false,
			groups: [],
			supported: true,
		},
		hmuxControlPlaneCensus: null,
		terminalInput: null,
		paneFocus: null,
	};
}

describe("multi-window performance diagnostics", () => {
	it("preserves unavailable render pressure without losing the responding window", async () => {
		let respond: ((payload: unknown) => void) | undefined;
		const backend: WindowPerformanceCollectorBackend = {
			currentWindowLabel: () => "main",
			listWindowLabels: async () => ["main", "agent-session-1"],
			readLocal: async () => sample("main", 64),
			listenResponse: async (listener) => {
				respond = listener;
				return () => undefined;
			},
			emitRequest: async (_label, request) => {
				respond?.({
					requestId: request.requestId,
					sample: { ...sample("agent-session-1", 512), render: null },
				});
			},
		};
		await expect(
			collectWindowPerformanceDiagnostics(backend, 10),
		).resolves.toMatchObject({
			complete: true,
			missingWindowLabels: [],
			totals: { terminalModelBytes: 576 },
			render: null,
		});
	});

	afterEach(() => {
		paneDragPerformance.end();
		Reflect.deleteProperty(document, "getAnimations");
		document.body.replaceChildren();
		resetHmuxControlPlaneCensusObservationForTests();
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	it("reports current-window drag timing through the existing collector", async () => {
		paneDragPerformance.begin();
		paneDragPerformance.record(new Event("dragover") as DragEvent);
		const report = await collectWindowPerformanceDiagnostics();
		expect(report.windows[0].paneDrag?.recent[0]).toMatchObject({
			sequence: 1,
			trusted: false,
			eventAgeMs: null,
		});
	});

	it.each(["valid", "absent", "oversized", "untrusted-age", "invalid-frame"])(
		"preserves per-window drag timing boundaries: %s",
		async (kind) => {
			const tracker = new PaneDragPerformanceTracker(
				() => 100,
				() => () => {},
				1_000,
			);
			tracker.record({
				type: "dragover",
				isTrusted: true,
				timeStamp: 90,
			} as DragEvent);
			const drag = tracker.snapshot();
			const current = drag.recent[0];
			if (kind === "untrusted-age") current.trusted = false;
			if (kind === "invalid-frame") current.frameProbe = "complete";
			const remote = {
				...sample("secondary", 0),
				...(kind === "absent"
					? {}
					: {
							paneDrag: {
								...drag,
								privatePayload: "must not be projected",
								recent:
									kind === "oversized"
										? Array(MAX_PANE_DRAG_SAMPLES + 1).fill(current)
										: [{ ...current, privatePayload: "must not be projected" }],
							},
						}),
			};
			let respond: ((payload: unknown) => void) | undefined;
			const report = await collectWindowPerformanceDiagnostics(
				{
					currentWindowLabel: () => "main",
					listWindowLabels: async () => ["main", "secondary"],
					readLocal: async () => sample("main", 0),
					listenResponse: async (listener) => {
						respond = listener;
						return () => {};
					},
					emitRequest: async (_label, request) => {
						respond?.({ requestId: request.requestId, sample: remote });
					},
				},
				1,
			);
			const valid = kind === "valid" || kind === "absent";
			expect(report.complete).toBe(valid);
			if (valid) {
				expect(report.windows[1].paneDrag).toEqual(
					kind === "absent" ? undefined : drag,
				);
			} else expect(report.missingWindowLabels).toEqual(["secondary"]);
		},
	);

	it("reports content-free animation ownership for the current window", async () => {
		const target = document.createElement("span");
		target.className = "chat-shimmer user-secret-class";
		target.textContent = "user secret draft";
		document.body.append(target);
		const getAnimations = vi.fn(() => [
			{
				animationName: "chat-shimmer-sweep",
				effect: {
					getTiming: () => ({ duration: 2_400, iterations: Infinity }),
					target,
				},
				playState: "running",
			},
		]);
		Object.defineProperty(document, "getAnimations", {
			configurable: true,
			value: getAnimations,
		});

		const report = await collectWindowPerformanceDiagnostics();

		expect(report.windows[0]).toMatchObject({
			animations: {
				focusedEditable: false,
				groups: [
					{
						category: "chat-shimmer",
						count: 1,
						maxDurationMs: 2_400,
						minDurationMs: 2_400,
						playState: "running",
						scope: "unscoped",
					},
				],
				supported: true,
			},
		});
		expect(getAnimations).toHaveBeenCalledOnce();
		expect(JSON.stringify(report)).not.toContain("user secret");
	});

	it("reports the latest content-free Hmux census phase observation", async () => {
		const census: HmuxControlPlaneCensus = {
			policy: {
				activation: "local_bundled_or_installed_current",
				signedReleaseFetch: "not_implemented",
				signedPackageInstall: "blocked_missing_trust_root",
			},
			sessions: [
				{
					sessionId: "session-secret-ready",
					sessionName: "user-secret-session-name",
					workspaceId: "workspace-secret",
					lifecycle: "ready",
					health: "current_healthy",
					terminalEpoch: "epoch-secret",
					outputSeq: "1",
					capabilities: [],
				},
				{
					sessionId: "session-secret-exited",
					workspaceId: "workspace-secret",
					lifecycle: "exited",
					health: "exited",
					terminalEpoch: "epoch-secret",
					outputSeq: "1",
					capabilities: [],
				},
			],
			protectedBuildIds: [],
			diagnostics: {
				catalogUs: 12_000,
				healthProjectionUs: 4_000,
				totalUs: 16_000,
				joinedExisting: false,
			},
		};
		vi.spyOn(hmux, "controlPlaneCensus").mockResolvedValue(census);
		vi.spyOn(Date, "now").mockReturnValue(1_728_000_000_000);
		await requestHmuxControlPlaneCensus({
			source: "app_control_plane",
			trigger: "initial",
			windowRole: "main",
		});

		const report = await collectWindowPerformanceDiagnostics();

		expect(report.windows[0]).toMatchObject({
			hmuxControlPlaneCensus: {
				receivedAtMs: 1_728_000_000_000,
				diagnostics: {
					catalogUs: 12_000,
					healthProjectionUs: 4_000,
					joinedExisting: false,
					totalUs: 16_000,
				},
				requestReason: {
					source: "app_control_plane",
					trigger: "initial",
					windowRole: "main",
				},
				sessionCounts: { exited: 1, ready: 1, total: 2 },
			},
		});
		expect(JSON.stringify(report)).not.toContain("user-secret");
	});

	it("reports bounded input and pane-focus receipts from a secondary WebView", async () => {
		webviewWindowMocks.getCurrentWebviewWindow.mockReturnValue({
			label: "agent-session-1",
		});
		terminalInputLatency.resetMeasurements();
		terminalInputLatency.noteKeydown("terminal-secondary");
		terminalInputLatency.markSemanticKeydown("terminal-secondary");
		terminalInputLatency.markSemanticKeydownDecision("terminal-secondary");
		const input = terminalInputLatency.beginInput({
			terminalId: "terminal-secondary",
			desktopId: "desktop-secondary",
		});
		if (!input) throw new Error("terminal input fixture was not admitted");
		terminalInputLatency.markHostReceipt(input);
		terminalInputLatency.markFailed(input);
		const focus = workspacePerformance.beginPaneFocus(
			"desktop-secondary",
			"panel-secondary",
			false,
		);
		workspacePerformance.markPaneFocusCommit(focus);
		workspacePerformance.markPaneFocusFrame(focus);
		workspacePerformance.markPaneFocusPaint(focus);

		try {
			const secondarySample = (await collectWindowPerformanceDiagnostics())
				.windows[0];
			if (!secondarySample)
				throw new Error("secondary sample was not collected");
			if (!secondarySample.terminalInput || !secondarySample.paneFocus) {
				throw new Error("secondary interaction receipts were not collected");
			}
			const remoteSample = {
				...secondarySample,
				terminalInput: {
					...secondarySample.terminalInput,
					draftText: "user-secret-input",
				},
				paneFocus: {
					...secondarySample.paneFocus,
					paneTitle: "user-secret-pane",
				},
			};
			let respond: ((payload: unknown) => void) | undefined;
			const backend: WindowPerformanceCollectorBackend = {
				currentWindowLabel: () => "main",
				listWindowLabels: async () => ["main", "agent-session-1"],
				readLocal: async () => sample("main", 0),
				listenResponse: async (listener) => {
					respond = listener;
					return () => undefined;
				},
				emitRequest: async (_windowLabel, request) => {
					respond?.({ requestId: request.requestId, sample: remoteSample });
				},
			};
			const report = await collectWindowPerformanceDiagnostics(backend, 10);

			expect(report.windows[1]).toMatchObject({
				windowLabel: "agent-session-1",
				terminalInput: {
					bySource: { keydown: { failedCount: 1 } },
					failedCount: 1,
					inFlightCount: 0,
					recent: [
						{
							desktopId: "desktop-secondary",
							outcome: "failed",
							source: "keydown",
							terminalId: "terminal-secondary",
						},
					],
				},
				paneFocus: {
					paint: { count: 1 },
					recent: [
						{
							desktopId: "desktop-secondary",
							outcome: "complete",
							panelId: "panel-secondary",
						},
					],
				},
			});
			expect(JSON.stringify(report)).not.toContain("user-secret");

			remoteSample.terminalInput.keydownToHostReceipt = {
				count: 0,
				median: 9,
				p95: null,
				max: 1,
			};
			await expect(
				collectWindowPerformanceDiagnostics(backend, 1),
			).resolves.toMatchObject({
				complete: false,
				missingWindowLabels: ["agent-session-1"],
			});
		} finally {
			terminalInputLatency.resetMeasurements();
		}
	});

	it("collects source-separated terminal input without entering rich window diagnostics", async () => {
		const getAnimations = vi.fn(() => {
			throw new Error("animation enumeration must stay cold");
		});
		Object.defineProperty(document, "getAnimations", {
			configurable: true,
			value: getAnimations,
		});
		webviewWindowMocks.getCurrentWebviewWindow.mockReturnValue({
			label: "agent-session-1",
		});
		terminalInputLatency.resetMeasurements();
		terminalInputLatency.noteKeydown("terminal-secondary");
		terminalInputLatency.markSemanticKeydown("terminal-secondary");
		terminalInputLatency.markSemanticKeydownDecision("terminal-secondary");
		const input = terminalInputLatency.beginInput({
			terminalId: "terminal-secondary",
			desktopId: "desktop-secondary",
		});
		if (!input) throw new Error("terminal input fixture was not admitted");
		terminalInputLatency.markHostReceipt(input);
		terminalInputLatency.markFailed(input);

		try {
			const secondarySample = await readWindowTerminalInputDiagnostics();
			const mainSample: WindowTerminalInputDiagnostics = {
				...secondarySample,
				windowLabel: "main",
			};
			let respond: ((payload: unknown) => void) | undefined;
			let requestProjection: unknown;
			let remoteSample: WindowTerminalInputDiagnostics & {
				terminalInput: WindowTerminalInputDiagnostics["terminalInput"] & {
					draftText?: string;
				};
			} = {
				...secondarySample,
				terminalInput: {
					...secondarySample.terminalInput,
					draftText: "user-secret-input",
				},
			};
			const backend: WindowReportCollectorBackend<WindowTerminalInputDiagnostics> =
				{
					currentWindowLabel: () => "main",
					listWindowLabels: async () => ["main", "agent-session-1"],
					readLocal: async () => mainSample,
					listenResponse: async (listener) => {
						respond = listener;
						return () => undefined;
					},
					emitRequest: async (_windowLabel, request) => {
						requestProjection = request.projection;
						respond?.({
							requestId: request.requestId,
							projection: request.projection,
							sample: remoteSample,
						});
					},
				};

			const report = await collectWindowTerminalInputDiagnostics(backend, 10);

			expect(requestProjection).toBe("terminal-input");
			expect(report).toMatchObject({
				complete: true,
				expectedWindowLabels: ["main", "agent-session-1"],
				missingWindowLabels: [],
				projection: "terminal-input",
				windows: [
					{ windowLabel: "main" },
					{
						latestSampleAgeMs: expect.any(Number),
						terminalInput: {
							bySource: { keydown: { failedCount: 1 } },
							failedCount: 1,
							recent: [
								{
									desktopId: "desktop-secondary",
									outcome: "failed",
									source: "keydown",
									terminalId: "terminal-secondary",
								},
							],
						},
						windowLabel: "agent-session-1",
					},
				],
			});
			expect(getAnimations).not.toHaveBeenCalled();
			expect(JSON.stringify(report)).not.toContain("user-secret");

			remoteSample = {
				...remoteSample,
				terminalInput: {
					...remoteSample.terminalInput,
					keydownToHostReceipt: {
						count: 0,
						median: 9,
						p95: null,
						max: 1,
					},
				},
			};
			await expect(
				collectWindowTerminalInputDiagnostics(backend, 1),
			).resolves.toMatchObject({
				complete: false,
				missingWindowLabels: ["agent-session-1"],
			});
		} finally {
			terminalInputLatency.resetMeasurements();
		}
	});

	it("includes a large-view WebView in aggregate terminal memory", async () => {
		let respond: ((payload: unknown) => void) | undefined;
		const backend: WindowPerformanceCollectorBackend = {
			currentWindowLabel: () => "main",
			listWindowLabels: async () => ["main", "agent-session-1"],
			readLocal: async () => sample("main", 64, "foreground"),
			listenResponse: async (listener) => {
				respond = listener;
				return () => undefined;
			},
			emitRequest: async (_windowLabel, request) => {
				respond?.({
					requestId: request.requestId,
					sample: sample("agent-session-1", 512),
				});
			},
		};

		await expect(
			collectWindowPerformanceDiagnostics(backend, 10),
		).resolves.toMatchObject({
			complete: true,
			expectedWindowLabels: ["main", "agent-session-1"],
			missingWindowLabels: [],
			totals: {
				mountedWorkspaces: 2,
				terminalSurfaces: 2,
				terminalModelBytes: 576,
				webglContexts: 2,
				hmuxObservers: 2,
			},
			terminalPresentation: {
				total: { commits: 4, totalMs: 10, maxMs: 3 },
				byRole: {
					foreground: { commits: 2, totalMs: 5, maxMs: 3 },
					background: { commits: 2, totalMs: 5, maxMs: 3 },
					ungated: { commits: 0, totalMs: 0, maxMs: 0 },
				},
			},
			render: {
				bufferedBytes: 288,
				peakBufferedBytes: 576,
				maxRecentWriteLatencyMs: 12,
			},
			windows: [
				{
					windowLabel: "main",
					terminalPresentation: {
						perSurface: [{ id: "surface-main" }],
					},
				},
				{
					windowLabel: "agent-session-1",
					terminalPresentation: {
						perSurface: [{ id: "surface-agent-session-1" }],
					},
				},
			],
		});
	});

	it("keeps legacy windows complete while marking the additive census unavailable", async () => {
		let respond: ((payload: unknown) => void) | undefined;
		const legacy = sample("legacy-window", 0);
		Reflect.deleteProperty(legacy, "animations");
		Reflect.deleteProperty(legacy, "hmuxControlPlaneCensus");
		Reflect.deleteProperty(legacy, "terminalInput");
		Reflect.deleteProperty(legacy, "paneFocus");
		const backend: WindowPerformanceCollectorBackend = {
			currentWindowLabel: () => "main",
			listWindowLabels: async () => ["main", "legacy-window"],
			readLocal: async () => sample("main", 0),
			listenResponse: async (listener) => {
				respond = listener;
				return () => undefined;
			},
			emitRequest: async (_windowLabel, request) => {
				respond?.({ requestId: request.requestId, sample: legacy });
			},
		};

		await expect(
			collectWindowPerformanceDiagnostics(backend, 10),
		).resolves.toMatchObject({
			complete: true,
			windows: [
				{ windowLabel: "main" },
				{
					animations: {
						documentVisibility: "unknown",
						focusedEditable: false,
						groups: [],
						supported: false,
					},
					hmuxControlPlaneCensus: null,
					terminalInput: null,
					paneFocus: null,
					windowLabel: "legacy-window",
				},
			],
		});
	});

	it("projects remote animation counts without forwarding unknown identity", async () => {
		let respond: ((payload: unknown) => void) | undefined;
		const remote = {
			...sample("agent-session-1", 0),
			hmuxControlPlaneCensus: {
				requestReason: {
					source: "session_recovery",
					trigger: "refresh",
					windowRole: "secondary",
					sessionId: "remote-secret-reason-session",
				},
				receivedAtMs: 1_728_000_000_000,
				diagnostics: {
					catalogUs: 12_000,
					healthProjectionUs: 4_000,
					totalUs: 16_000,
					joinedExisting: true,
					workspaceId: "remote-secret-diagnostic-workspace",
				},
				sessionCounts: {
					total: 2,
					ready: 1,
					exited: 1,
					sessionIds: ["remote-secret-count-session"],
				},
			},
			animations: {
				documentVisibility: "visible",
				focusedEditable: true,
				groups: [
					{
						category: "chat-shimmer",
						className: "remote-secret-class",
						count: 2,
						maxDurationMs: 2_400,
						minDurationMs: 2_400,
						paneId: "remote-secret-pane",
						playState: "running",
						scope: "active-tabpanel",
					},
				],
				sessionId: "remote-secret-session",
				supported: true,
				textContent: "remote secret text",
			},
		};
		const backend: WindowPerformanceCollectorBackend = {
			currentWindowLabel: () => "main",
			listWindowLabels: async () => ["main", "agent-session-1"],
			readLocal: async () => sample("main", 0),
			listenResponse: async (listener) => {
				respond = listener;
				return () => undefined;
			},
			emitRequest: async (_windowLabel, request) => {
				respond?.({ requestId: request.requestId, sample: remote });
			},
		};

		const report = await collectWindowPerformanceDiagnostics(backend, 10);

		expect(report).toMatchObject({
			complete: true,
			windows: [
				{ windowLabel: "main" },
				{
					animations: {
						groups: [
							{
								category: "chat-shimmer",
								count: 2,
								maxDurationMs: 2_400,
								minDurationMs: 2_400,
								playState: "running",
								scope: "active-tabpanel",
							},
						],
						supported: true,
					},
					hmuxControlPlaneCensus: {
						requestReason: {
							source: "session_recovery",
							trigger: "refresh",
							windowRole: "secondary",
						},
						receivedAtMs: 1_728_000_000_000,
						diagnostics: {
							catalogUs: 12_000,
							healthProjectionUs: 4_000,
							totalUs: 16_000,
							joinedExisting: true,
						},
						sessionCounts: { total: 2, ready: 1, exited: 1 },
					},
					windowLabel: "agent-session-1",
				},
			],
		});
		expect(JSON.stringify(report)).not.toContain("remote-secret");
		expect(JSON.stringify(report)).not.toContain("remote secret text");
	});

	it.each([
		[
			"legacy fixed-zero render pressure schema",
			(sample: WindowPerformanceDiagnostics) => {
				(sample as { schemaVersion: number }).schemaVersion = 2;
			},
		],
		[
			"missing render pressure availability",
			(sample: WindowPerformanceDiagnostics) => {
				Reflect.deleteProperty(sample, "render");
			},
		],
		[
			"legacy visible-only event-loop sample",
			(sample: WindowPerformanceDiagnostics) => {
				(sample as { schemaVersion: number }).schemaVersion = 1;
				Reflect.deleteProperty(sample.eventLoopLag, "focused");
				Reflect.deleteProperty(sample.eventLoopLag, "contextChangedAtMs");
				Reflect.deleteProperty(sample.eventLoopLag, "lastSampleAtMs");
			},
		],
		[
			"missing event-loop focus authority",
			(sample: WindowPerformanceDiagnostics) => {
				Reflect.deleteProperty(sample.eventLoopLag, "focused");
			},
		],
		[
			"malformed event-loop epoch timestamp",
			(sample: WindowPerformanceDiagnostics) => {
				sample.eventLoopLag.contextChangedAtMs = -1;
			},
		],
		[
			"negative work",
			(sample: WindowPerformanceDiagnostics) => {
				sample.terminalPresentation.total.maxMs = -1;
			},
		],
		[
			"inconsistent role totals",
			(sample: WindowPerformanceDiagnostics) => {
				sample.terminalPresentation.total.commits += 1;
			},
		],
		[
			"overflowing role sum",
			(sample: WindowPerformanceDiagnostics) => {
				sample.terminalPresentation.total = {
					commits: 2,
					totalMs: Number.MAX_VALUE,
					maxMs: Number.MAX_VALUE,
				};
				sample.terminalPresentation.byRole.foreground = {
					commits: 1,
					totalMs: Number.MAX_VALUE,
					maxMs: Number.MAX_VALUE,
				};
				sample.terminalPresentation.byRole.background = {
					commits: 1,
					totalMs: Number.MAX_VALUE,
					maxMs: Number.MAX_VALUE,
				};
			},
		],
		[
			"duplicate surface ids",
			(sample: WindowPerformanceDiagnostics) => {
				const surface = sample.terminalPresentation.perSurface[0];
				sample.terminalPresentation.perSurface = surface
					? [surface, { ...surface }]
					: [];
			},
		],
		[
			"inconsistent surface totals",
			(sample: WindowPerformanceDiagnostics) => {
				const surface = sample.terminalPresentation.perSurface[0];
				if (surface) surface.total.totalMs += 1;
			},
		],
		[
			"missing nested role work",
			(sample: WindowPerformanceDiagnostics) => {
				Reflect.deleteProperty(
					sample.terminalPresentation.byRole,
					"background",
				);
			},
		],
		[
			"malformed animation aggregate",
			(sample: WindowPerformanceDiagnostics) => {
				sample.animations.groups = [
					{
						category: "pulse",
						count: -1,
						maxDurationMs: 2_000,
						minDurationMs: 2_000,
						playState: "running",
						scope: "active-tabpanel",
					},
				];
			},
		],
		[
			"malformed terminal input receipts",
			(sample: WindowPerformanceDiagnostics) => {
				sample.terminalInput =
					{} as WindowPerformanceDiagnostics["terminalInput"];
			},
		],
		[
			"malformed pane focus receipts",
			(sample: WindowPerformanceDiagnostics) => {
				sample.paneFocus = {} as WindowPerformanceDiagnostics["paneFocus"];
			},
		],
	] as const)("rejects %s", async (_label, mutate) => {
		let respond: ((payload: unknown) => void) | undefined;
		const malformed = sample("agent-session-1", 512);
		mutate(malformed);
		const backend: WindowPerformanceCollectorBackend = {
			currentWindowLabel: () => "main",
			listWindowLabels: async () => ["main", "agent-session-1"],
			readLocal: async () => sample("main", 0),
			listenResponse: async (listener) => {
				respond = listener;
				return () => undefined;
			},
			emitRequest: async (_windowLabel, request) => {
				respond?.({ requestId: request.requestId, sample: malformed });
			},
		};

		await expect(
			collectWindowPerformanceDiagnostics(backend, 1),
		).resolves.toMatchObject({
			complete: false,
			missingWindowLabels: ["agent-session-1"],
			render: null,
		});
	});

	it("orders the current WebView first and the remaining windows lexically", async () => {
		let respond: ((payload: unknown) => void) | undefined;
		const backend: WindowPerformanceCollectorBackend = {
			currentWindowLabel: () => "main",
			listWindowLabels: async () => ["a-window", "main", "Z-window"],
			readLocal: async () => sample("main", 0),
			listenResponse: async (listener) => {
				respond = listener;
				return () => undefined;
			},
			emitRequest: async (windowLabel, request) => {
				respond?.({
					requestId: request.requestId,
					sample: sample(windowLabel, 0),
				});
			},
		};

		await expect(
			collectWindowPerformanceDiagnostics(backend, 10),
		).resolves.toMatchObject({
			expectedWindowLabels: ["main", "Z-window", "a-window"],
			windows: [
				{ windowLabel: "main" },
				{ windowLabel: "Z-window" },
				{ windowLabel: "a-window" },
			],
		});
	});

	it("reports an unresponsive WebView instead of claiming zero usage", async () => {
		const backend: WindowPerformanceCollectorBackend = {
			currentWindowLabel: () => "main",
			listWindowLabels: async () => ["main", "stalled-window"],
			readLocal: async () => sample("main", 0),
			listenResponse: async () => () => undefined,
			emitRequest: async () => {},
		};

		await expect(
			collectWindowPerformanceDiagnostics(backend, 1),
		).resolves.toMatchObject({
			complete: false,
			missingWindowLabels: ["stalled-window"],
		});
	});

	it("keeps the collection deadline when request delivery stalls", async () => {
		const backend: WindowPerformanceCollectorBackend = {
			currentWindowLabel: () => "main",
			listWindowLabels: async () => ["main", "stalled-window"],
			readLocal: async () => sample("main", 0),
			listenResponse: async () => () => undefined,
			emitRequest: () => new Promise(() => {}),
		};

		await expect(
			collectWindowPerformanceDiagnostics(backend, 1),
		).resolves.toMatchObject({
			complete: false,
			missingWindowLabels: ["stalled-window"],
		});
	});
});
