import { useMemo } from "react";
import { useAvailableProviders } from "@/lib/agents/agentInstalls";
import { providerLaunchRows } from "@/lib/workspace/emptySpaceLauncher";
import { useStore } from "@/store";

/** Both launch surfaces project the existing installation and permission owners. */
export function usePaneLaunchState(hostId?: string) {
	const available = useAvailableProviders();
	const installed = useStore((state) => state.installedAgents);
	const skipPermissions = useStore((state) => state.skipPermissions);
	const host = useStore((state) =>
		hostId ? state.sshHosts.find((host) => host.id === hostId) : undefined,
	);
	const rows = useMemo(
		() => providerLaunchRows({ available, installed, skipPermissions }),
		[available, installed, skipPermissions],
	);
	return { rows, installed, host };
}
