import { shellQuote } from "@/lib/platform/shell";
import {
	type GitCheckoutCaptureCommandV1,
	GitCheckoutCommandError,
	type GitCheckoutCommandErrorCode,
	type GitCheckoutCommandResult,
	type GitCheckoutInstanceV1,
	type GitCheckoutPathObservationV1,
	type GitCheckoutRemovalReceiptV1,
	type GitCheckoutRemoveCommandV1,
	isAbsolutePosixGitPathV1,
	parseGitCheckoutRemovalReceipt,
	parseRemoteGitCheckoutInstance,
	parseRemoteGitCheckoutLocations as parseRemoteGitCheckoutLocationValues,
} from "@/lib/scm/worktrees/gitCheckoutInstance";
import { isGitCheckoutUseErrorCodeV1 } from "@/lib/scm/worktrees/gitCheckoutProtocol";
import {
	type BoundedStdinCommandExecution,
	boundedStdinCommand,
} from "@/lib/ssh/sshCommandExecution";

const SCHEMA_VERSION = 1;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const CONTENT_DIGEST = /^[0-9a-f]{64}$/;
declare const REMOTE_GIT_CHECKOUT_HELPER_PATH: unique symbol;

export type RemoteGitCheckoutHelperPath = string & {
	readonly [REMOTE_GIT_CHECKOUT_HELPER_PATH]: true;
};

type HelperOperation = "capture-v1" | "locations-v1" | "remove-v1";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}

function validHelperPath(value: string): boolean {
	if (!isAbsolutePosixGitPathV1(value)) return false;
	const components = value.split("/");
	return (
		components.length > 2 &&
		components[components.length - 2] === "dure-git-checkout-helper" &&
		CONTENT_DIGEST.test(components[components.length - 1] ?? "")
	);
}

/** Parses the exact helper identity once at the native IPC boundary. */
export function parseRemoteGitCheckoutHelperPath(
	value: unknown,
): RemoteGitCheckoutHelperPath {
	if (typeof value === "string" && validHelperPath(value)) {
		return value as RemoteGitCheckoutHelperPath;
	}
	throw new GitCheckoutCommandError(
		"remote_git_checkout_capability_unavailable",
	);
}

function execution(
	helperPath: RemoteGitCheckoutHelperPath,
	operation: HelperOperation,
	payload: unknown,
): BoundedStdinCommandExecution {
	const stdin = JSON.stringify(payload);
	if (new TextEncoder().encode(stdin).byteLength > MAX_PAYLOAD_BYTES) {
		throw new GitCheckoutCommandError("worktree_request_invalid");
	}
	return boundedStdinCommand(`${shellQuote(helperPath)} ${operation}`, stdin);
}

export function remoteGitCheckoutCaptureExecution(
	helperPath: RemoteGitCheckoutHelperPath,
	command: GitCheckoutCaptureCommandV1,
): BoundedStdinCommandExecution {
	return execution(helperPath, "capture-v1", {
		repositoryPath: command.repo,
		checkoutPath: command.worktreePath,
	});
}

export function remoteGitCheckoutLocationsExecution(
	helperPath: RemoteGitCheckoutHelperPath,
	paths: readonly string[],
): BoundedStdinCommandExecution {
	return execution(helperPath, "locations-v1", {
		schemaVersion: SCHEMA_VERSION,
		paths,
	});
}

export function remoteGitCheckoutRemovalExecution(
	helperPath: RemoteGitCheckoutHelperPath,
	command: GitCheckoutRemoveCommandV1,
): BoundedStdinCommandExecution {
	return execution(helperPath, "remove-v1", {
		repositoryPath: command.repo,
		instance: command.instance,
		policy: command.policy,
	});
}

function response(result: GitCheckoutCommandResult): Record<string, unknown> {
	if (
		result.stdout.length === 0 ||
		new TextEncoder().encode(result.stdout).byteLength > MAX_RESPONSE_BYTES ||
		!result.stdout.endsWith("\n") ||
		result.stdout.slice(0, -1).includes("\n")
	) {
		throw new GitCheckoutCommandError(
			result.code === 0
				? "worktree_receipt_invalid"
				: "remote_git_checkout_capability_unavailable",
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new GitCheckoutCommandError(
			result.code === 0
				? "worktree_receipt_invalid"
				: "remote_git_checkout_capability_unavailable",
		);
	}
	const envelope = record(parsed);
	if (!envelope || envelope.schemaVersion !== SCHEMA_VERSION) {
		throw new GitCheckoutCommandError(
			result.code === 0
				? "worktree_receipt_invalid"
				: "remote_git_checkout_capability_unavailable",
		);
	}
	return envelope;
}

function successfulValue(result: GitCheckoutCommandResult): unknown {
	if (result.code !== 0) throw helperFailure(result);
	const envelope = response(result);
	if (!exactKeys(envelope, ["schemaVersion", "value"])) {
		throw new GitCheckoutCommandError("worktree_receipt_invalid");
	}
	return envelope.value;
}

function helperFailure(
	result: GitCheckoutCommandResult,
	fallback: GitCheckoutCommandErrorCode = "worktree_receipt_invalid",
): GitCheckoutCommandError {
	const envelope = response(result);
	if (!exactKeys(envelope, ["schemaVersion", "error"])) {
		return new GitCheckoutCommandError(
			"remote_git_checkout_capability_unavailable",
		);
	}
	const error = record(envelope.error);
	if (
		!error ||
		!exactKeys(error, ["code", "message"]) ||
		typeof error.code !== "string" ||
		typeof error.message !== "string" ||
		error.message.length > 4_096
	) {
		return new GitCheckoutCommandError(
			"remote_git_checkout_capability_unavailable",
		);
	}
	if (error.code === "checkout_use_instance_conflict") {
		return new GitCheckoutCommandError(
			"worktree_identity_changed",
			error.message,
		);
	}
	if (isGitCheckoutUseErrorCodeV1(error.code)) {
		return new GitCheckoutCommandError(error.code, error.message);
	}
	if (
		error.code === "worktree_request_invalid" ||
		error.code === "worktree_identity_changed"
	) {
		return new GitCheckoutCommandError(error.code, error.message);
	}
	return new GitCheckoutCommandError(
		fallback,
		`${error.code}: ${error.message}`,
	);
}

export function parseRemoteGitCheckoutCapture(
	result: GitCheckoutCommandResult,
): GitCheckoutInstanceV1 {
	if (result.code !== 0) throw helperFailure(result, "worktree_capture_failed");
	return parseRemoteGitCheckoutInstance(successfulValue(result));
}

export function parseRemoteGitCheckoutLocations(
	paths: readonly string[],
	result: GitCheckoutCommandResult,
): readonly (GitCheckoutPathObservationV1 | undefined)[] {
	if (result.code !== 0)
		throw helperFailure(result, "worktree_location_failed");
	return parseRemoteGitCheckoutLocationValues(successfulValue(result), paths);
}

export function parseRemoteGitCheckoutRemoval(
	command: GitCheckoutRemoveCommandV1,
	result: GitCheckoutCommandResult,
): GitCheckoutRemovalReceiptV1 {
	if (result.code !== 0) throw helperFailure(result, "worktree_remove_failed");
	return parseGitCheckoutRemovalReceipt(
		successfulValue(result),
		command.instance,
	);
}
