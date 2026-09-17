import { describe, expect, it, vi } from "vitest";
import {
	collectWindowSamples,
	type WindowSampleCollectorBackend,
} from "./windowSampleCollection";

interface Sample {
	windowLabel: string;
	value: number;
}

interface Request {
	requestId: string;
	replyWindowLabel: string;
	kind: "sample";
}

function parseResponse(value: unknown) {
	const response = value as { requestId?: unknown; sample?: Partial<Sample> };
	return typeof response?.requestId === "string" &&
		typeof response.sample?.windowLabel === "string" &&
		typeof response.sample.value === "number"
		? { requestId: response.requestId, sample: response.sample as Sample }
		: undefined;
}

describe("window sample collection", () => {
	it("collects the current WebView first and live peers in lexical order", async () => {
		let respond: (payload: unknown) => void = () => undefined;
		const stop = vi.fn();
		const backend: WindowSampleCollectorBackend<Sample, Request> = {
			currentWindowLabel: () => "main",
			listWindowLabels: async () => ["win-b", "main", "win-a", "win-b"],
			readLocal: () => ({ windowLabel: "main", value: 0 }),
			listenResponse: async (listener) => {
				respond = listener;
				return stop;
			},
			emitRequest: async (windowLabel, request) => {
				respond({
					requestId: request.requestId,
					sample: { windowLabel, value: windowLabel === "win-a" ? 1 : 2 },
				});
			},
		};

		const result = await collectWindowSamples(
			backend,
			parseResponse,
			20,
			(requestId, replyWindowLabel) => ({
				requestId,
				replyWindowLabel,
				kind: "sample",
			}),
		);

		expect(result.expectedWindowLabels).toEqual(["main", "win-a", "win-b"]);
		expect([...result.samples.values()]).toEqual([
			{ windowLabel: "main", value: 0 },
			{ windowLabel: "win-a", value: 1 },
			{ windowLabel: "win-b", value: 2 },
		]);
		expect(stop).toHaveBeenCalledOnce();
	});

	it("returns the available samples when a live peer does not respond", async () => {
		const backend: WindowSampleCollectorBackend<Sample, Request> = {
			currentWindowLabel: () => "main",
			listWindowLabels: async () => ["main", "stalled"],
			readLocal: () => ({ windowLabel: "main", value: 0 }),
			listenResponse: async () => () => undefined,
			emitRequest: async () => undefined,
		};

		const result = await collectWindowSamples(
			backend,
			parseResponse,
			1,
			(requestId, replyWindowLabel) => ({
				requestId,
				replyWindowLabel,
				kind: "sample",
			}),
		);

		expect([...result.samples.keys()]).toEqual(["main"]);
	});
});
