import { isHmuxProviderSessionSourceBinding } from "@/lib/hmux/identity/hmuxProviderSessionSource";
import { agentIdFromPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import { paneContentComponent } from "@/lib/workspace/layout/persistedPaneLayout";
import { isTerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import type { Provider } from "@/types";
import {
	type HmuxManagedAgentPromotion,
	projectHmuxManagedAgentPaneLayout,
} from "./hmuxAgentPanePromotion";
import {
	type ConvertibleHmuxBinding,
	sameHmuxConversionBinding,
} from "./hmuxSessionConversionIdentity";

export interface HmuxSessionConversionSyncPayload {
	schemaVersion: 1;
	desktopId: string;
	panelId: string;
	agentId?: string;
	promotion?: HmuxManagedAgentPromotion;
	providerId: Provider;
	cwd: string;
	conversationId: string;
	sourceBinding: ConvertibleHmuxBinding;
	binding: ConvertibleHmuxBinding;
}

export type HmuxConversionConsumerState =
	| "source"
	| "target"
	| "missing"
	| "conflict";

export function classifyHmuxConversionBinding(
	value: unknown,
	source: ConvertibleHmuxBinding,
	target: ConvertibleHmuxBinding,
): HmuxConversionConsumerState {
	if (!isTerminalPaneBindingV1(value)) return "missing";
	const binding = convertibleBinding(value);
	if (!binding) return "conflict";
	if (sameHmuxConversionBinding(binding, source)) return "source";
	if (sameHmuxConversionBinding(binding, target)) return "target";
	return "conflict";
}

export function projectHmuxConversionLayout(
	layout: unknown,
	payload: HmuxSessionConversionSyncPayload,
): { state: HmuxConversionConsumerState; layout: unknown } {
	if (payload.promotion) {
		if (
			!isHmuxProviderSessionSourceBinding(payload.sourceBinding, "terminal") ||
			payload.binding.runtime !== "hmux_managed_v1"
		) {
			return { state: "conflict", layout };
		}
		return projectHmuxManagedAgentPaneLayout(
			layout,
			payload.promotion,
			payload.sourceBinding,
			payload.binding,
		);
	}
	let next: Record<string, unknown>;
	try {
		next = JSON.parse(JSON.stringify(layout)) as Record<string, unknown>;
	} catch {
		return { state: "conflict", layout };
	}
	const panels =
		next.panels && typeof next.panels === "object"
			? (next.panels as Record<string, unknown>)
			: undefined;
	const panel =
		panels?.[payload.panelId] && typeof panels[payload.panelId] === "object"
			? (panels[payload.panelId] as Record<string, unknown>)
			: undefined;
	if (!panel) return { state: "missing", layout: next };
	const params =
		panel.params && typeof panel.params === "object"
			? (panel.params as Record<string, unknown>)
			: {};
	const component = paneContentComponent(panel);
	if (component === "agent") {
		const agentId = agentIdFromPaneParameters(params);
		if (
			!agentId ||
			(payload.agentId !== undefined && payload.agentId !== agentId)
		) {
			return { state: "conflict", layout: next };
		}
		panel.params = { agentRef: { agentId } };
		return { state: "target", layout: next };
	}
	if (component !== "terminal") return { state: "conflict", layout: next };
	const state = classifyHmuxConversionBinding(
		params.binding,
		payload.sourceBinding,
		payload.binding,
	);
	if (state === "source") {
		panel.params = {
			...params,
			sessionId: payload.binding.sessionId,
			binding: payload.binding,
		};
	}
	return { state, layout: next };
}

export function convertibleBinding(
	value: unknown,
): ConvertibleHmuxBinding | undefined {
	if (!isTerminalPaneBindingV1(value)) return undefined;
	return value.source === "local" &&
		(value.runtime === "hmux_managed_v1" ||
			value.runtime === "hmux_standalone_v1")
		? value
		: undefined;
}
