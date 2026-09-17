import { invoke } from "@tauri-apps/api/core";

export type ExternalOpenTargetGroup = "finder" | "editor" | "terminal";
export type ExternalOpenTargetCapability = "directory" | "project";

export interface ExternalOpenTarget {
	id: string;
	label: string;
	group: ExternalOpenTargetGroup;
	capability: ExternalOpenTargetCapability;
	platforms: readonly ["macos"];
}

export interface NativeExternalWorkspaceOpenReceipt {
	schemaVersion: 1;
	targetId: string;
	canonicalPath: string;
	attemptedCandidates: number;
}

class ExternalWorkspaceIpcError extends Error {
	readonly code = "external_response_invalid";

	constructor(message: string) {
		super(message);
		this.name = "ExternalWorkspaceIpcError";
	}
}

let catalogRequest: Promise<readonly ExternalOpenTarget[]> | undefined;

function isExternalOpenTarget(value: unknown): value is ExternalOpenTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const target = value as Record<string, unknown>;
	return (
		typeof target.id === "string" &&
		/^[a-z][a-z0-9-]{0,63}$/.test(target.id) &&
		typeof target.label === "string" &&
		target.label.length > 0 &&
		(target.group === "finder" ||
			target.group === "editor" ||
			target.group === "terminal") &&
		(target.capability === "directory" || target.capability === "project") &&
		Array.isArray(target.platforms) &&
		target.platforms.length === 1 &&
		target.platforms[0] === "macos"
	);
}

/** Loads the native catalog once and validates it at the IPC boundary. */
export function externalWorkspaceTargets(
	refresh = false,
): Promise<readonly ExternalOpenTarget[]> {
	if (refresh || !catalogRequest) {
		catalogRequest = Promise.resolve()
			.then(() => invoke<unknown>("external_workspace_targets"))
			.then((targets) => {
				if (!Array.isArray(targets) || !targets.every(isExternalOpenTarget)) {
					throw new Error("external workspace target catalog is invalid");
				}
				return Object.freeze(targets.map((target) => Object.freeze(target)));
			})
			.catch((error) => {
				catalogRequest = undefined;
				throw error;
			});
	}
	return catalogRequest;
}

function externalWorkspaceOpenReceipt(
	value: unknown,
	targetId: string,
): NativeExternalWorkspaceOpenReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ExternalWorkspaceIpcError(
			"external workspace launch receipt is invalid",
		);
	}
	const receipt = value as Record<string, unknown>;
	if (
		receipt.schemaVersion !== 1 ||
		receipt.targetId !== targetId ||
		typeof receipt.canonicalPath !== "string" ||
		!receipt.canonicalPath.startsWith("/") ||
		typeof receipt.attemptedCandidates !== "number" ||
		!Number.isSafeInteger(receipt.attemptedCandidates) ||
		receipt.attemptedCandidates < 1
	) {
		throw new ExternalWorkspaceIpcError(
			"external workspace launch receipt is invalid",
		);
	}
	return {
		schemaVersion: 1,
		targetId,
		canonicalPath: receipt.canonicalPath,
		attemptedCandidates: receipt.attemptedCandidates,
	};
}

export const openExternalWorkspaceNative = async (
	path: string,
	targetId: string,
) => {
	const receipt = await invoke<unknown>("open_external_workspace", {
		path,
		targetId,
	});
	return externalWorkspaceOpenReceipt(receipt, targetId);
};
