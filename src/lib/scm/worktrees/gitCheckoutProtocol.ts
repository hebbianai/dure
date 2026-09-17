import type {
	GIT_CHECKOUT_INSTANCE_SCHEMA_VERSION_V1,
	GitCheckoutInstanceV1,
} from "../../../../cli/lib/contracts/git-checkout-identity.mjs";

export {
	GIT_CHECKOUT_INSTANCE_SCHEMA_VERSION_V1,
	type GitCheckoutInstanceV1,
} from "../../../../cli/lib/contracts/git-checkout-identity.mjs";

/** Error tokens projected from the canonical Rust checkout-use authority. */
const GIT_CHECKOUT_USE_ERROR_CODES_V1 = [
	"checkout_use_request_invalid",
	"checkout_use_state_invalid",
	"checkout_use_revision_exhausted",
	"checkout_use_git_failed",
	"checkout_use_record_too_large",
	"checkout_use_capacity_exceeded",
	"checkout_use_operation_conflict",
	"checkout_use_phase_conflict",
	"checkout_use_instance_conflict",
	"checkout_use_claim_missing",
	"checkout_use_in_use",
	"checkout_use_creation_reconcile_required",
	"checkout_use_removal_reconcile_required",
	"checkout_use_cas_exhausted",
] as const;

export type GitCheckoutUseErrorCodeV1 =
	(typeof GIT_CHECKOUT_USE_ERROR_CODES_V1)[number];

const CHECKOUT_USE_ERRORS = new Set<string>(GIT_CHECKOUT_USE_ERROR_CODES_V1);

export function isGitCheckoutUseErrorCodeV1(
	value: unknown,
): value is GitCheckoutUseErrorCodeV1 {
	return typeof value === "string" && CHECKOUT_USE_ERRORS.has(value);
}

export interface GitCheckoutLocationV1 {
	readonly schemaVersion: typeof GIT_CHECKOUT_INSTANCE_SCHEMA_VERSION_V1;
	readonly canonicalPath: string;
	readonly gitCommonDir: string;
}

/** Host-observed absence, correlated to the exact requested path. */
export interface GitCheckoutPathAbsentV1 {
	readonly schemaVersion: typeof GIT_CHECKOUT_INSTANCE_SCHEMA_VERSION_V1;
	readonly absentPath: string;
}

export type GitCheckoutPathObservationV1 =
	| GitCheckoutLocationV1
	| GitCheckoutPathAbsentV1;

export interface GitCheckoutRemovalReceiptV1 {
	readonly schemaVersion: typeof GIT_CHECKOUT_INSTANCE_SCHEMA_VERSION_V1;
	readonly outcome: "removed" | "already_absent";
	readonly instance: GitCheckoutInstanceV1;
}

export type GitCheckoutRemovalPolicyV1 = "require_clean" | "discard_changes";
