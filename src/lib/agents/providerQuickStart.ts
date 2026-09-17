// Which agents get a button, when only a few fit.
//
// The menu can list every available provider; a row cannot. Taking the first
// N of `availableProviders()` looks like personalisation and is not: that list
// is the catalog order filtered by `core || installed`, and the three core
// providers occupy catalog positions 0-2. Its first three entries are the same
// constant for every user on every machine, so a daily Gemini user would get a
// Kimi button they never installed.
//
// So the rank is: what this machine actually has, first. Installed providers
// come before core-but-absent ones, and catalog order breaks ties inside each
// group — a fixed order, not a usage ranking. Nothing in the app records how
// often a provider is used (no persisted per-provider counter exists), and
// ordering by anything volatile — open agent counts, session scans — would
// reshuffle the buttons under the pointer as sessions come and go.

import type { Provider } from "@/types";

/**
 * The providers that get a button, most-relevant first.
 *
 * `available` is the menu's own order (catalog order, core + installed), and
 * the result is always a subset of it, so a button and its menu entry can
 * never disagree about which providers exist.
 */
export function quickStartProviders(
	available: readonly Provider[],
	installed: readonly Provider[],
	limit: number,
): Provider[] {
	if (limit <= 0) return [];
	const present = new Set(installed);
	const ranked = [
		...available.filter((provider) => present.has(provider)),
		...available.filter((provider) => !present.has(provider)),
	];
	return ranked.slice(0, limit);
}
