import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { claimCliRequest, completeCliRequest } from "@/lib/cli/cliRequestBroker";
import { listProviderConversations } from "@/lib/agents/providerConversationDiscovery";
import {
	applyWorkspaceImportPlan,
	createWorkspaceImportPreview,
	workspaceImportStatus,
} from "@/lib/workspace/workspaceImportControl";

const WORKSPACE_IMPORT_ACTIONS = new Set([
	"sessions.recent",
	"workspace.import.preview",
	"workspace.import.status",
	"workspace.import.apply",
]);

function isWorkspaceImportCliAction(action: string): boolean {
	return WORKSPACE_IMPORT_ACTIONS.has(action);
}

async function handleWorkspaceImportCliRequest(
	action: string,
	params: Record<string, unknown>,
	reqId: string,
) {
	if (
		action.startsWith("workspace.import.") &&
		getCurrentWebviewWindow().label !== "main"
	) {
		return null;
	}
	if (!(await claimCliRequest(reqId))) return null;
	try {
		if (action === "sessions.recent") {
			return {
				ok: true,
				schemaVersion: 1,
				sessions: await listProviderConversations(),
			};
		}
		if (action === "workspace.import.preview") {
			return { ok: true, preview: await createWorkspaceImportPreview() };
		}
		if (action === "workspace.import.status") {
			return { ok: true, status: workspaceImportStatus() };
		}
		if (action === "workspace.import.apply") {
			const token = typeof params.planToken === "string" ? params.planToken : "";
			return { ok: true, receipt: await applyWorkspaceImportPlan(token) };
		}
		throw new Error(`unsupported workspace import action: ${action}`);
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "workspace_import_failed",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

export async function dispatchWorkspaceImportCliRequest(
	action: string,
	params: Record<string, unknown>,
	reqId: string,
): Promise<boolean> {
	if (!isWorkspaceImportCliAction(action)) return false;
	const result = await handleWorkspaceImportCliRequest(action, params, reqId);
	if (result) await completeCliRequest(reqId, result, action);
	return true;
}
