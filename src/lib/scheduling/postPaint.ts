export interface PostPaintHost {
	requestAnimationFrame(callback: FrameRequestCallback): number;
	cancelAnimationFrame(handle: number): void;
}

export type PostPaintTaskScheduler = MessageTaskScheduler;

export interface PostPaintOptions {
	/** Test seam; production shares one MessageChannel per WebView. */
	tasks?: PostPaintTaskScheduler;
	/** Called from the shared task queue independently of frame eligibility. */
	onTask?: () => void;
	/** Called at the start of the rendering callback, before yielding to paint. */
	onFrame?: () => void;
}

/**
 * Run once after the next browser paint. A MessageChannel task scheduled inside
 * rAF runs after that rendering update without timer clamping or a second frame.
 */
export function schedulePostPaint(
	host: PostPaintHost,
	callback: () => void,
	options: PostPaintOptions = {},
): () => void {
	const tasks = options.tasks ?? browserMessageTasks();
	let cancelled = false;
	let observationTask: number | undefined;
	let postPaintTask: number | undefined;
	if (options.onTask) {
		observationTask = tasks.request(() => {
			observationTask = undefined;
			if (!cancelled) options.onTask?.();
		});
	}
	let frame: number | undefined = host.requestAnimationFrame(() => {
		frame = undefined;
		if (cancelled) return;
		options.onFrame?.();
		postPaintTask = tasks.request(() => {
			postPaintTask = undefined;
			if (!cancelled) callback();
		});
	});

	return () => {
		cancelled = true;
		if (frame !== undefined) host.cancelAnimationFrame(frame);
		if (observationTask !== undefined) tasks.cancel(observationTask);
		if (postPaintTask !== undefined) tasks.cancel(postPaintTask);
		frame = undefined;
		observationTask = undefined;
		postPaintTask = undefined;
	};
}
import {
	browserMessageTasks,
	type MessageTaskScheduler,
} from "./messageTask";
