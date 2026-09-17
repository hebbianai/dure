export const DISCOVERY_PREVIEW_LIMIT = 5;
export const DISCOVERY_EXPANDED_LIMIT = 120;

/** Large discovery censuses stay bounded until the user explicitly expands them. */
export function visibleDiscoveryItems<T>(
	items: readonly T[],
	expanded: boolean,
	{
		expandedLimit = DISCOVERY_EXPANDED_LIMIT,
		previewLimit = DISCOVERY_PREVIEW_LIMIT,
	}: { expandedLimit?: number; previewLimit?: number } = {},
): readonly T[] {
	const limit = expanded ? expandedLimit : previewLimit;
	if (!Number.isSafeInteger(limit) || limit < 0) return [];
	return items.slice(0, limit);
}
