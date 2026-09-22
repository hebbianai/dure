// Quick-dispatch cluster's designated store-wiring point (AGENTS.md fitness
// gate: new src/components/ files read the store only through a cluster
// use* hook, never directly). QuickDispatchOverlay.tsx and
// LazyQuickDispatchOverlay.tsx must not import "@/store" themselves — every
// value they need from global state routes through here.

import type { ShortcutOverride } from "@/lib/settings/shortcutBindings";
import { useStore } from "@/store";

export function useQuickDispatch() {
	const projects = useStore((s) => s.projects);
	const agents = useStore((s) => s.agents);
	const installedAgents = useStore((s) => s.installedAgents);
	const focusCtx = useStore((s) => s.focusCtx);
	const defaultProvider = useStore((s) => s.uiPrefs.defaultProvider);
	const sshHosts = useStore((s) => s.sshHosts);
	const accounts = useStore((s) => s.accounts);
	const quickCommands = useStore((s) => s.uiPrefs.quickCommands);
	const ensureProjectForPath = useStore((s) => s.ensureProjectForPath);
	return {
		projects,
		agents,
		installedAgents,
		focusCtx,
		defaultProvider,
		accounts,
		sshHosts,
		quickCommands,
		ensureProjectForPath,
	};
}

/** The desktop to open the full add-agent dialog on when there is no local
 *  project — the same desktopId SpacesPane's own add-agent trigger passes to
 *  WorktreeAgentDialog. */
export function useActiveSpaceId(): string {
	return useStore((s) => s.activeSpaceId);
}

/** Deferred read for the launcher's capture-phase keydown handler — sampled
 *  at keypress time, matching LazyNativeSearchDialog's own inline read of
 *  the same field. */
export function readShortcutOverrides(): Record<string, ShortcutOverride> {
	return useStore.getState().shortcutOverrides;
}
