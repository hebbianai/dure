export type InterfaceMode = "basic" | "pro";

export interface InterfaceModeEnvironment {
	readonly PROD: boolean;
	readonly VITE_DURE_INTERFACE_MODE_POLICY?: string;
}

export interface EffectiveInterfaceMode {
	readonly mode: InterfaceMode;
	readonly selectable: boolean;
}

/** Resolves the persisted preference and build policy at their shared boundary.
 * Production defaults to Basic-only; development and tests remain selectable.
 * The build override can exercise Basic-only in development without adding a
 * release flag to any component; it cannot reopen Pro in production. Only an
 * explicit stored Pro selection enables Pro; missing or unknown values use the
 * app's Basic default. */
/** Every new agent is created as a PTY terminal pane, never structured chat —
 * in Basic (owner decision 2026-08-31) and now in Pro too (owner decision
 * 2026-09-01). The returned preference pins the backend's spawn surface
 * instead of letting the provider default decide it.
 *
 * Why it stopped depending on the mode: the provider default is a *capability*
 * probe, not a preference. Codex flipped from terminal to chat mid-day on
 * 2026-08-31 with no user action — the installed CLI was unchanged and only
 * the backend's version-contract table grew an entry, so the surface moved
 * under the user. Pinning the request makes the surface the app's decision and
 * keeps it stable across provider and CLI releases.
 *
 * Chat is not lost, only unmade-by-default: a created agent switches with the
 * pane's Terminal→Chat control (AgentRuntimeProfileSwitch).
 *
 * This is the single authority for that rule; spawn entry points wire it into
 * the run request rather than re-deciding. It takes no argument so that no
 * caller can reintroduce a per-mode split. */
export function agentSpawnInteractionPreference(): "native_cli" {
	return "native_cli";
}

export function resolveEffectiveInterfaceMode(
	storedMode: unknown,
	environment: InterfaceModeEnvironment = import.meta.env,
): EffectiveInterfaceMode {
	const configuredPolicy = environment.VITE_DURE_INTERFACE_MODE_POLICY;
	const selectable =
		!environment.PROD && configuredPolicy !== "basic-only";
	return {
		mode: selectable && storedMode === "pro" ? "pro" : "basic",
		selectable,
	};
}
