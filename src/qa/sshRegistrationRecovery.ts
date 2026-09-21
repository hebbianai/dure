import { getCurrentWindow } from "@tauri-apps/api/window";
import { hmuxPaneOwnerId } from "@/lib/hmux/hmuxPaneRetirement";
import { StructuredTerminalQaProbe } from "@/lib/terminal/qa/structuredTerminalQaProbe";
import { registerTerminalWindowFocusProbe } from "@/lib/terminal/qa/terminalWindowFocusProbeRegistry";
import { bindingFromPane } from "@/lib/terminal/terminalBinding";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { closePanelById } from "@/lib/workspace/pane/paneCloseCoordinator";
import { useStore } from "@/store";
import { runSshRegistrationQa } from "./sshRegistration";
import {
	readSshRegistrationFixture,
	sshRegistrationMarker,
	sshRegistrationQaPublisher,
} from "./sshRegistrationFixture";

/** Register before App mounts, so the restored pane uses its real QA surface. */
export async function prepareSshRegistrationQa() {
	const flag = await readSshRegistrationFixture();
	const recovery = flag.recovery;
	if (!recovery) return { run: runSshRegistrationQa, release: () => {} };
	if (
		typeof recovery.panelId !== "string" ||
		!recovery.panelId ||
		!recovery.desktopId ||
		!recovery.previousRealmId ||
		recovery.binding?.runtime !== "hmux_standalone_v1" ||
		recovery.binding.source !== "ssh" ||
		!recovery.binding.sessionId.startsWith("standalone_") ||
		!recovery.binding.workspaceId ||
		!recovery.binding.hostId
	)
		throw new Error("invalid SSH recovery fixture identity");
	const nativeWindow = getCurrentWindow();
	const realmId = crypto.randomUUID();
	if (realmId === recovery.previousRealmId)
		throw new Error("SSH recovery did not enter a new WebView realm");
	const publish = sshRegistrationQaPublisher(flag.runId, realmId);
	const surfaceId = hmuxPaneOwnerId(
		nativeWindow.label,
		recovery.desktopId,
		recovery.panelId,
	);
	const probe = new StructuredTerminalQaProbe(
		surfaceId,
		{
			onConnected: () => () => {},
			onFocused: () => {},
			onHydrationChange: () => {},
			onSynchronized: () => {},
			onPresented: () => {},
			onError: (error) => {
				void publish("failed", { error: String(error) });
			},
		},
		10_000,
	);
	const unregister = registerTerminalWindowFocusProbe(surfaceId, probe);
	return {
		release: () => {
			unregister();
			probe.dispose();
		},
		run: async () => {
			try {
				await publish("recovery-ready");
				const deadline = performance.now() + 30_000;
				while (!probe.connected && performance.now() < deadline) {
					if (await nativeWindow.isFocused())
						throw new Error("background SSH recovery took native focus");
					if (useStore.getState().sshRegistrationDecisions.length !== 0)
						throw new Error("restored SSH host prompted for registration");
					await new Promise<void>((resolve) => setTimeout(resolve, 100));
				}
				if (!probe.connected)
					throw new Error("restored SSH pane did not reconnect");
				const state = useStore.getState();
				const api = mountedDockviewEntries().find(
					([id]) => id === recovery.desktopId,
				)?.[1];
				const panel = api?.panels.find(
					(entry) => entry.id === recovery.panelId,
				);
				if (!panel) throw new Error("restored SSH pane identity disappeared");
				const binding = bindingFromPane(
					dockPanelReference(panel),
					state.agents,
					state.projects,
				);
				if (
					binding?.runtime !== "hmux_standalone_v1" ||
					binding.source !== "ssh" ||
					binding.hostId !== recovery.binding.hostId ||
					binding.sessionId !== recovery.binding.sessionId ||
					binding.workspaceId !== recovery.binding.workspaceId
				)
					throw new Error("recovery replaced the exact remote session");
				const [host] = state.sshHosts;
				if (
					state.sshHosts.length !== 1 ||
					host.id !== binding.hostId ||
					host.host !== flag.host ||
					host.port !== flag.port ||
					host.user !== flag.user ||
					host.auth !== "auto" ||
					host.password ||
					host.secretId ||
					host.credential ||
					host.keyPath ||
					state.sshRegistrationDecisions.length !== 0
				)
					throw new Error(
						"recovery did not retain exactly one non-secret SSH host",
					);
				const previous = sshRegistrationMarker(flag.runId, "0001").marker;
				const beforeInput = probe.bufferState(previous);
				if (beforeInput?.logicalScrollbackMarkerPresent !== true)
					throw new Error("previous remote output was absent before new input");
				const { marker, input } = sshRegistrationMarker(flag.runId, "0002");
				const observation = await probe.observeInput(marker, input, {
					onReceipt: () => {},
					onProjection: () => {},
				});
				if (
					observation.markerCounts.painted !== 1 ||
					observation.markerCounts.projection !== 1
				)
					throw new Error("reconnected SSH input did not render exactly once");
				if (await nativeWindow.isFocused())
					throw new Error("background SSH recovery took native focus");
				await publish("recovered", {
					previousRealmId: recovery.previousRealmId,
					desktopId: recovery.desktopId,
					panelId: recovery.panelId,
					binding: recovery.binding,
					hostCount: state.sshHosts.length,
					pendingDecisions: state.sshRegistrationDecisions.length,
					beforeInput,
					observation,
				});
				// The HTTP command owner can serialize requests. Invoke both closes in
				// this WebView turn to exercise repeated UI clicks during real SSH I/O.
				const closeDeadline = performance.now() + 60_000;
				while (performance.now() < closeDeadline) {
					const request = (await readSshRegistrationFixture()).repeatedClose;
					if (!request) {
						await new Promise<void>((resolve) => setTimeout(resolve, 100));
						continue;
					}
					const closeApi = mountedDockviewEntries().find(
						([id]) => id === request.desktopId,
					)?.[1];
					const closePanel = closeApi?.getPanel(request.panelId);
					const closeBinding = closePanel?.params?.binding;
					const closeHost = useStore
						.getState()
						.sshHosts.find((host) => host.id === request.hostId);
					if (
						request.desktopId !== recovery.desktopId ||
						closeHost?.host !== flag.host ||
						closeHost.port !== flag.port ||
						closeHost.user !== flag.user ||
						request.panelId === recovery.panelId ||
						closeBinding?.runtime !== "hmux_standalone_v1" ||
						closeBinding.source !== "ssh" ||
						closeBinding.hostId !== request.hostId ||
						closeBinding.sessionId !== request.sessionId ||
						closeBinding.workspaceId !== request.workspaceId
					)
						throw new Error(
							"repeated close changed the owned SSH pane identity",
						);
					const receipts = await Promise.all([
						closePanelById(request.panelId, request.desktopId),
						closePanelById(request.panelId, request.desktopId),
					]);
					if (
						!receipts[0] ||
						JSON.stringify(receipts[0]) !== JSON.stringify(receipts[1]) ||
						closeApi?.getPanel(request.panelId)
					)
						throw new Error(
							"repeated close did not converge on one successful removal",
						);
					if (await nativeWindow.isFocused())
						throw new Error("background SSH close took native focus");
					await publish("repeated-close", { ...request, receipts });
					return;
				}
				throw new Error("QA client did not arm repeated SSH close");
			} catch (error) {
				await publish("failed", { error: String(error) });
				throw error;
			}
		},
	};
}
