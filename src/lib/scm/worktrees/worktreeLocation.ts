export type WorktreePathDialect = "native" | "posix";
export type WorktreeLocationComparison = "same" | "different" | "unresolved";

function trimTrailingSeparators(value: string): string {
	const trimmed = value.replace(/[\\/]+$/, "");
	return trimmed || (value.startsWith("/") ? "/" : value);
}

function unsafeSegments(value: string): boolean {
	return value
		.replace(/\\/g, "/")
		.split("/")
		.some((part) => part === "." || part === "..");
}

function windowsLocationKey(value: string): string | "unresolved" | undefined {
	if (value.includes("\0")) return "unresolved";
	if (/^(?:\\\\|\/\/)[?.](?:\\|\/)/.test(value)) return "unresolved";
	const slashPath = value.replace(/\\/g, "/");
	if (!/^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+)/.test(slashPath)) {
		return undefined;
	}
	if (unsafeSegments(slashPath)) return "unresolved";
	return trimTrailingSeparators(slashPath).toLowerCase();
}

/** Classifies only syntax-level equivalence; Host canonicalization owns deletion. */
export function compareWorktreeLocations(
	left: string,
	right: string,
	dialect: WorktreePathDialect,
): WorktreeLocationComparison {
	if (left.includes("\0") || right.includes("\0")) return "unresolved";
	if (left === right) return "same";
	if (dialect === "posix") {
		if (
			unsafeSegments(left) ||
			unsafeSegments(right) ||
			left.startsWith("//") ||
			right.startsWith("//")
		) {
			return "unresolved";
		}
		return trimTrailingSeparators(left) === trimTrailingSeparators(right)
			? "same"
			: "different";
	}
	const leftWindows = windowsLocationKey(left);
	const rightWindows = windowsLocationKey(right);
	if (leftWindows === "unresolved" || rightWindows === "unresolved") {
		return "unresolved";
	}
	if (leftWindows || rightWindows) {
		if (!leftWindows || !rightWindows) return "unresolved";
		return leftWindows === rightWindows ? "same" : "different";
	}
	if (unsafeSegments(left) || unsafeSegments(right)) return "unresolved";
	return trimTrailingSeparators(left) === trimTrailingSeparators(right)
		? "same"
		: "different";
}

export function sameWorktreeLocation(
	left: string,
	right: string,
	dialect: WorktreePathDialect,
): boolean {
	return compareWorktreeLocations(left, right, dialect) === "same";
}
