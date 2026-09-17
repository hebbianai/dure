// invoke() wrappers for anonymous usage telemetry (#961). This directory is
// the only place invoke() may be called (architecture fitness gate), and it
// is the whole frontend surface: the native side owns consent, the install
// id, the event type and the transport, so nothing here caches a decision.
import { invoke } from "@tauri-apps/api/core";

/** Mirrors src-tauri/src/telemetry/consent.rs's `Choice`. */
export type TelemetryChoice = "accepted" | "declined";

/** Mirrors `DisabledReason` there: why nothing is sent right now. */
export type TelemetryDisabledReason =
	| "no_key"
	| "do_not_track"
	| "env_disabled"
	| "ci"
	| "declined";

/** Mirrors `TelemetryStateDto` in src-tauri/src/telemetry/mod.rs. */
export interface TelemetryState {
	effective: "enabled" | "pending" | "disabled";
	/** Present exactly when `effective` is "disabled". */
	reason?: TelemetryDisabledReason;
	/** The person's recorded answer, whatever the environment then decides. */
	choice: TelemetryChoice | null;
}

/** Mirrors `TelemetryEvent` in src-tauri/src/telemetry/event.rs. Every
 *  value is an enumeration or a short lowercase identifier; the native type
 *  rejects anything else, and the lifecycle events (`app_opened`,
 *  `telemetry_accepted`, `telemetry_opted_out`) are native-only. */
interface TelemetryEvents {
	space_created: undefined;
	project_added: { kind: "local" | "ssh" };
	agent_pane_opened: { provider: string };
	message_sent: { provider: string };
	pane_split: { direction: "right" | "below" };
	pane_hidden: undefined;
	pane_restored: undefined;
	quick_dispatch_used: undefined;
	github_panel_opened: undefined;
	git_panel_opened: undefined;
	ssh_session_opened: undefined;
}

export type TelemetryEventName = keyof TelemetryEvents;

type EventArguments<E extends TelemetryEventName> =
	TelemetryEvents[E] extends undefined ? [] : [TelemetryEvents[E]];

export function telemetryState(): Promise<TelemetryState> {
	return invoke<TelemetryState>("telemetry_state");
}

export function telemetrySetChoice(
	choice: TelemetryChoice,
): Promise<TelemetryState> {
	return invoke<TelemetryState>("telemetry_set_choice", { choice });
}

/** Offer one event. Fire-and-forget: the native consent check and event
 *  type decide whether it leaves the machine, and a rejection (an unknown
 *  event, a build without telemetry, no Tauri webview) never surfaces. */
export function track<E extends TelemetryEventName>(
	event: E,
	...properties: EventArguments<E>
): void {
	const payload =
		properties[0] === undefined
			? { event }
			: { event, properties: properties[0] };
	void invoke<void>("telemetry_track", { event: payload }).catch(
		() => undefined,
	);
}
