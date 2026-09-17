import { isTerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";

export type TerminalPaneHostClassification = "owned" | "unresolved" | "other";

type TerminalPaneHostReference =
	| { readonly kind: "owned"; readonly hostId: string }
	| { readonly kind: "unresolved"; readonly hostIds: readonly string[] }
	| { readonly kind: "other" };

function hostIdHint(value: unknown): string | undefined {
	return typeof value === "string" && value !== "local" && value.length > 0
		? value
		: undefined;
}

function terminalPaneHostReference(
	params: Readonly<Record<string, unknown>>,
): TerminalPaneHostReference {
	if (params.binding !== undefined) {
		if (isTerminalPaneBindingV1(params.binding)) {
			return params.binding.source === "ssh"
				? { kind: "owned", hostId: params.binding.hostId }
				: { kind: "other" };
		}
		const binding =
			params.binding &&
			typeof params.binding === "object" &&
			!Array.isArray(params.binding)
				? (params.binding as Readonly<Record<string, unknown>>)
				: undefined;
		return {
			kind: "unresolved",
			hostIds: [hostIdHint(params.hostId), hostIdHint(binding?.hostId)].filter(
				(value): value is string => value !== undefined,
			),
		};
	}
	const hostId = hostIdHint(params.hostId);
	return hostId ? { kind: "owned", hostId } : { kind: "other" };
}

/** Resolve the Host that owns a terminal pane from its canonical binding, with
 * the top-level Host id retained only for pre-binding SSH layouts. */
export function terminalPaneHostId(
	params: Readonly<Record<string, unknown>>,
): string | undefined {
	const reference = terminalPaneHostReference(params);
	return reference.kind === "owned" ? reference.hostId : undefined;
}

/** Host ancestry referenced by a pane, including forward binding hints.
 * Hints may preserve an ancestor but never authorize destructive ownership. */
export function terminalPaneReferencedHostIds(
	params: Readonly<Record<string, unknown>>,
): readonly string[] {
	const reference = terminalPaneHostReference(params);
	if (reference.kind === "owned") return [reference.hostId];
	return reference.kind === "unresolved"
		? [...new Set(reference.hostIds)]
		: [];
}

/** Classify one target Host without turning forward binding evidence into ownership. */
export function classifyTerminalPaneHost(
	params: Readonly<Record<string, unknown>>,
	hostId: string,
): TerminalPaneHostClassification {
	const reference = terminalPaneHostReference(params);
	if (reference.kind === "owned") {
		return reference.hostId === hostId ? "owned" : "other";
	}
	return reference.kind === "unresolved" && reference.hostIds.includes(hostId)
		? "unresolved"
		: "other";
}
