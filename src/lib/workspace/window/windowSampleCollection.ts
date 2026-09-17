export interface WindowSampleRequest {
	requestId: string;
	replyWindowLabel: string;
}

export interface WindowSampleResponse<Sample> {
	requestId: string;
	sample: Sample;
}

export interface WindowSampleCollectorBackend<
	Sample extends { windowLabel: string },
	Request extends WindowSampleRequest,
> {
	currentWindowLabel(): string;
	listWindowLabels(): Promise<string[]>;
	readLocal(): Sample | Promise<Sample>;
	listenResponse(listener: (payload: unknown) => void): Promise<() => void>;
	emitRequest(windowLabel: string, request: Request): Promise<void>;
}

/** Collect one on-demand sample from each live WebView without retaining a
 * second registry. Missing responders remain visible as absent map entries. */
export async function collectWindowSamples<
	Sample extends { windowLabel: string },
	Request extends WindowSampleRequest,
>(
	backend: WindowSampleCollectorBackend<Sample, Request>,
	parseResponse: (value: unknown) => WindowSampleResponse<Sample> | undefined,
	timeoutMs: number,
	request: (requestId: string, replyWindowLabel: string) => Request,
): Promise<{
	expectedWindowLabels: string[];
	samples: ReadonlyMap<string, Sample>;
}> {
	const currentWindowLabel = backend.currentWindowLabel();
	const expectedWindowLabels = [
		currentWindowLabel,
		...Array.from(new Set(await backend.listWindowLabels()))
			.filter((label) => label !== currentWindowLabel)
			.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
	];
	const samples = new Map<string, Sample>([
		[currentWindowLabel, await backend.readLocal()],
	]);
	const pending = new Set(
		expectedWindowLabels.filter((label) => label !== currentWindowLabel),
	);
	if (pending.size === 0) return { expectedWindowLabels, samples };

	let finish: (() => void) | undefined;
	const completed = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const requestId = crypto.randomUUID();
	const unlisten = await backend.listenResponse((value) => {
		const response = parseResponse(value);
		if (
			!response ||
			response.requestId !== requestId ||
			!pending.delete(response.sample.windowLabel)
		) {
			return;
		}
		samples.set(response.sample.windowLabel, response.sample);
		if (pending.size === 0) finish?.();
	});
	const timeout = globalThis.setTimeout(() => finish?.(), timeoutMs);
	try {
		for (const windowLabel of [...pending]) {
			void backend
				.emitRequest(windowLabel, request(requestId, currentWindowLabel))
				.catch(() => {
					pending.delete(windowLabel);
					if (pending.size === 0) finish?.();
				});
		}
		await completed;
	} finally {
		globalThis.clearTimeout(timeout);
		unlisten();
	}
	return { expectedWindowLabels, samples };
}
