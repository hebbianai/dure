import {
	GIT_CHECKOUT_INSTANCE_SCHEMA_VERSION_V1,
	type GitCheckoutInstanceV1,
	type GitCheckoutLocationV1,
	type GitCheckoutPathAbsentV1,
	type GitCheckoutPathObservationV1,
	type GitCheckoutRemovalPolicyV1,
	type GitCheckoutRemovalReceiptV1,
	type GitCheckoutUseErrorCodeV1,
} from "@/lib/scm/worktrees/gitCheckoutProtocol";
import {
	isAbsoluteNativeGitPathV1 as absoluteNativePath,
	isAbsolutePosixGitPathV1,
	isGitCheckoutInstanceV1,
	sameGitCheckoutInstanceV1,
} from "../../../../cli/lib/contracts/git-checkout-identity.mjs";

export type {
	GitCheckoutInstanceV1,
	GitCheckoutLocationV1,
	GitCheckoutPathAbsentV1,
	GitCheckoutPathObservationV1,
	GitCheckoutRemovalPolicyV1,
	GitCheckoutRemovalReceiptV1,
} from "@/lib/scm/worktrees/gitCheckoutProtocol";
export {
	isAbsolutePosixGitPathV1,
	isGitCheckoutInstanceV1,
	sameGitCheckoutInstanceV1,
} from "../../../../cli/lib/contracts/git-checkout-identity.mjs";

const INSTANCE_SCHEMA_VERSION = GIT_CHECKOUT_INSTANCE_SCHEMA_VERSION_V1;
const MAX_LOCATION_PATHS = 256;

export interface GitCheckoutCaptureCommandV1 {
	readonly schemaVersion: typeof INSTANCE_SCHEMA_VERSION;
	readonly operation: "capture";
	readonly repo: string;
	readonly worktreePath: string;
}

export interface GitCheckoutRemoveCommandV1 {
	readonly schemaVersion: typeof INSTANCE_SCHEMA_VERSION;
	readonly operation: "remove";
	readonly repo: string;
	readonly instance: GitCheckoutInstanceV1;
	readonly policy: GitCheckoutRemovalPolicyV1;
}

export interface GitCheckoutCommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type GitCheckoutCommandErrorCode =
	| "worktree_request_invalid"
	| "worktree_capture_failed"
	| "worktree_identity_changed"
	| "worktree_remove_failed"
	| "worktree_location_failed"
	| "worktree_receipt_invalid"
	| "remote_git_checkout_capability_unavailable"
	| GitCheckoutUseErrorCodeV1;

export class GitCheckoutCommandError extends Error {
	constructor(
		readonly code: GitCheckoutCommandErrorCode,
		message: string = code,
	) {
		super(
			message === code || message.startsWith(`${code}:`)
				? message
				: `${code}: ${message}`,
		);
		this.name = "GitCheckoutCommandError";
	}
}

function validLocation(
	value: unknown,
	path: (candidate: unknown) => candidate is string = absoluteNativePath,
): value is GitCheckoutLocationV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		Object.keys(candidate).length === 3 &&
		candidate.schemaVersion === INSTANCE_SCHEMA_VERSION &&
		path(candidate.canonicalPath) &&
		path(candidate.gitCommonDir)
	);
}

function validLocationRequest(
	paths: readonly string[],
	posixOnly: boolean,
): boolean {
	return (
		paths.length > 0 &&
		paths.length <= MAX_LOCATION_PATHS &&
		paths.every((path) =>
			posixOnly ? isAbsolutePosixGitPathV1(path) : absoluteNativePath(path),
		)
	);
}

function validAbsentPath(
	value: unknown,
	requestedPath: string,
): value is GitCheckoutPathAbsentV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		Object.keys(candidate).length === 2 &&
		candidate.schemaVersion === INSTANCE_SCHEMA_VERSION &&
		candidate.absentPath === requestedPath
	);
}

/** Parses one bounded local Host location batch at the IPC boundary. */
export function parseLocalGitCheckoutLocations(
	value: unknown,
	paths: readonly string[],
): readonly (GitCheckoutPathObservationV1 | undefined)[] {
	if (
		!validLocationRequest(paths, false) ||
		!Array.isArray(value) ||
		value.length !== paths.length ||
		value.some((entry, index) =>
			entry !== null && !validLocation(entry) && !validAbsentPath(entry, paths[index]),
		)
	) {
		throw new GitCheckoutCommandError("worktree_receipt_invalid");
	}
	return value.map((entry) => (entry === null ? undefined : entry));
}

/** Parses the backend-owned local checkout identity once at the IPC boundary. */
export function parseLocalGitCheckoutInstance(
	value: unknown,
): GitCheckoutInstanceV1 {
	if (isGitCheckoutInstanceV1(value)) return value;
	throw new GitCheckoutCommandError("worktree_receipt_invalid");
}

/** Parses one helper-issued POSIX checkout identity at the SSH boundary. */
export function parseRemoteGitCheckoutInstance(
	value: unknown,
): GitCheckoutInstanceV1 {
	if (isGitCheckoutInstanceV1(value, true)) return value;
	throw new GitCheckoutCommandError("worktree_receipt_invalid");
}

/** Parses one helper-issued POSIX location batch at the SSH boundary. */
export function parseRemoteGitCheckoutLocations(
	value: unknown,
	paths: readonly string[],
): readonly (GitCheckoutPathObservationV1 | undefined)[] {
	if (
		!validLocationRequest(paths, true) ||
		!Array.isArray(value) ||
		value.length !== paths.length ||
		value.some(
			(entry, index) =>
				entry !== null &&
				!validLocation(entry, isAbsolutePosixGitPathV1) &&
				!validAbsentPath(entry, paths[index]),
		)
	) {
		throw new GitCheckoutCommandError("worktree_receipt_invalid");
	}
	return value.map((entry) => (entry === null ? undefined : entry));
}

/** Parses one local or remote removal receipt against its frozen instance. */
export function parseGitCheckoutRemovalReceipt(
	value: unknown,
	expected: GitCheckoutInstanceV1,
): GitCheckoutRemovalReceiptV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new GitCheckoutCommandError("worktree_receipt_invalid");
	}
	const receipt = value as Record<string, unknown>;
	if (
		Object.keys(receipt).length !== 3 ||
		receipt.schemaVersion !== INSTANCE_SCHEMA_VERSION ||
		(receipt.outcome !== "removed" && receipt.outcome !== "already_absent") ||
		!isGitCheckoutInstanceV1(expected) ||
		!isGitCheckoutInstanceV1(receipt.instance) ||
		!sameGitCheckoutInstanceV1(receipt.instance, expected)
	) {
		throw new GitCheckoutCommandError("worktree_receipt_invalid");
	}
	return {
		schemaVersion: INSTANCE_SCHEMA_VERSION,
		outcome: receipt.outcome,
		instance: receipt.instance,
	};
}
