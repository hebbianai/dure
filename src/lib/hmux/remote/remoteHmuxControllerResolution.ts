import {
	planRemoteHmuxCatalogTarget,
	type RemoteHmuxHostTrustV1,
	selectRemoteHmuxSession,
} from "@/lib/hmux/remote/remoteHmuxBroker";
import {
	RemoteHmuxRequestCoalescer,
	remoteHmuxHostRequestKey,
} from "@/lib/hmux/remote/remoteHmuxHostRequests";
import { remoteHmuxCatalog, remoteHmuxKnownHostTrust } from "@/lib/ipc";
import type {
	RemoteHmuxManagedPaneBindingV1,
	RemoteHmuxStandalonePaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { SshHostConfig } from "@/types";

const trustRequests = new RemoteHmuxRequestCoalescer<RemoteHmuxHostTrustV1>();

export async function resolveRemoteHmuxStandaloneController(
	hosts: readonly SshHostConfig[],
	binding: RemoteHmuxStandalonePaneBindingV1 | RemoteHmuxManagedPaneBindingV1,
) {
	const host = hosts.find((candidate) => candidate.id === binding.hostId);
	if (!host) throw new Error("remote_hmux_host_not_registered");
	const trust = await trustRequests.run(
		remoteHmuxHostRequestKey([binding.hostId, host.host, host.port]),
		() => remoteHmuxKnownHostTrust(binding.hostId, host.host, host.port),
	);
	const target = planRemoteHmuxCatalogTarget(hosts, binding.hostId, trust);
	// The catalog is asked fresh every time: a pane that just created or
	// re-launched its session must see a listing taken after that.
	const receipt = await remoteHmuxCatalog(target);
	const session = selectRemoteHmuxSession(receipt, {
		hostId: binding.hostId,
		sessionId: binding.sessionId,
		workspaceId: binding.workspaceId,
		sessionClass:
			binding.runtime === "hmux_standalone_v1" ? "standalone" : "managed",
	});
	return { target, session };
}
