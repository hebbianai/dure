export type InterfaceMode = "basic" | "pro";

export interface InterfaceModeEnvironment {
	readonly PROD: boolean;
	readonly VITE_DURE_INTERFACE_MODE_POLICY?: string;
}

export interface EffectiveInterfaceMode {
	readonly mode: InterfaceMode;
	readonly selectable: boolean;
}

/** Pin Terminal unless the user explicitly chooses Chat in effective Pro.
 * An omitted wire preference lets the existing backend capability authority
 * select Chat for supported launches and Terminal for the others. This never
 * changes an existing pane or weakens the Basic-only production policy. */
export function agentSpawnInteractionPreference(
	prefs?: { interfaceMode?: unknown; defaultAgentPane?: unknown },
	environment: InterfaceModeEnvironment = import.meta.env,
): "native_cli" | undefined {
	return resolveEffectiveInterfaceMode(prefs?.interfaceMode, environment).mode === "pro" &&
		prefs?.defaultAgentPane === "chat"
		? undefined
		: "native_cli";
}

/** Resolve persisted mode through the build policy, never reopening Pro in
 * Basic-only production. Missing and unknown selections use Basic. */
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
