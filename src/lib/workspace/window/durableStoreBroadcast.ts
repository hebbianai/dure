import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	emitWhenReady,
	listenWhenReady,
} from "@/lib/platform/tauriBridge";

const DURABLE_STORE_CHANGED_EVENT = "dure://persistence/store-changed";
const fallbackSource = `realm-${Math.random().toString(36).slice(2)}`;

interface DurableStoreChangedPayload {
	readonly source: string;
	readonly store: string;
}

export interface DurableStoreBroadcastBackend {
	emitChanged(payload: DurableStoreChangedPayload): Promise<void>;
	listenChanged(listener: (payload: unknown) => void): Promise<() => void>;
	currentWindowLabel(): string;
}

const backend: DurableStoreBroadcastBackend = {
	emitChanged: (payload) => emitWhenReady(DURABLE_STORE_CHANGED_EVENT, payload),
	listenChanged: (listener) =>
		listenWhenReady<unknown>(DURABLE_STORE_CHANGED_EVENT, (event) =>
			listener(event.payload),
		),
	currentWindowLabel: () => getCurrentWindow().label,
};

function source(transport: DurableStoreBroadcastBackend): string {
	try {
		return transport.currentWindowLabel() || fallbackSource;
	} catch {
		return fallbackSource;
	}
}

/** Announces one completed durable write without carrying a second state copy. */
export function publishDurableStoreChanged(
	store: string,
	transport: DurableStoreBroadcastBackend = backend,
): Promise<void> {
	try {
		return transport.emitChanged({ source: source(transport), store }).catch(() => {});
	} catch {
		return Promise.resolve();
	}
}

/** Subscribes before the initial read so commits cannot fall into an install gap. */
export function subscribeDurableStoreChanged(
	store: string,
	onChanged: () => void,
	transport: DurableStoreBroadcastBackend = backend,
	includeCurrentWindow = false,
): () => void {
	const self = source(transport);
	let disposed = false;
	let stop: (() => void) | undefined;
	void transport
		.listenChanged((candidate) => {
			if (!candidate || typeof candidate !== "object") return;
			const payload = candidate as Partial<DurableStoreChangedPayload>;
			if (
				payload.store !== store ||
				(!includeCurrentWindow && payload.source === self)
			)
				return;
			onChanged();
		})
		.then((unlisten) => {
			if (disposed) {
				unlisten();
				return;
			}
			stop = unlisten;
			onChanged();
		})
		.catch(() => {});
	return () => {
		disposed = true;
		stop?.();
	};
}
