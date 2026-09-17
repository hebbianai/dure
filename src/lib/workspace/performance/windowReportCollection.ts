import {
	collectWindowSamples,
	type WindowSampleCollectorBackend,
	type WindowSampleResponse,
} from "@/lib/workspace/window/windowSampleCollection";

export type WindowReportProjection = "terminal-input";

export const WINDOW_REPORT_REQUEST_EVENT =
	"dure://performance/window-report/request";
export const WINDOW_REPORT_RESPONSE_EVENT =
	"dure://performance/window-report/response";

export interface WindowReportRequestPayload {
	requestId: string;
	replyWindowLabel: string;
	projection?: WindowReportProjection;
}

export function parseWindowReportRequest(
	value: unknown,
): WindowReportRequestPayload | undefined {
	if (!value || typeof value !== "object") return undefined;
	const payload = value as Record<string, unknown>;
	const requestId = payload.requestId;
	const replyWindowLabel = payload.replyWindowLabel;
	if (
		typeof requestId !== "string" ||
		requestId.length === 0 ||
		requestId.length > 256 ||
		typeof replyWindowLabel !== "string" ||
		replyWindowLabel.length === 0 ||
		replyWindowLabel.length > 256 ||
		(payload.projection !== undefined &&
			payload.projection !== "terminal-input")
	) {
		return undefined;
	}
	return {
		requestId,
		replyWindowLabel,
		...(payload.projection === "terminal-input"
			? { projection: payload.projection }
			: {}),
	};
}

export type ParsedWindowReportResponse<Sample> = WindowSampleResponse<Sample>;

export interface WindowReportCollectorBackend<
	Sample extends { windowLabel: string },
> extends WindowSampleCollectorBackend<Sample, WindowReportRequestPayload> {
	readLocal(): Promise<Sample>;
}

/** Runs the existing request/response fan-out for one explicitly parsed projection. */
export async function collectWindowReportSamples<
	Sample extends { windowLabel: string },
>(
	backend: WindowReportCollectorBackend<Sample>,
	parseResponse: (
		value: unknown,
	) => ParsedWindowReportResponse<Sample> | undefined,
	timeoutMs: number,
	projection?: WindowReportProjection,
): Promise<{
	expectedWindowLabels: string[];
	samples: ReadonlyMap<string, Sample>;
}> {
	return collectWindowSamples(
		backend,
		parseResponse,
		timeoutMs,
		(requestId, replyWindowLabel) => ({
			requestId,
			replyWindowLabel,
			...(projection ? { projection } : {}),
		}),
	);
}
