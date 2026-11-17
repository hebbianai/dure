/** `pro` is the persisted identifier of the interface shown as Beta. */
export type InterfaceMode = "basic" | "pro";

export interface InterfaceModeEnvironment {
	readonly PROD: boolean;
	readonly VITE_DURE_INTERFACE_MODE_POLICY?: string;
}

export interface EffectiveInterfaceMode {
	readonly mode: InterfaceMode;
	readonly selectable: boolean;
}

/** Pin Terminal only when the user chose Terminal for new agents, in either
 * interface mode. Otherwise the wire preference is omitted, so the existing
 * backend capability authority selects Chat for supported launches and
 * Terminal for the others (no structured runtime for the provider or
 * platform, or a setup command). This never changes an existing pane. */
export function agentSpawnInteractionPreference(
	prefs?: { defaultAgentPane?: unknown },
): "native_cli" | undefined {
	return prefs?.defaultAgentPane === "terminal" ? "native_cli" : undefined;
}

/** Resolve persisted mode through the build policy, never reopening Beta in
 * a Basic-only build. Missing and unknown selections use Basic. */
export function resolveEffectiveInterfaceMode(
	storedMode: unknown,
	environment: InterfaceModeEnvironment = import.meta.env,
): EffectiveInterfaceMode {
	const configuredPolicy = environment.VITE_DURE_INTERFACE_MODE_POLICY;
	const selectable = configuredPolicy !== "basic-only";
	return {
		mode: selectable && storedMode === "pro" ? "pro" : "basic",
		selectable,
	};
}
