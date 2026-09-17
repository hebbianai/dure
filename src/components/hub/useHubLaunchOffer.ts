/**
 * The wiring that tells the hub which seats a phone may start an agent in.
 *
 * [`buildLaunchOffer`] decides the content; this decides what to feed it and
 * when to send.
 *
 * # Why it hangs off the app root
 *
 * The same reason [`useHubSidebarLayout`] does. Put it inside the sidebar and
 * it stops updating the moment somebody collapses it, so a folder registered
 * with the sidebar closed never reaches the phone — and on the phone that is
 * indistinguishable from a folder that was never registered.
 *
 * # Why only the main window
 *
 * A popout window renders `App` too. The offer is replaced whole, so two
 * windows publishing means the last one to render wins; that is survivable
 * here because both build the same table from the same store. What is not
 * survivable is the *other* half of this feature — a start request answered by
 * every window at once starts an agent per window. Keeping both halves on the
 * same window is what makes that one rule, not two.
 *
 * # Why only on change
 *
 * The store changes constantly and almost none of it moves this table. Sending
 * every time would be an IPC per keystroke of agent activity. So the inputs
 * here must be things that change when somebody *does* something: spaces,
 * folders, hosts, installed agents. Nothing that ticks.
 */

import { useEffect, useMemo, useRef } from "react";
import { useVisibleProviders } from "@/lib/agents/agentInstalls";
import { buildLaunchOffer } from "@/lib/hub/launchOffer";
import type { AgentKind, LaunchTarget } from "@/lib/hub/launchOfferWire";
import { isMainWindow } from "@/lib/workspace/window/windows";
import { useStore } from "@/store";
import type { Project } from "@/types";

/** Where the offer goes. Injected so a test can run this hook without Tauri. */
export type LaunchOfferSink = (
	targets: LaunchTarget[],
	kinds: AgentKind[],
) => void;

export function useHubLaunchOffer(send: LaunchOfferSink): void {
	const projects = useStore((state) => state.projects);
	const sshHosts = useStore((state) => state.sshHosts);
	const installedKinds = useStore((state) => state.installedAgents);
	const visibleKinds = useVisibleProviders();
	const spaces = useStore((state) => state.desktops);
	const lastSent = useRef<string>("");

	/**
	 * Which machine a folder sits on. This label never selects its SSH host.
	 *
	 * A local folder sends nothing, and the phone fills in the name it already
	 * has for this computer. Naming it here instead would mean shipping a
	 * seventh-catalog string for a fact the phone knows better: the person
	 * named this box themselves when they paired it.
	 */
	const boxLabel = useMemo(() => {
		const named = new Map(sshHosts.map((host) => [host.id, host.name]));
		return (project: Project): string =>
			project.kind === "ssh"
				? (project.sshHostId && named.get(project.sshHostId)) || "SSH"
				: "";
	}, [sshHosts]);

	useEffect(() => {
		if (!isMainWindow()) return;
		const offer = buildLaunchOffer({
			spaces,
			projects,
			// Remote providers need not be installed on the laptop. Availability
			// is target-scoped; remote preflight checks the selected host at Start.
			kinds: visibleKinds,
			installedKinds,
			sshHosts,
			boxLabel,
		});
		const encoded = JSON.stringify(offer);
		if (encoded === lastSent.current) return;
		lastSent.current = encoded;
		send(offer.targets, offer.kinds);
	}, [spaces, projects, visibleKinds, installedKinds, sshHosts, boxLabel, send]);
}
