const MAX_AGENT_NAME_LENGTH = 64;
const CANONICAL_AGENT_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function trimToCanonicalBoundary(value: string): string {
	return value
		.slice(0, MAX_AGENT_NAME_LENGTH)
		.replace(/^[^a-z0-9]+/, "")
		.replace(/[^a-z0-9]+$/, "");
}

export function supportsCanonicalAgentName(value: string): boolean {
	return CANONICAL_AGENT_NAME.test(value);
}

/** Normalizes user/provider text once into the canonical Agent identity. */
export function canonicalAgentNameCandidate(raw: string): string | null {
	const cleaned = trimToCanonicalBoundary(
		raw
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/-+/g, "-"),
	);
	return supportsCanonicalAgentName(cleaned) ? cleaned : null;
}

export function uniqueAgentName(
	base: string,
	takenNames: readonly string[],
): string {
	if (!takenNames.includes(base)) return base;
	let suffix = 2;
	for (;;) {
		const suffixText = `-${suffix}`;
		const head = trimToCanonicalBoundary(
			base.slice(0, MAX_AGENT_NAME_LENGTH - suffixText.length),
		);
		const candidate = `${head}${suffixText}`;
		if (!takenNames.includes(candidate)) return candidate;
		suffix += 1;
	}
}
