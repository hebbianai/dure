/**
 * What a phone must know before it can ask this laptop to start an agent.
 *
 * # Why this is a pure function
 *
 * The same reason `sidebarLayout` is one: the phone's whole idea of what it may
 * press comes from here, and a mistake in it is a screen offering a place that
 * does not exist. Kept as a function of its inputs, the offer can be checked
 * without a store, a window, or a phone.
 *
 * # Why every seat, not every project
 *
 * A project can sit in more than one space, and "start an agent in HebbianIDE"
 * is not a complete instruction until it says which space. The target is the
 * seat — one space and one project — and its id names that pair.
 */

import { PROVIDERS } from "@/lib/agents/providerCatalog";
import type { Provider } from "@/lib/agents/providerContracts";
import type { AgentKind, LaunchTarget } from "@/lib/hub/launchOfferWire";
import type { Project, Space, SshHostConfig } from "@/types";

/** What the offer is built from. */
export interface LaunchOfferInput {
	readonly spaces: readonly Space[];
	readonly projects: readonly Project[];
	/** Canonical provider labels; installation is reported separately. */
	readonly kinds: readonly Provider[];
	/** Of those, the ones whose CLI is actually on this machine's PATH. */
	readonly installedKinds: readonly Provider[];
	readonly sshHosts?: readonly SshHostConfig[];
	/** How to name the machine a project sits on. */
	readonly boxLabel: (project: Project) => string;
}

/**
 * The id that names one seat.
 *
 * Derived rather than random so it survives a restart: the phone may hold an
 * offer across one, and a fresh id every publish would turn a stale press into
 * "that place is gone" for a place that never moved. Space first because a
 * project id is unique and a space id is too — the pair is what is not.
 */
export function launchTargetId(spaceId: string, projectId: string): string {
	return `${spaceId} ${projectId}`;
}

/** Which seat an id names, or nothing when it names none. */
export function seatOfLaunchTarget(
	targetId: string,
): { spaceId: string; projectId: string } | undefined {
	const gap = targetId.indexOf(" ");
	if (gap <= 0 || gap === targetId.length - 1) return undefined;
	return {
		spaceId: targetId.slice(0, gap),
		projectId: targetId.slice(gap + 1),
	};
}

/** Project-scoped projection of the existing spawn saga's launch capabilities. */
export function projectLaunchCapabilities(
	project: Project,
	sshHosts: readonly SshHostConfig[],
): Pick<
	LaunchTarget,
	"startable" | "worktree_supported" | "provider_installation"
> {
	const local = project.kind === "local";
	return {
		startable: local || sshHosts.some((host) => host.id === project.sshHostId),
		worktree_supported: local,
		provider_installation: local ? "reported" : "check_on_start",
	};
}

export function buildLaunchOffer(input: LaunchOfferInput): {
	targets: LaunchTarget[];
	kinds: AgentKind[];
} {
	const targets: LaunchTarget[] = [];
	for (const space of input.spaces) {
		// A popout is the same space seen in another window. Offering it again
		// would show the person the same place twice with no way to tell them
		// apart, and starting in either does the same thing.
		if (space.kind === "popout") continue;
		for (const project of input.projects) {
			targets.push({
				id: launchTargetId(space.id, project.id),
				space_label: space.name,
				folder_label: project.name,
				box_label: input.boxLabel(project),
				path_hint: project.path,
				...projectLaunchCapabilities(project, input.sshHosts ?? []),
			});
		}
	}
	// Canonical choices are shared, but these installation facts describe only
	// this laptop. A target marked check_on_start delegates availability to its
	// existing remote preflight rather than borrowing the laptop's inventory.
	const present = new Set(input.installedKinds);
	return {
		targets,
		kinds: input.kinds.map((id) => ({
			id,
			label: PROVIDERS[id]?.label ?? id,
			installed: present.has(id),
		})),
	};
}
