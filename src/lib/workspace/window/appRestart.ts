import {
	getAllWebviewWindows,
	getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { emitWhenReady, listenWhenReady } from "@/lib/platform/tauriBridge";
import { checkpointWindowWork } from "@/lib/persistence/windowWorkCheckpoint";
import { createValueStore } from "@/lib/state/broadcast";
import {
	createRestartParticipant,
	runPreparedRestart,
	type RestartRequest,
	type RestartResponse,
} from "@/lib/workspace/window/appRestartProtocol";

const REQUEST = "dure://app-restart/prepare";
const RESPONSE = "dure://app-restart/prepared";
const preparation = createValueStore(false);
export const restartPreparationSnapshot = preparation.get;
export const subscribeRestartPreparation = preparation.subscribe;

function requestFrom(value: unknown): RestartRequest | undefined {
	if (!value || typeof value !== "object") return;
	const valueRecord = value as Partial<RestartRequest>;
	if (
		typeof valueRecord.id !== "string" ||
		!/^[\da-f-]{36}$/.test(valueRecord.id) ||
		typeof valueRecord.owner !== "string" ||
		!valueRecord.owner ||
		valueRecord.owner.length > 128
	)
		return;
	if (
		valueRecord.phase !== "prepare" &&
		valueRecord.phase !== "verify" &&
		valueRecord.phase !== "release"
	)
		return;
	return {
		id: valueRecord.id,
		owner: valueRecord.owner,
		phase: valueRecord.phase,
	};
}

/** Install once for every WebView, including detached source-control windows. */
export async function installAppRestartParticipant(): Promise<() => void> {
	const participant = createRestartParticipant({
		window: getCurrentWebviewWindow().label,
		realm: crypto.randomUUID(),
		checkpoint: checkpointWindowWork,
		settle: async () => {
			const { settleDurableAppState } = await import(
				"@/lib/persistence/durableAppStateSettlement"
			);
			return settleDurableAppState();
		},
		respond: (payload) => emitWhenReady(RESPONSE, payload),
		holdInput: (cancel) => {
			preparation.set(true);
			const root = document.getElementById("root");
			const wasInert = root?.inert ?? false;
			if (root) root.inert = true;
			const types = [
				"keydown",
				"keyup",
				"beforeinput",
				"pointerdown",
				"click",
				"drop",
			] as const;
			const block = (event: Event) => {
				event.preventDefault();
				event.stopImmediatePropagation();
				if (
					event instanceof KeyboardEvent &&
					event.type === "keydown" &&
					event.key === "Escape"
				)
					cancel();
			};
			for (const type of types) window.addEventListener(type, block, true);
			return () => {
				if (root) root.inert = wasInert;
				for (const type of types) window.removeEventListener(type, block, true);
				preparation.set(false);
			};
		},
	});
	const stop = await listenWhenReady<unknown>(REQUEST, ({ payload }) => {
		const request = requestFrom(payload);
		if (request)
			void participant
				.handle(request)
				.catch((error) =>
					console.error("[app-restart] preparation response failed", error),
				);
	});
	return () => {
		stop();
		participant.dispose();
	};
}

/** The origin-wide lock prevents two windows from installing competing updates. */
export async function withPreparedAppRestart(
	commit: (verify: () => Promise<void>) => Promise<void>,
): Promise<void> {
	if (!navigator.locks) throw new Error("app_restart_lock_unavailable");
	await navigator.locks.request(
		"dure:app-update-restart",
		{ ifAvailable: true },
		async (lock) => {
			if (!lock) throw new Error("app_restart_already_preparing");
			await runPreparedRestart(
				{
					owner: getCurrentWebviewWindow().label,
					windows: async () =>
						(await getAllWebviewWindows()).map((window) => window.label),
					send: (payload) => emitWhenReady(REQUEST, payload),
					listen: (listener) =>
						listenWhenReady<unknown>(RESPONSE, ({ payload }) => {
							const request = requestFrom(payload);
							const response = payload as Partial<RestartResponse> | null;
							if (
								!request ||
								!response ||
								typeof response.window !== "string" ||
								typeof response.realm !== "string" ||
								(response.error !== undefined &&
									typeof response.error !== "string")
							)
								return;
							const drafts = response.drafts;
							if (
								!Array.isArray(drafts) ||
								!drafts.every(
									(entry) =>
										Array.isArray(entry) &&
										entry.length === 2 &&
										entry.every(
											(value: unknown) =>
												typeof value === "string" &&
												/^[a-f0-9]{64}$/.test(value),
										),
								)
							)
								return;
							listener({
								...request,
								window: response.window,
								realm: response.realm,
								drafts,
								...(response.error ? { error: response.error } : {}),
							});
						}),
				},
				commit,
			);
		},
	);
}
