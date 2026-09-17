type ConsoleWithTimeStamp = Pick<Console, "timeStamp">;

const noop = () => {};

/**
 * Hide the React 19 dev performance-track capability for exactly one read.
 * React probes `console.timeStamp` while react-dom/client is evaluated.
 */
export function maskNextReactDevPerformanceTrackProbe(
	target: ConsoleWithTimeStamp,
): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(target, "timeStamp");
	let active = false;
	const restore = () => {
		if (!active) return;
		active = false;
		if (descriptor) {
			Reflect.defineProperty(target, "timeStamp", descriptor);
		} else {
			Reflect.deleteProperty(target, "timeStamp");
		}
	};

	const installed = Reflect.defineProperty(target, "timeStamp", {
		configurable: true,
		enumerable: descriptor?.enumerable ?? false,
		get() {
			restore();
			return undefined;
		},
	});
	if (!installed) return noop;
	active = true;
	return restore;
}

if (import.meta.env.DEV && typeof window !== "undefined") {
	maskNextReactDevPerformanceTrackProbe(console);
}
