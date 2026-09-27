import { asRecord, nonEmptyString } from "@/lib/payloadGuards";
import type { HmuxPaneBindingV1 } from "@/lib/terminal/terminalBinding";

export interface HubTerminalWidthSnapshot {
	generation: string;
	revision: string;
	observations: Array<{
		route: { source: "local" | "ssh"; hostId: string };
		fence: {
			workspace_id: string;
			session_id: string;
			runner_principal: string;
			runner_instance: string;
			channel_epoch: string;
			host_instance_id: string;
			terminal_epoch: string;
		};
		columns: number;
	}>;
}

function decimal(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^(0|[1-9]\d{0,19})$/.test(value) &&
		BigInt(value) <= 18_446_744_073_709_551_615n
	);
}

export function hubTerminalWidthSnapshot(
	value: unknown,
): HubTerminalWidthSnapshot | undefined {
	const snapshot = asRecord(value);
	if (
		!snapshot ||
		!nonEmptyString(snapshot.generation) ||
		!decimal(snapshot.revision) ||
		!Array.isArray(snapshot.observations) ||
		snapshot.observations.length > 64
	)
		return;
	for (const value of snapshot.observations) {
		const observation = asRecord(value);
		const route = asRecord(observation?.route);
		const fence = asRecord(observation?.fence);
		if (
			!route ||
			(route.source !== "local" && route.source !== "ssh") ||
			!nonEmptyString(route.hostId) ||
			(route.source === "local" && route.hostId !== "local") ||
			!fence ||
			![
				"workspace_id",
				"session_id",
				"runner_principal",
				"runner_instance",
				"host_instance_id",
				"terminal_epoch",
			].every((key) => nonEmptyString(fence[key])) ||
			!decimal(fence.channel_epoch) ||
			!Number.isInteger(observation?.columns) ||
			Number(observation?.columns) < 1 ||
			Number(observation?.columns) > 1024
		)
			return;
	}
	return snapshot as unknown as HubTerminalWidthSnapshot;
}

export function widthForHubTerminal(
	snapshot: HubTerminalWidthSnapshot | undefined,
	binding: HmuxPaneBindingV1,
	terminalEpoch: string | null,
): number | undefined {
	if (!terminalEpoch) return;
	let width: number | undefined;
	for (const { route, fence, columns } of snapshot?.observations ?? []) {
		if (
			route.source !== binding.source ||
			route.hostId !== binding.hostId ||
			fence.session_id !== binding.sessionId ||
			fence.workspace_id !== binding.workspaceId ||
			fence.terminal_epoch !== terminalEpoch
		)
			continue;
		// Both native Host implementations mint a fresh UUID terminal epoch.
		// Route + binding + the installed frame's epoch pins this generation;
		// the native observer additionally validates the complete Hello/Ack fence.
		width = width === undefined ? columns : Math.min(width, columns);
	}
	return width;
}

interface Transport {
	listen: (receive: (payload: unknown) => void) => Promise<() => void>;
	snapshot: () => Promise<unknown>;
}

/** One subscription per WebView, shared by every mounted terminal pane. The
 * initial snapshot is fetched after listener registration, then reconciled with
 * buffered events. Only a native snapshot can establish a service generation. */
export function createHubTerminalWidthStore(transport: Transport) {
	let current: HubTerminalWidthSnapshot | undefined;
	const listeners = new Set<() => void>();
	let stop: (() => void) | undefined;
	const publish = (next: HubTerminalWidthSnapshot | undefined) => {
		if (current === next) return;
		current = next;
		for (const listener of listeners) listener();
	};
	const start = () => {
		let active = true;
		let unlisten: (() => void) | undefined;
		let fetching = false;
		let eventSequence = 0;
		const retiredGenerations = new Set<string>();
		const buffered = new Map<
			string,
			{ snapshot: HubTerminalWidthSnapshot; sequence: number }
		>();
		const accept = (next: HubTerminalWidthSnapshot) => {
			if (
				current?.generation === next.generation &&
				BigInt(current.revision) >= BigInt(next.revision)
			)
				return;
			publish(next);
		};
		const refresh = async () => {
			if (fetching || !active) return;
			fetching = true;
			const requestedAt = eventSequence;
			let refreshAgain = false;
			try {
				const snapshot = hubTerminalWidthSnapshot(await transport.snapshot());
				if (!active) return;
				if (!snapshot) {
					publish(undefined);
					return;
				}
				if (retiredGenerations.has(snapshot.generation)) return;
				if (current && current.generation !== snapshot.generation) {
					if (retiredGenerations.size >= 8) retiredGenerations.clear();
					retiredGenerations.add(current.generation);
				}
				const event = buffered.get(snapshot.generation)?.snapshot;
				accept(
					event && BigInt(event.revision) > BigInt(snapshot.revision)
						? event
						: snapshot,
				);
				for (const [generation, pending] of buffered) {
					if (
						generation !== snapshot.generation &&
						!retiredGenerations.has(generation) &&
						pending.sequence > requestedAt
					) {
						// This event may come from a service replacement that happened
						// after the request. Its authority needs a fresh snapshot.
						refreshAgain = true;
					} else {
						buffered.delete(generation);
					}
				}
			} catch {
				if (active) publish(undefined);
			} finally {
				fetching = false;
				if (active && refreshAgain) void refresh();
			}
		};
		void transport
			.listen((payload) => {
				if (!active) return;
				const event = hubTerminalWidthSnapshot(payload);
				if (!event) {
					publish(undefined);
					return;
				}
				if (retiredGenerations.has(event.generation)) return;
				eventSequence += 1;
				if (current?.generation === event.generation) {
					accept(event);
					return;
				}
				const prior = buffered.get(event.generation);
				if (
					!prior ||
					BigInt(prior.snapshot.revision) < BigInt(event.revision)
				) {
					if (buffered.size >= 8 && !buffered.has(event.generation))
						buffered.clear();
					buffered.set(event.generation, {
						snapshot: event,
						sequence: eventSequence,
					});
				}
				if (unlisten) void refresh();
			})
			.then((dispose) => {
				if (!active) {
					dispose();
					return;
				}
				unlisten = dispose;
				void refresh();
			})
			.catch(() => {
				if (active) publish(undefined);
			});
		return () => {
			active = false;
			unlisten?.();
			buffered.clear();
		};
	};
	return {
		getSnapshot: () => current,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			if (listeners.size === 1) stop = start();
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					stop?.();
					stop = undefined;
					current = undefined;
				}
			};
		},
	};
}
