import {
	samePaneOperationalIdentity,
	sameSshHostOperationalIdentity,
} from "@/lib/agents/resourceOperationalIdentity";
import type { PreparingRemoteHmuxPaneTransitionV1 } from "@/lib/hmux/remote/remoteHmuxPaneTransition";
import { normalizePersistedState } from "@/lib/persistence/persistedAppState";
import { bindingFromPane } from "@/lib/terminal/terminalBinding";
import {
	panelIsPlacedInLayout,
	panelsFromLayout,
} from "@/lib/workspace/layout/layoutLifecycle";
import { DURABLE_APP_STORE_NAME, durableAppStorage } from "@/store";
import type { SshHostConfig } from "@/types";

/** A flushed local projection may have lost a cross-window CAS. Read the
 * committed pane generation before allowing its operation to cross SSH. */
export function hasDurableRemoteHmuxShellPreparation(
	spaceId: string,
	panelId: string,
	host: SshHostConfig,
	preparing: PreparingRemoteHmuxPaneTransitionV1,
): Promise<boolean> {
	return durableAppStorage.read(DURABLE_APP_STORE_NAME, (current) => {
		if (!current) return false;
		const state = normalizePersistedState(current.state);
		if (
			!state.spaces.some((space) => space.id === spaceId) ||
			!sameSshHostOperationalIdentity(
				state.sshHosts.find((candidate) => candidate.id === host.id),
				host,
			)
		)
			return false;
		const layout = state.layouts[spaceId];
		const pane = panelsFromLayout(layout).find(
			(candidate) => candidate.id === panelId,
		);
		return (
			pane !== undefined &&
			panelIsPlacedInLayout(layout, panelId) &&
			samePaneOperationalIdentity(
				pane.params.remoteHmuxTransition,
				preparing,
			) &&
			samePaneOperationalIdentity(
				bindingFromPane(pane, state.agents, state.projects),
				preparing.sourceBinding,
			)
		);
	});
}
