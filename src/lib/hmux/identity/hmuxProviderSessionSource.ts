import {
	type HmuxLocalPaneBindingV1,
	type HmuxManagedPaneBindingV1,
	type HmuxStandalonePaneBindingV1,
	isTerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";

export const HMUX_LOCAL_SHELL_WORKSPACE_ID = "dure-local-shells-v1";

export interface HmuxProviderSessionSourceIdentity {
	readonly kind?: string;
	readonly runtime?: string;
	readonly source?: string;
	readonly workspaceId?: string;
}

type HmuxManagedLocalShellBinding = HmuxManagedPaneBindingV1 & {
	readonly workspaceId: typeof HMUX_LOCAL_SHELL_WORKSPACE_ID;
};

type HmuxObservedLocalShellBinding = HmuxLocalPaneBindingV1 & {
	readonly workspaceId: typeof HMUX_LOCAL_SHELL_WORKSPACE_ID;
};

export type HmuxProviderSessionSourceBinding =
	| HmuxStandalonePaneBindingV1
	| HmuxManagedLocalShellBinding;

export type HmuxLocalShellBinding =
	| HmuxObservedLocalShellBinding
	| HmuxManagedLocalShellBinding;

/** A provider may be adopted from a standalone session or a terminal consumer
 * backed by the canonical managed shell. The managed consumer kind is required
 * because a promoted Agent keeps the source workspace identity. */
export function isHmuxProviderSessionSourceIdentity(
	identity: HmuxProviderSessionSourceIdentity,
): boolean {
	return (
		identity.source === "local" &&
		(identity.runtime === "hmux_standalone_v1" ||
			(identity.kind === "term" &&
				identity.runtime === "hmux_managed_v1" &&
				identity.workspaceId === HMUX_LOCAL_SHELL_WORKSPACE_ID))
	);
}

export function isHmuxProviderSessionSourceBinding(
	value: unknown,
	component: string | undefined,
): value is HmuxProviderSessionSourceBinding {
	return (
		isTerminalPaneBindingV1(value) &&
		isHmuxProviderSessionSourceIdentity({
			...value,
			kind: component === "terminal" ? "term" : "other",
		})
	);
}

export function isHmuxLocalShellBinding(
	value: unknown,
	component: string | undefined,
): value is HmuxLocalShellBinding {
	return (
		component === "terminal" &&
		isTerminalPaneBindingV1(value) &&
		value.source === "local" &&
		value.workspaceId === HMUX_LOCAL_SHELL_WORKSPACE_ID &&
		(value.runtime === "hmux_session_v1" || value.runtime === "hmux_managed_v1")
	);
}
