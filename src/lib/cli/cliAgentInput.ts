import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
	parseAgentChatDraftTarget,
	revalidateAgentChatDraftTarget,
} from "@/lib/agents/chat/agentChatDraftInput";
import { handleManagedHmuxInput } from "@/lib/cli/cliHmuxInput";
import { cliInputErrorPayload } from "@/lib/cli/cliInputError";
import { claimCliRequest } from "@/lib/cli/cliRequestBroker";
import type { CliRequest } from "@/lib/hmux/remote/remoteHmuxShellCliRequest";
import {
	executeManagedAgentInput,
	prepareManagedAgentInput,
} from "@/lib/sessions/managed/managedAgentInput";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import {
	type MountedPaneWindow,
	parseMountedPaneWindow,
	resolveMountedPaneWindow,
	revalidateMountedPaneWindow,
} from "@/lib/workspace/window/mountedPaneWindow";

export interface CliAgentInputRouting {
	currentWindowLabel(): string;
	resolve(
		target: string | { agentId: string },
		selectedWindowLabel?: string,
	): Promise<MountedPaneWindow>;
	revalidate(owner: MountedPaneWindow): void;
	forward(windowLabel: string, request: CliRequest): Promise<void>;
	claim(reqId: string): Promise<boolean>;
}

const routing: CliAgentInputRouting = {
	currentWindowLabel: () => getCurrentWebviewWindow().label,
	resolve: resolveMountedPaneWindow,
	revalidate: revalidateMountedPaneWindow,
	forward: (windowLabel, request) =>
		emitTo(
			{ kind: "WebviewWindow", label: windowLabel },
			"cli:request",
			request,
		),
	claim: claimCliRequest,
};

/** Native HTTP delivers to one window (main by default). Forward its original
 * request before claim; only the observed owner can append a chat draft. */
export async function handleCliAgentInput(
	params: Record<string, unknown>,
	reqId: string,
	transport: CliAgentInputRouting = routing,
) {
	const inputSessionId = String(params.sessionId ?? "").trim();
	const normalized = { ...params, name: inputSessionId || params.name };
	if (params.enter !== false) return handleManagedHmuxInput(normalized, reqId);
	let claimed = false;
	try {
		if (
			params.windowLabel !== undefined &&
			typeof params.windowLabel !== "string"
		)
			throw new PaneCommandError(
				"invalid_request",
				"windowLabel must be a string.",
			);
		const original =
			params.draftTarget === undefined
				? undefined
				: parseAgentChatDraftTarget(params.draftTarget);
		if (params.draftTarget !== undefined && !original)
			throw new PaneCommandError(
				"invalid_request",
				"The forwarded draft recipient is invalid.",
			);
		// A forwarded draft cannot become terminal input if the profile changed.
		if (original) revalidateAgentChatDraftTarget(original);
		const prepared = prepareManagedAgentInput(normalized);
		if (prepared.kind !== "structured_draft")
			return handleManagedHmuxInput(normalized, reqId);
		if (original) {
			if (original.identity.agentId !== prepared.target.identity.agentId)
				throw new PaneCommandError(
					"invalid_request",
					"The forwarded draft recipient is invalid.",
				);
			prepared.target = original;
		}
		const owner =
			params.paneOwner === undefined
				? await transport.resolve(
						prepared.targetPanelId ?? {
							agentId: prepared.target.identity.agentId,
						},
						typeof params.windowLabel === "string"
							? params.windowLabel
							: undefined,
					)
				: parseMountedPaneWindow(params.paneOwner);
		if (
			!owner ||
			(prepared.targetPanelId !== undefined &&
				owner.paneId !== prepared.targetPanelId)
		)
			throw new PaneCommandError(
				"invalid_request",
				"The draft pane owner is invalid.",
			);
		if (owner.windowLabel !== transport.currentWindowLabel()) {
			if (params.paneOwner !== undefined)
				throw new PaneCommandError(
					"pane_changed",
					"The draft was delivered to a different window.",
				);
			revalidateAgentChatDraftTarget(prepared.target);
			await transport.forward(owner.windowLabel, {
				reqId,
				action: "agent.input",
				params: {
					...normalized,
					name: prepared.target.identity.agentId,
					sessionId: prepared.target.sessionId,
					targetPanelId: owner.paneId,
					draftTarget: prepared.target,
					paneOwner: owner,
					windowLabel: owner.windowLabel,
				},
			});
			return null;
		}
		transport.revalidate(owner);
		claimed = await transport.claim(reqId);
		if (!claimed) return null;
		transport.revalidate(owner);
		return {
			ok: true,
			input: await executeManagedAgentInput(prepared, {
				desktopId: owner.desktopId,
				panelId: owner.paneId,
			}),
		};
	} catch (error) {
		if (!claimed && !(await transport.claim(reqId))) return null;
		return { ok: false, error: cliInputErrorPayload(error) };
	}
}
