import type { AgentRunReceiptWorktree } from "@/lib/agents/agentRunWorkspacePresentation";
import { isRecord } from "@/lib/payloadGuards";
import { worktreeDirName } from "@/lib/scm/worktrees/worktreePlan";
import { containsCliControlCharacter } from "./cliTextBoundary";

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function absolutePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.startsWith("/") &&
		value.length <= 4096 &&
		!containsCliControlCharacter(value)
	);
}

function boundedName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		new TextEncoder().encode(value).length <= 256 &&
		!containsCliControlCharacter(value)
	);
}

/** Both runtime presentations consume the same backend-owned workspace receipt. */
export function parseRunPresentationWorktree(
	value: unknown,
): AgentRunReceiptWorktree | null {
	if (!isRecord(value)) return null;
	if (value.kind === "project_root" && onlyKeys(value, ["kind"])) {
		return { kind: "project_root" };
	}
	if (value.kind === "existing_checkout") {
		return onlyKeys(value, ["kind", "branch", "rootPath"]) &&
			typeof value.branch === "string" &&
			value.branch.length > 0 &&
			absolutePath(value.rootPath)
			? {
					kind: "existing_checkout",
					branch: value.branch,
					rootPath: value.rootPath,
				}
			: null;
	}
	if (value.kind === "existing_workspace") {
		if (
			!onlyKeys(value, ["kind", "sourceAgentId", "rootPath"]) ||
			typeof value.sourceAgentId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,511}$/.test(value.sourceAgentId) ||
			!absolutePath(value.rootPath)
		)
			return null;
		return {
			kind: "existing_workspace",
			sourceAgentId: value.sourceAgentId,
			rootPath: value.rootPath,
		};
	}
	const { branch, directoryName, rootPath } = value;
	if (
		value.kind !== "dedicated" ||
		!onlyKeys(value, ["kind", "branch", "directoryName", "rootPath"]) ||
		!boundedName(branch) ||
		!boundedName(directoryName) ||
		directoryName === "." ||
		directoryName === ".." ||
		directoryName.includes("/") ||
		directoryName.includes("\\") ||
		directoryName !== worktreeDirName(branch) ||
		(rootPath !== undefined && !absolutePath(rootPath))
	)
		return null;
	return {
		kind: "dedicated",
		branch,
		directoryName,
		...(rootPath === undefined ? {} : { rootPath }),
	};
}
