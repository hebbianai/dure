import { emitTo } from "@tauri-apps/api/event";
import {
	getAllWebviewWindows,
	getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import type {
	HmuxControlPlaneCensusPerformanceObservation,
	HmuxControlPlaneCensusRequestReason,
} from "@/lib/hmux/identity/hmuxControlPlaneCensusObservation";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import {
	MAX_PANE_DRAG_SAMPLES,
	type PaneDragPerformanceSnapshot,
} from "./paneDragPerformance";
import {
	aggregateStructuredTerminalPresentationSnapshots,
	type StructuredTerminalPresentationTotalsSnapshot,
} from "./structuredTerminalPresentationPerformance";
import {
	parseWindowAnimationDiagnostics,
	unavailableWindowAnimationDiagnostics,
} from "./windowAnimationDiagnostics";
import {
	readWindowPerformanceDiagnostics,
	WINDOW_PERFORMANCE_SCHEMA_VERSION,
	type WindowPerformanceDiagnostics,
} from "./windowPerformanceDiagnostics";
import {
	collectWindowReportSamples,
	WINDOW_REPORT_REQUEST_EVENT,
	WINDOW_REPORT_RESPONSE_EVENT,
	type WindowReportCollectorBackend,
} from "./windowReportCollection";
import {
	aggregateWindowTerminalInputDiagnostics,
	type MultiWindowTerminalInputDiagnostics,
	parseWindowTerminalInputResponse,
	readWindowTerminalInputDiagnostics,
	type WindowTerminalInputDiagnostics,
} from "./windowTerminalInputDiagnostics";
import type { WorkspacePerformanceReport } from "./workspacePerformanceReportTypes";
import type { WorkspacePerformanceSnapshot } from "./workspacePerformanceTypes";

const COLLECTION_TIMEOUT_MS = 750;
const PRESENTATION_TOTAL_MS_RELATIVE_TOLERANCE = 1e-9;
const MAX_INTERACTION_RECENT_SAMPLES = 24;

type Totals = WorkspacePerformanceSnapshot["totals"];
type RenderPressure = NonNullable<WorkspacePerformanceSnapshot["render"]>;

export type { WindowPerformanceDiagnostics } from "./windowPerformanceDiagnostics";

export interface MultiWindowPerformanceDiagnostics {
	schemaVersion: typeof WINDOW_PERFORMANCE_SCHEMA_VERSION;
	complete: boolean;
	expectedWindowLabels: string[];
	missingWindowLabels: string[];
	totals: Totals;
	render: Omit<RenderPressure, "perSurface"> | null;
	terminalPresentation: StructuredTerminalPresentationTotalsSnapshot;
	windows: WindowPerformanceDiagnostics[];
}

interface ResponsePayload {
	requestId: string;
	sample: WindowPerformanceDiagnostics;
}

export type WindowPerformanceCollectorBackend =
	WindowReportCollectorBackend<WindowPerformanceDiagnostics>;

type WindowReportTransport = Pick<
	WindowPerformanceCollectorBackend,
	"currentWindowLabel" | "listWindowLabels" | "listenResponse" | "emitRequest"
>;

const windowReportTransport: WindowReportTransport = {
	currentWindowLabel: () => getCurrentWebviewWindow().label,
	listWindowLabels: async () =>
		(await getAllWebviewWindows()).map((window) => window.label),
	listenResponse: (listener) =>
		listenWhenReady<unknown>(WINDOW_REPORT_RESPONSE_EVENT, (event) =>
			listener(event.payload),
		),
	emitRequest: (windowLabel, payload) =>
		emitTo(
			{ kind: "WebviewWindow", label: windowLabel },
			WINDOW_REPORT_REQUEST_EVENT,
			payload,
		),
};

const collectorBackend: WindowPerformanceCollectorBackend = {
	...windowReportTransport,
	readLocal: readWindowPerformanceDiagnostics,
};

const terminalInputCollectorBackend: WindowReportCollectorBackend<WindowTerminalInputDiagnostics> =
	{
		...windowReportTransport,
		readLocal: readWindowTerminalInputDiagnostics,
	};

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function finiteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nullableFiniteNonNegative(value: unknown): boolean {
	return value === null || finiteNonNegative(value);
}

function optionalFiniteNonNegative(value: unknown): boolean {
	return value === undefined || finiteNonNegative(value);
}

function safeNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && finiteNonNegative(value);
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const INVALID_TELEMETRY = Symbol("invalid-telemetry");
const ARRAY_SCHEMA = Symbol("array-schema");
const NULLABLE_SCHEMA = Symbol("nullable-schema");
const REFINED_SCHEMA = Symbol("refined-schema");

type TelemetryValidator = (value: unknown) => boolean;
interface TelemetryObjectSchema {
	readonly [key: string]: TelemetrySchema;
}
interface TelemetryArraySchema {
	readonly [ARRAY_SCHEMA]: TelemetrySchema;
}
interface TelemetryNullableSchema {
	readonly [NULLABLE_SCHEMA]: TelemetrySchema;
}
interface TelemetryRefinedSchema {
	readonly [REFINED_SCHEMA]: {
		readonly schema: TelemetrySchema;
		readonly accepts: TelemetryValidator;
	};
}
type TelemetrySchema =
	| TelemetryValidator
	| TelemetryObjectSchema
	| TelemetryArraySchema
	| TelemetryNullableSchema
	| TelemetryRefinedSchema;

function arrayOf(schema: TelemetrySchema): TelemetryArraySchema {
	return { [ARRAY_SCHEMA]: schema };
}

function nullable(schema: TelemetrySchema): TelemetryNullableSchema {
	return { [NULLABLE_SCHEMA]: schema };
}

function refined(
	schema: TelemetrySchema,
	accepts: TelemetryValidator,
): TelemetryRefinedSchema {
	return { [REFINED_SCHEMA]: { schema, accepts } };
}

function literal(...allowed: readonly unknown[]): TelemetryValidator {
	return (value) => allowed.includes(value);
}

function nullableBoolean(value: unknown): boolean {
	return value === null || typeof value === "boolean";
}

function nullableNonEmptyString(value: unknown): boolean {
	return value === null || nonEmptyString(value);
}

function schemaFields(
	keys: readonly string[],
	schema: TelemetrySchema,
): TelemetryObjectSchema {
	return Object.fromEntries(keys.map((key) => [key, schema]));
}

function projectTelemetry(
	value: unknown,
	schema: TelemetrySchema,
): unknown | typeof INVALID_TELEMETRY {
	if (typeof schema === "function") {
		return schema(value) ? value : INVALID_TELEMETRY;
	}
	if (ARRAY_SCHEMA in schema) {
		if (
			!Array.isArray(value) ||
			value.length > MAX_INTERACTION_RECENT_SAMPLES
		) {
			return INVALID_TELEMETRY;
		}
		const projected = value.map((entry) =>
			projectTelemetry(entry, schema[ARRAY_SCHEMA]),
		);
		return projected.includes(INVALID_TELEMETRY)
			? INVALID_TELEMETRY
			: projected;
	}
	if (NULLABLE_SCHEMA in schema) {
		return value === null
			? null
			: projectTelemetry(value, schema[NULLABLE_SCHEMA]);
	}
	if (REFINED_SCHEMA in schema) {
		const refinement = schema[REFINED_SCHEMA];
		const projected = projectTelemetry(value, refinement.schema);
		return projected !== INVALID_TELEMETRY && refinement.accepts(projected)
			? projected
			: INVALID_TELEMETRY;
	}
	if (!record(value)) return INVALID_TELEMETRY;
	const projected: Record<string, unknown> = {};
	for (const [key, childSchema] of Object.entries(schema)) {
		const child = projectTelemetry(value[key], childSchema);
		if (child === INVALID_TELEMETRY) return INVALID_TELEMETRY;
		projected[key] = child;
	}
	return projected;
}

const LATENCY_STATS_SCHEMA = refined(
	{
		count: safeNonNegativeInteger,
		median: nullableFiniteNonNegative,
		p95: nullableFiniteNonNegative,
		max: nullableFiniteNonNegative,
	},
	(value) => {
		if (!record(value)) return false;
		const values = [value.median, value.p95, value.max];
		if (value.count === 0) return values.every((entry) => entry === null);
		if (!values.every(finiteNonNegative)) return false;
		const [median, p95, maximum] = values as number[];
		return median <= p95 && p95 <= maximum;
	},
);

const INPUT_SCHEDULER_ACTIVITY_SCHEMA = {
	unitsRun: safeNonNegativeInteger,
	msSpent: finiteNonNegative,
	terminalPresentationUnitsRun: safeNonNegativeInteger,
	terminalPresentationMsSpent: finiteNonNegative,
} satisfies TelemetryObjectSchema;

const TERMINAL_INPUT_SAMPLE_SCHEMA = {
	sequence: safeNonNegativeInteger,
	terminalId: nonEmptyString,
	desktopId: nullableNonEmptyString,
	source: literal("keydown", "input"),
	startedAt: finiteNonNegative,
	dispatchMs: finiteNonNegative,
	...(import.meta.env.MODE === "perf"
		? schemaFields(
				[
					"carrierFirstResolvedMs",
					"carrierLastResolvedMs",
					"carrierDecodeStartedMs",
					"carrierDecodedMs",
					"carrierDecodeWorkMs",
					"carrierPartCount",
					"carrierBytes",
					"replicaApplyStartedMs",
					"replicaAppliedMs",
				],
				optionalFiniteNonNegative,
			)
		: {}),
	...schemaFields(
		[
			"captureToSemanticHandlerMs",
			"semanticHandlerToDispatchMs",
			"semanticHandlerToDecisionMs",
			"semanticDecisionToDispatchMs",
			"transportConfirmationMs",
			"hostReceiptMs",
			"hostInputAcceptedToOutputMs",
			"hostOutputToProjectionStartMs",
			"outputReceivedMs",
			"projectionStartedMs",
			"projectionCommittedMs",
			"echoTaskMs",
			"echoFrameMs",
			"echoPaintMs",
			"receiptToOutputMs",
			"outputToPaintMs",
			"receiptToPaintMs",
		],
		nullableFiniteNonNegative,
	),
	replacementChainActiveAtCapture: nullableBoolean,
	hostReceiptBeforeTransportConfirmation: nullableBoolean,
	successorOutputObserved: (value: unknown) => typeof value === "boolean",
	frameBeforeTask: nullableBoolean,
	taskToFrameSchedulerActivity: nullable(INPUT_SCHEDULER_ACTIVITY_SCHEMA),
	outcome: literal("complete", "correlation_superseded", "failed", "timed_out"),
} satisfies TelemetryObjectSchema;

const KEYDOWN_STAGE_SCHEMA = schemaFields(
	[
		"captureToSemanticHandler",
		"semanticHandlerToDispatch",
		"semanticHandlerToDecision",
		"semanticDecisionToDispatch",
	],
	LATENCY_STATS_SCHEMA,
);
const KEYDOWN_DISPATCH_SCHEMA = {
	dispatch: LATENCY_STATS_SCHEMA,
	...KEYDOWN_STAGE_SCHEMA,
} satisfies TelemetryObjectSchema;

const INPUT_SOURCE_SCHEMA = {
	...schemaFields(
		[
			"completedCount",
			"correlationSupersededCount",
			"failedCount",
			"timedOutCount",
			"timedOutAfterSuccessorOutputCount",
			"timedOutWithoutSuccessorCount",
			"hostReceiptBeforeTransportConfirmationCount",
			"frameBeforeTaskCount",
		],
		safeNonNegativeInteger,
	),
	...schemaFields(
		[
			"dispatchToTransportConfirmation",
			"transportConfirmationToHostReceipt",
			"hostAcceptedToOutput",
			"projectionCommitToTask",
			"taskToFrame",
			"projectionCommitToFrame",
			"frameToPostPaint",
			"inputToEchoPaint",
		],
		LATENCY_STATS_SCHEMA,
	),
} satisfies TelemetryObjectSchema;

const TERMINAL_INPUT_SCHEMA = {
	...schemaFields(
		[
			"dispatch",
			"keydownToHostReceipt",
			"keydownToEchoPaint",
			"hostReceiptToEchoPaint",
			"inputToHostReceipt",
			"inputDispatchToTransportConfirmation",
			"inputTransportConfirmationToHostReceipt",
			"inputHostAcceptedToOutput",
			"inputHostOutputToProjectionStart",
			"inputToOutputReceived",
			"inputReceiptToOutputReceived",
			"inputToEchoPaint",
			"inputOutputToEchoPaint",
			"inputOutputToProjectionStart",
			"inputProjectionWork",
			"inputProjectionCommitToTask",
			"inputTaskToFrame",
			"inputProjectionCommitToFrame",
			"inputFrameToPostPaint",
			"inputProjectionCommitToEchoPaint",
			"inputReceiptToEchoPaint",
		],
		LATENCY_STATS_SCHEMA,
	),
	keydownDispatchStages: {
		...KEYDOWN_STAGE_SCHEMA,
		byReplacementState: {
			inactive: KEYDOWN_DISPATCH_SCHEMA,
			active: KEYDOWN_DISPATCH_SCHEMA,
			unknown: KEYDOWN_DISPATCH_SCHEMA,
		},
	},
	...schemaFields(
		[
			"inputHostReceiptBeforeTransportConfirmationCount",
			"inputFrameBeforeTaskCount",
			"completedCount",
			"correlationSupersededCount",
			"failedCount",
			"timedOutCount",
			"timedOutAfterSuccessorOutputCount",
			"timedOutWithoutSuccessorCount",
			"inFlightCount",
		],
		safeNonNegativeInteger,
	),
	bySource: {
		keydown: INPUT_SOURCE_SCHEMA,
		input: INPUT_SOURCE_SCHEMA,
	},
	recent: arrayOf(TERMINAL_INPUT_SAMPLE_SCHEMA),
} satisfies TelemetryObjectSchema;

const PANE_FOCUS_SCHEDULER_LANE_SCHEMA = {
	unitsRun: safeNonNegativeInteger,
	msSpent: finiteNonNegative,
	starvationRescues: safeNonNegativeInteger,
} satisfies TelemetryObjectSchema;

const PANE_FOCUS_SAMPLE_SCHEMA = {
	sequence: safeNonNegativeInteger,
	desktopId: nonEmptyString,
	panelId: nonEmptyString,
	terminal: (value: unknown) => typeof value === "boolean",
	startedAt: finiteNonNegative,
	...schemaFields(
		[
			"commitMs",
			"eventMicrotaskMs",
			"eventMessageTaskMs",
			"eventTaskMs",
			"firstFrameMs",
			"terminalRoleCommitMs",
			"terminalInputFocusCommitMs",
			"terminalInputFocusPreHandlerMs",
			"terminalInputFocusHandlerMs",
			"terminalInputFocusPostHandlerMs",
			"terminalInputFocusProjectionMs",
			"terminalInputFocusIntentDispatchMs",
			"terminalInputFocusNativeRemainderMs",
			"paintMs",
			"interactiveMs",
		],
		nullableFiniteNonNegative,
	),
	commitToFirstFrameSchedulerActivity: nullable({
		reveal: PANE_FOCUS_SCHEDULER_LANE_SCHEMA,
		catchup: PANE_FOCUS_SCHEDULER_LANE_SCHEMA,
		maintenance: PANE_FOCUS_SCHEDULER_LANE_SCHEMA,
	}),
	localGeometryMs: finiteNonNegative,
	localGeometryCount: safeNonNegativeInteger,
	terminalRoleEffectMs: finiteNonNegative,
	terminalInputFocusCallMs: finiteNonNegative,
	outcome: literal("pending", "complete", "superseded", "aborted"),
} satisfies TelemetryObjectSchema;

const PANE_FOCUS_SCHEMA = {
	...schemaFields(
		[
			"commit",
			"eventMicrotask",
			"eventMessageTask",
			"eventTask",
			"firstFrame",
			"localGeometry",
			"terminalRoleCommit",
			"terminalRoleEffect",
			"terminalInputFocusCommit",
			"terminalInputFocusCall",
			"terminalInputFocusPreHandler",
			"terminalInputFocusHandler",
			"terminalInputFocusPostHandler",
			"terminalInputFocusProjection",
			"terminalInputFocusIntentDispatch",
			"terminalInputFocusNativeRemainder",
			"paint",
			"terminalInteractive",
		],
		LATENCY_STATS_SCHEMA,
	),
	incompleteTerminalCount: safeNonNegativeInteger,
	supersededCount: safeNonNegativeInteger,
	abortedCount: safeNonNegativeInteger,
	recent: arrayOf(PANE_FOCUS_SAMPLE_SCHEMA),
} satisfies TelemetryObjectSchema;

function parseTerminalInputDiagnostics(
	value: unknown,
): WorkspacePerformanceReport["terminalInput"] | null | undefined {
	if (value === undefined || value === null) return null;
	const projected = projectTelemetry(value, TERMINAL_INPUT_SCHEMA);
	return projected === INVALID_TELEMETRY
		? undefined
		: (projected as WorkspacePerformanceReport["terminalInput"]);
}

function parsePaneFocusDiagnostics(
	value: unknown,
): WorkspacePerformanceReport["paneFocus"] | null | undefined {
	if (value === undefined || value === null) return null;
	const projected = projectTelemetry(value, PANE_FOCUS_SCHEMA);
	return projected === INVALID_TELEMETRY
		? undefined
		: (projected as WorkspacePerformanceReport["paneFocus"]);
}

function parsePaneDragDiagnostics(
	value: unknown,
): PaneDragPerformanceSnapshot | undefined | typeof INVALID_TELEMETRY {
	if (value === undefined) return undefined;
	if (
		!record(value) ||
		!finiteNonNegative(value.timeOriginMs) ||
		!nullableFiniteNonNegative(value.startedAt) ||
		!Array.isArray(value.recent) ||
		value.recent.length > MAX_PANE_DRAG_SAMPLES
	) {
		return INVALID_TELEMETRY;
	}
	const recent = value.recent.map((entry) =>
		projectTelemetry(entry, {
			sequence: safeNonNegativeInteger,
			eventType: literal("dragenter", "dragover"),
			receivedAt: finiteNonNegative,
			trusted: literal(true, false),
			...schemaFields(
				[
					"eventAgeMs",
					"receivedGapMs",
					"receiptToTaskMs",
					"receiptToFrameMs",
					"receiptToPostFrameTaskMs",
				],
				nullableFiniteNonNegative,
			),
			frameProbe: literal("pending", "complete", "coalesced", "cancelled"),
			frameProbeSequence: safeNonNegativeInteger,
		}),
	);
	if (recent.includes(INVALID_TELEMETRY)) return INVALID_TELEMETRY;
	const samples = recent as PaneDragPerformanceSnapshot["recent"];
	for (const [index, sample] of samples.entries()) {
		const previous = samples[index - 1];
		if (
			sample.sequence < 1 ||
			(sample.frameProbe === "coalesced"
				? sample.frameProbeSequence < 1 ||
					sample.frameProbeSequence >= sample.sequence
				: sample.frameProbeSequence !== sample.sequence) ||
			(typeof value.startedAt === "number" &&
				sample.receivedAt < value.startedAt) ||
			(previous &&
				(sample.sequence <= previous.sequence ||
					sample.receivedAt < previous.receivedAt)) ||
			(sample.eventAgeMs !== null &&
				(!sample.trusted || sample.eventAgeMs > sample.receivedAt)) ||
			(sample.frameProbe === "complete" &&
				(sample.receiptToFrameMs === null ||
					sample.receiptToPostFrameTaskMs === null)) ||
			(sample.receiptToPostFrameTaskMs !== null &&
				(sample.frameProbe !== "complete" ||
					sample.receiptToFrameMs === null ||
					sample.receiptToPostFrameTaskMs < sample.receiptToFrameMs)) ||
			(sample.frameProbe === "coalesced" &&
				[
					sample.receiptToTaskMs,
					sample.receiptToFrameMs,
					sample.receiptToPostFrameTaskMs,
				].some((value) => value !== null))
		) {
			return INVALID_TELEMETRY;
		}
	}
	return {
		timeOriginMs: value.timeOriginMs,
		startedAt: value.startedAt as number | null,
		recent: samples,
	};
}

function parseHmuxControlPlaneCensusRequestReason(
	value: unknown,
): HmuxControlPlaneCensusRequestReason | undefined {
	if (!value || typeof value !== "object") return undefined;
	const reason = value as Record<string, unknown>;
	if (reason.windowRole !== "main" && reason.windowRole !== "secondary") {
		return undefined;
	}
	if (
		reason.source === "app_control_plane" &&
		(reason.trigger === "initial" ||
			reason.trigger === "window_focus" ||
			reason.trigger === "visibility_foreground")
	) {
		return {
			source: reason.source,
			trigger: reason.trigger,
			windowRole: reason.windowRole,
		};
	}
	if (reason.source === "session_recovery" && reason.trigger === "refresh") {
		return {
			source: reason.source,
			trigger: reason.trigger,
			windowRole: reason.windowRole,
		};
	}
	return undefined;
}

function parseHmuxControlPlaneCensusObservation(
	value: unknown,
): HmuxControlPlaneCensusPerformanceObservation | null {
	if (!value || typeof value !== "object") return null;
	const observation = value as Record<string, unknown>;
	const requestReason = parseHmuxControlPlaneCensusRequestReason(
		observation.requestReason,
	);
	const sessionCounts = observation.sessionCounts as
		| Record<string, unknown>
		| undefined;
	if (
		!requestReason ||
		!finiteNonNegative(observation.receivedAtMs) ||
		!safeNonNegativeInteger(sessionCounts?.total) ||
		!safeNonNegativeInteger(sessionCounts?.ready) ||
		!safeNonNegativeInteger(sessionCounts?.exited) ||
		sessionCounts.ready + sessionCounts.exited > sessionCounts.total
	) {
		return null;
	}

	let diagnostics:
		| HmuxControlPlaneCensusPerformanceObservation["diagnostics"]
		| undefined;
	if (observation.diagnostics !== undefined) {
		if (
			!observation.diagnostics ||
			typeof observation.diagnostics !== "object"
		) {
			return null;
		}
		const candidate = observation.diagnostics as Record<string, unknown>;
		if (
			!safeNonNegativeInteger(candidate.catalogUs) ||
			!safeNonNegativeInteger(candidate.healthProjectionUs) ||
			!safeNonNegativeInteger(candidate.totalUs) ||
			typeof candidate.joinedExisting !== "boolean" ||
			candidate.totalUs < candidate.catalogUs + candidate.healthProjectionUs
		) {
			return null;
		}
		diagnostics = {
			catalogUs: candidate.catalogUs,
			healthProjectionUs: candidate.healthProjectionUs,
			totalUs: candidate.totalUs,
			joinedExisting: candidate.joinedExisting,
		};
	}

	return {
		requestReason,
		receivedAtMs: observation.receivedAtMs,
		...(diagnostics ? { diagnostics } : {}),
		sessionCounts: {
			total: sessionCounts.total,
			ready: sessionCounts.ready,
			exited: sessionCounts.exited,
		},
	};
}

interface PresentationWork {
	commits: number;
	totalMs: number;
	maxMs: number;
}

function presentationWork(value: unknown): value is PresentationWork {
	if (!value || typeof value !== "object") return false;
	const work = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(work.commits) &&
		finiteNonNegative(work.commits) &&
		finiteNonNegative(work.totalMs) &&
		finiteNonNegative(work.maxMs) &&
		(work.commits === 0
			? work.totalMs === 0 && work.maxMs === 0
			: (work.maxMs as number) <= (work.totalMs as number))
	);
}

function presentationBreakdown(
	total: unknown,
	byRole: Record<string, unknown> | undefined,
): boolean {
	const roles = [
		byRole?.foreground,
		byRole?.hovered,
		byRole?.background,
		byRole?.ungated,
	];
	if (!presentationWork(total) || !roles.every(presentationWork)) return false;
	const work = roles as PresentationWork[];
	const summedCommits = work.reduce((sum, role) => sum + role.commits, 0);
	const summedMs = work.reduce((sum, role) => sum + role.totalMs, 0);
	return (
		Number.isSafeInteger(summedCommits) &&
		Number.isFinite(summedMs) &&
		total.commits === summedCommits &&
		Math.abs(total.totalMs - summedMs) <=
			Math.max(1, total.totalMs, summedMs) *
				PRESENTATION_TOTAL_MS_RELATIVE_TOLERANCE &&
		total.maxMs === Math.max(...work.map((role) => role.maxMs))
	);
}

function terminalPresentationSnapshot(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as Record<string, unknown> & {
		byRole?: Record<string, unknown>;
	};
	if (
		!presentationBreakdown(snapshot.total, snapshot.byRole) ||
		!Array.isArray(snapshot.perSurface)
	) {
		return false;
	}
	const ids = new Set<string>();
	for (const value of snapshot.perSurface) {
		if (!value || typeof value !== "object") return false;
		const surface = value as Record<string, unknown> & {
			byRole?: Record<string, unknown>;
		};
		if (
			!nonEmptyString(surface.id) ||
			ids.has(surface.id) ||
			!presentationBreakdown(surface.total, surface.byRole)
		) {
			return false;
		}
		ids.add(surface.id);
	}
	return true;
}

function parseResponse(value: unknown): ResponsePayload | undefined {
	if (!value || typeof value !== "object") return undefined;
	const payload = value as Record<string, unknown>;
	if (!nonEmptyString(payload.requestId) || payload.projection !== undefined) {
		return undefined;
	}
	const sample = payload.sample as
		| (Record<string, unknown> & {
				totals?: Record<string, unknown>;
				render?: Record<string, unknown> | null;
				eventLoopLag?: Record<string, unknown>;
		  })
		| undefined;
	const animations = sample
		? sample.animations === undefined
			? unavailableWindowAnimationDiagnostics()
			: parseWindowAnimationDiagnostics(sample.animations)
		: undefined;
	const hmuxControlPlaneCensus = sample
		? parseHmuxControlPlaneCensusObservation(sample.hmuxControlPlaneCensus)
		: null;
	const terminalInput = sample
		? parseTerminalInputDiagnostics(sample.terminalInput)
		: undefined;
	const paneFocus = sample
		? parsePaneFocusDiagnostics(sample.paneFocus)
		: undefined;
	const paneDrag = sample
		? parsePaneDragDiagnostics(sample.paneDrag)
		: undefined;
	if (
		!sample ||
		sample.schemaVersion !== WINDOW_PERFORMANCE_SCHEMA_VERSION ||
		!nonEmptyString(sample.windowLabel) ||
		!finiteNonNegative(sample.generatedAtMs) ||
		!finiteNonNegative(sample.totals?.mountedWorkspaces) ||
		!finiteNonNegative(sample.totals?.terminalSurfaces) ||
		!optionalFiniteNonNegative(sample.totals?.terminalGpuViewportBytes) ||
		!finiteNonNegative(sample.totals?.terminalModelBytes) ||
		!finiteNonNegative(sample.totals?.webglContexts) ||
		!finiteNonNegative(sample.totals?.hmuxObservers) ||
		(sample.render !== null &&
			(!finiteNonNegative(sample.render?.bufferedBytes) ||
				!finiteNonNegative(sample.render?.peakBufferedBytes) ||
				!finiteNonNegative(sample.render?.maxRecentWriteLatencyMs) ||
				!Array.isArray(sample.render?.perSurface))) ||
		!terminalPresentationSnapshot(sample.terminalPresentation) ||
		typeof sample.eventLoopLag?.visible !== "boolean" ||
		typeof sample.eventLoopLag?.focused !== "boolean" ||
		!finiteNonNegative(sample.eventLoopLag?.contextChangedAtMs) ||
		!nullableFiniteNonNegative(sample.eventLoopLag?.lastSampleAtMs) ||
		!finiteNonNegative(sample.eventLoopLag?.sampleCount) ||
		!nullableFiniteNonNegative(sample.eventLoopLag?.recentP95Ms) ||
		!nullableFiniteNonNegative(sample.eventLoopLag?.recentMaxMs) ||
		!animations ||
		terminalInput === undefined ||
		paneFocus === undefined ||
		paneDrag === INVALID_TELEMETRY
	) {
		return undefined;
	}
	return {
		requestId: payload.requestId,
		sample: {
			...sample,
			animations,
			hmuxControlPlaneCensus,
			terminalInput,
			paneFocus,
			paneDrag,
		} as unknown as WindowPerformanceDiagnostics,
	};
}

function aggregate(
	expectedWindowLabels: string[],
	samples: ReadonlyMap<string, WindowPerformanceDiagnostics>,
): MultiWindowPerformanceDiagnostics {
	const windows = expectedWindowLabels.flatMap((label) => {
		const sample = samples.get(label);
		return sample ? [sample] : [];
	});
	const totals = windows.reduce<Totals>(
		(sum, window) => ({
			mountedWorkspaces:
				sum.mountedWorkspaces + window.totals.mountedWorkspaces,
			terminalSurfaces: sum.terminalSurfaces + window.totals.terminalSurfaces,
			terminalGpuViewportBytes:
				(sum.terminalGpuViewportBytes ?? 0) +
				(window.totals.terminalGpuViewportBytes ?? 0),
			terminalModelBytes:
				(sum.terminalModelBytes ?? 0) + (window.totals.terminalModelBytes ?? 0),
			webglContexts: sum.webglContexts + window.totals.webglContexts,
			hmuxObservers: sum.hmuxObservers + window.totals.hmuxObservers,
		}),
		{
			mountedWorkspaces: 0,
			terminalSurfaces: 0,
			terminalGpuViewportBytes: 0,
			terminalModelBytes: 0,
			webglContexts: 0,
			hmuxObservers: 0,
		},
	);
	const missingWindowLabels = expectedWindowLabels.filter(
		(label) => !samples.has(label),
	);
	const renderSamples = windows.flatMap((window) =>
		window.render ? [window.render] : [],
	);
	return {
		schemaVersion: WINDOW_PERFORMANCE_SCHEMA_VERSION,
		complete: missingWindowLabels.length === 0,
		expectedWindowLabels,
		missingWindowLabels,
		totals,
		render:
			renderSamples.length > 0 &&
			renderSamples.length === expectedWindowLabels.length
				? {
						bufferedBytes: renderSamples.reduce(
							(sum, render) => sum + render.bufferedBytes,
							0,
						),
						peakBufferedBytes: renderSamples.reduce(
							(sum, render) => sum + render.peakBufferedBytes,
							0,
						),
						maxRecentWriteLatencyMs: renderSamples.reduce(
							(maximum, render) =>
								Math.max(maximum, render.maxRecentWriteLatencyMs),
							0,
						),
					}
				: null,
		terminalPresentation: aggregateStructuredTerminalPresentationSnapshots(
			windows.map((window) => window.terminalPresentation),
		),
		windows,
	};
}

export async function collectWindowPerformanceDiagnostics(
	backend: WindowPerformanceCollectorBackend = collectorBackend,
	timeoutMs = COLLECTION_TIMEOUT_MS,
): Promise<MultiWindowPerformanceDiagnostics> {
	const { expectedWindowLabels, samples } = await collectWindowReportSamples(
		backend,
		parseResponse,
		timeoutMs,
	);
	return aggregate(expectedWindowLabels, samples);
}

export async function collectWindowTerminalInputDiagnostics(
	backend: WindowReportCollectorBackend<WindowTerminalInputDiagnostics> = terminalInputCollectorBackend,
	timeoutMs = COLLECTION_TIMEOUT_MS,
): Promise<MultiWindowTerminalInputDiagnostics> {
	const { expectedWindowLabels, samples } = await collectWindowReportSamples(
		backend,
		(value) =>
			parseWindowTerminalInputResponse(value, parseTerminalInputDiagnostics),
		timeoutMs,
		"terminal-input",
	);
	return aggregateWindowTerminalInputDiagnostics(expectedWindowLabels, samples);
}
