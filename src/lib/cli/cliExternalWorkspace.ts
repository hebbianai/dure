import { resolveCliSpaceId } from "@/lib/cli/cliSpaceIdentity";
import type {
	ExternalWorkspaceOpenReceipt,
	ExternalWorkspaceOpenRequest,
} from "@/lib/workspace/externalWorkspace";

export interface CliExternalWorkspaceRequest {
	reqId: string;
	action: string;
	params: Record<string, unknown>;
}

export interface CliExternalWorkspaceDependencies {
	claim(reqId: string): Promise<boolean>;
	complete(
		reqId: string,
		result: Record<string, unknown>,
		action: string,
	): Promise<unknown>;
	open(
		request: ExternalWorkspaceOpenRequest,
	): Promise<ExternalWorkspaceOpenReceipt>;
}

function requiredIdentity(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) {
		const error = new Error(`${label} is required`) as Error & { code: string };
		error.code = "invalid_request";
		throw error;
	}
	return value.trim();
}

function optionalTarget(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return requiredIdentity(value, "targetId");
}

function errorPayload(error: unknown) {
	return {
		code:
			error &&
			typeof error === "object" &&
			"code" in error &&
			typeof error.code === "string"
				? error.code
				: "external_open_failed",
		message: error instanceof Error ? error.message : String(error),
	};
}

/** Dispatches the CLI through the same exact-pane action used by the header. */
export async function dispatchCliExternalWorkspaceRequest(
	request: CliExternalWorkspaceRequest,
	dependencies: CliExternalWorkspaceDependencies,
): Promise<boolean> {
	if (request.action !== "workspace.open-external") return false;
	if (!(await dependencies.claim(request.reqId))) return true;
	let result: Record<string, unknown>;
	try {
		const spaceId = resolveCliSpaceId(request.params, { required: true });
		const workspace = await dependencies.open({
			spaceId: spaceId as string,
			panelId: requiredIdentity(request.params.panelId, "panelId"),
			targetId: optionalTarget(request.params.targetId),
		});
		result = { ok: true, workspace };
	} catch (error) {
		result = { ok: false, error: errorPayload(error) };
	}
	await dependencies.complete(request.reqId, result, request.action);
	return true;
}
