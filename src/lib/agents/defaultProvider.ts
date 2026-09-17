import type { Provider } from "@/types";

/** The one place a "default agent" preference is turned into a provider.
 *
 * `preferred` is the stored `uiPrefs.defaultProvider` (undefined = Auto).
 * A persisted preference can outlive an uninstall or a catalog change, so it
 * is honored only while it is still in `available` (installed + core set);
 * otherwise Auto wins and the first available provider — today's `"claude"`
 * — is returned. Both new-agent surfaces call this rather than carrying their
 * own literal fallback. */
export function resolveDefaultProvider(
	preferred: Provider | undefined,
	available: readonly Provider[],
): Provider {
	if (preferred !== undefined && available.includes(preferred)) return preferred;
	const first = available[0];
	if (first === undefined) throw new Error("no provider is available");
	return first;
}
