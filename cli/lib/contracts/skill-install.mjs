// Pure derivation of a shipped skill's install state from three sha256
// digests: what's on disk, what a receipt recorded at install time, and what
// the CLI currently bundles. No filesystem, process, or Date reads here — the
// I/O half (Task 2) computes the three digests and this module only compares
// them, which keeps every branch of the five-state table testable without a
// tmp dir.
//
// `null` is this contract's spelling of "absent": a missing file has no
// digest to compare, and neither does a skill installed before receipts
// existed. The falsy checks below (`!diskDigest`, `!receiptDigest`) do not
// actually distinguish `null` from `""` — an empty string would take the
// same branch as absent. That is a deliberate conflation, not a guarantee
// this module enforces: nothing here validates that a caller never passes
// `""`. The contract is on the caller (Task 2's digest and receipt readers)
// to always pass `null` for "absent" and never `""`. See
// scripts/skill-install-state.test.mjs's `""` row for the behavior this
// conflation produces today.
export const SKILL_RECEIPT_SCHEMA = 1;

/**
 * Five states, in the order the settings page should trust them:
 *
 * - "missing"   — no file on disk, regardless of what a receipt says.
 * - "current"   — disk matches the receipt (or, with no receipt, matches the
 *   bundle directly — see below) and the receipt (if any) matches the bundle.
 * - "outdated"  — disk matches the receipt, but the bundle has moved on;
 *   installing again would be a same-content overwrite, so it's safe.
 * - "modified"  — disk no longer matches the receipt: the user edited their
 *   copy. Checked before "outdated" is even possible, because overwriting an
 *   edited file needs a different (louder) confirmation than overwriting a
 *   stale one.
 * - "unmanaged" — no receipt, and disk doesn't match the bundle either. This
 *   is content Task 1 has never seen a receipt for and that isn't just the
 *   pre-receipt bundle — e.g. a skill directory someone else populated by
 *   hand. It's the only state that never had a bundle-content installed here.
 *
 * The receipt-less/bundle-matching case ("current" without a receipt) exists
 * because every user who ran `dure skills install dure --global` before this
 * feature shipped is in exactly that position: they must read as up to date,
 * not nagged as unmanaged. Task 2 writes the receipt for that case silently
 * on next observation; this function only ever reports, never writes.
 */
export function skillInstallState({ diskDigest, receiptDigest, bundleDigest }) {
	if (!diskDigest) return "missing";
	if (!receiptDigest) return diskDigest === bundleDigest ? "current" : "unmanaged";
	if (diskDigest !== receiptDigest) return "modified";
	return receiptDigest === bundleDigest ? "current" : "outdated";
}

/**
 * Structural guard for a parsed receipt JSON file. Used before trusting any
 * field of a file that a filesystem (or a hand edit) could have handed back
 * in any shape — a receipt failing this check is treated as absent (Task 2),
 * which folds a corrupt receipt into the same "unmanaged"/"current" path as
 * no receipt at all rather than crashing on it.
 */
export function isSkillReceipt(value) {
	return (
		typeof value === "object" &&
		value !== null &&
		value.schemaVersion === SKILL_RECEIPT_SCHEMA &&
		typeof value.name === "string" &&
		typeof value.provider === "string" &&
		typeof value.target === "string" &&
		/^[0-9a-f]{64}$/.test(value.digest ?? "") &&
		typeof value.cliVersion === "string" &&
		typeof value.installedAt === "string"
	);
}
