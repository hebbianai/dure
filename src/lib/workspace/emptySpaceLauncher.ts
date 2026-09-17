// What the empty-space launcher offers and where it launches.
//
// A Space is not bound to a directory, so the launcher resolves one once per
// mount instead of pretending a binding exists: the pane the user last focused
// wins, then the first registered local folder, then home. The resolved value
// is a *default the user can replace*, never a property of the space — once a
// pane launches, the pane's own cwd is the durable fact.

import { providerFreshManagedCmd } from "@/lib/agents/providers";
import { quickStartProviders } from "@/lib/agents/providerQuickStart";
import type { FocusContext } from "@/lib/workspace/focusContext";
import type { Project, Provider } from "@/types";

export interface LaunchDirectory {
	/** Absolute folder, or null when nothing about the user is known yet. */
	path: string | null;
	source: "focus" | "project" | "home" | "chosen";
}

/**
 * The launch folder shown before the user picks one. Resolved once per
 * watermark mount — a default that flips while the menu is open would make
 * the chip unpredictable, so later focus changes do not re-enter here.
 */
export function defaultLaunchDirectory(input: {
	focusCtx: FocusContext | null;
	projects: readonly Project[];
}): LaunchDirectory {
	const focusCwd =
		input.focusCtx?.source === "local" ? input.focusCtx.cwd.trim() : "";
	if (focusCwd) return { path: focusCwd, source: "focus" };
	const project = input.projects.find((candidate) => candidate.kind === "local");
	if (project) return { path: project.path, source: "project" };
	return { path: null, source: "home" };
}

export interface ProviderLaunchRow {
	provider: Provider;
	/** The command the launch will effectively run, permission flag included. */
	command: string;
	installed: boolean;
}

/**
 * Launcher rows in quick-start rank: what this machine has first, catalog
 * order inside each group. The command preview reads the same projected
 * launch-defaults the spawn applies, so the row never promises a permission
 * posture the run won't have.
 */
export function providerLaunchRows(input: {
	available: readonly Provider[];
	installed: readonly Provider[];
	skipPermissions: Readonly<Partial<Record<Provider, boolean>>>;
}): ProviderLaunchRow[] {
	const present = new Set(input.installed);
	return quickStartProviders(
		input.available,
		input.installed,
		input.available.length,
	).map((provider) => ({
		provider,
		command: providerFreshManagedCmd(
			provider,
			input.skipPermissions[provider] ? "bypass_approvals" : "default",
		),
		installed: present.has(provider),
	}));
}

export type EmptySpaceLaunchPlan =
	| { kind: "terminal"; cwd?: string }
	| { kind: "agent-quick"; provider: Provider; path: string }
	| { kind: "agent-dialog"; provider: Provider };

/** A terminal can start anywhere — the home fallback just omits cwd and lets
 *  the session runtime apply its own home default. */
export function terminalLaunchPlan(directory: LaunchDirectory): EmptySpaceLaunchPlan {
	return directory.path ? { kind: "terminal", cwd: directory.path } : { kind: "terminal" };
}

/**
 * An agent launch needs a real folder (the quick path registers it as a
 * project). When only the home fallback is known — or the resolved path *is*
 * the home directory, however it got there (a focused terminal sitting at
 * $HOME, an explicit browse) — the add-agent dialog is the honest next step:
 * it asks for a location instead of silently registering home as a project.
 */
export function agentLaunchPlan(
	provider: Provider,
	directory: LaunchDirectory,
	home: string | null,
): EmptySpaceLaunchPlan {
	const path = directory.path;
	if (!path || (home !== null && path === home)) {
		return { kind: "agent-dialog", provider };
	}
	return { kind: "agent-quick", provider, path };
}

/** Chip display only — path identity everywhere else stays absolute. */
export function displayLaunchPath(path: string, home: string | null): string {
	if (!home) return path;
	if (path === home) return "~";
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
