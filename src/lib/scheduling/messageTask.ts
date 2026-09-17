export interface MessageTaskScheduler {
	request(callback: () => void): number;
	cancel(handle: number): void;
}

let browserScheduler: MessageTaskScheduler | undefined;

/** One cancellable MessageChannel shared by the WebView. */
export function browserMessageTasks(): MessageTaskScheduler {
	if (browserScheduler) return browserScheduler;
	let nextHandle = 1;
	const callbacks = new Map<number, () => void>();
	const channel = new MessageChannel();
	channel.port1.onmessage = (event: MessageEvent<number>) => {
		const callback = callbacks.get(event.data);
		if (!callback) return;
		callbacks.delete(event.data);
		callback();
	};
	browserScheduler = {
		request(callback) {
			const handle = nextHandle++;
			callbacks.set(handle, callback);
			channel.port2.postMessage(handle);
			return handle;
		},
		cancel(handle) {
			callbacks.delete(handle);
		},
	};
	return browserScheduler;
}
