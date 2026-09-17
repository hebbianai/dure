import { getCurrentWindow } from "@tauri-apps/api/window";
import { hmuxPaneOwnerId } from "@/lib/hmux/hmuxPaneRetirement";
import { t } from "@/lib/i18n";
import { StructuredTerminalQaProbe } from "@/lib/terminal/qa/structuredTerminalQaProbe";
import { registerTerminalWindowFocusProbe } from "@/lib/terminal/qa/terminalWindowFocusProbeRegistry";
import { bindingFromPane } from "@/lib/terminal/terminalBinding";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { durableAppStorage, useStore } from "@/store";
import {
	readSshRegistrationFixture,
	sshRegistrationMarker,
	sshRegistrationQaPublisher,
} from "./sshRegistrationFixture";

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Short-lived fixture driver. Real CLI observers, Dialog and pane owners run unchanged. */
export async function runSshRegistrationQa(): Promise<void> {
	const probes = new Map<string, StructuredTerminalQaProbe>();
	const releaseProbes: (() => void)[] = [];
	const flag = await readSshRegistrationFixture();
	const { runId } = flag;
	const realmId = crypto.randomUUID();
	const publish = sshRegistrationQaPublisher(runId, realmId);
	try {
		const nativeWindow = getCurrentWindow();
		const deadline = performance.now() + 150_000;
		const seen = new Set<string>();
		const actions = ["decline", "expire", "accept"] as const;
		while (
			mountedDockviewEntries().length === 0 &&
			performance.now() < deadline
		)
			await sleep(100);
		if (mountedDockviewEntries().length === 0)
			throw new Error("QA app has no mounted workspace");
		await publish("ready");
		while (performance.now() < deadline) {
			if (await nativeWindow.isFocused())
				throw new Error("background SSH QA took native focus");
			const state = useStore.getState();
			const decision = state.sshRegistrationDecisions[0];
			if (decision && !seen.has(decision.requestId)) {
				if (
					decision.candidate.host !== flag.host ||
					decision.candidate.port !== flag.port ||
					decision.candidate.user !== flag.user
				) {
					throw new Error("QA refused an unexpected SSH destination");
				}
				const action = actions[seen.size];
				if (!action)
					throw new Error(
						"registration prompted more than once per unknown request",
					);
				seen.add(decision.requestId);
				await sleep(100);
				const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
					(element) =>
						element.textContent?.includes(t("ssh.registrationPrompt.title")),
				);
				if (!dialog)
					throw new Error(
						"pending decision has no rendered registration dialog",
					);
				await publish("prompt", { action, hostCount: state.sshHosts.length });
				if (action !== "expire") {
					// Leave a deterministic interval for an unrelated HTTP request.
					await sleep(1_000);
					const label =
						action === "accept"
							? t("ssh.registrationPrompt.save")
							: t("ssh.registrationPrompt.useSsh");
					const button = [...dialog.querySelectorAll("button")].find(
						(element) => element.textContent === label,
					);
					if (!button)
						throw new Error(
							"registration action is not accessible by its label",
						);
					if (action === "accept") {
						const sourceFlag = await (
							await fetch("/__qa_flag", { signal: AbortSignal.timeout(2_000) })
						).json();
						if (
							sourceFlag.runId !== runId ||
							sourceFlag.home !== flag.home ||
							!sourceFlag.sourcePane
						)
							throw new Error("QA source pane receipt is missing");
						const source = sourceFlag.sourcePane;
						for (const [desktopId, api] of mountedDockviewEntries()) {
							for (const panel of api.panels) {
								if (
									desktopId !== source.desktopId ||
									panel.id !== source.panelId
								)
									continue;
								const binding = bindingFromPane(
									dockPanelReference(panel),
									state.agents,
									state.projects,
								);
								if (
									binding?.runtime !== "hmux_standalone_v1" ||
									binding.source !== "local" ||
									binding.sessionId !== source.sessionId ||
									binding.workspaceId !== source.workspaceId
								)
									throw new Error("QA source pane generation changed");
								const surfaceId = hmuxPaneOwnerId(
									nativeWindow.label,
									desktopId,
									panel.id,
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
								probes.set(surfaceId, probe);
								releaseProbes.push(
									registerTerminalWindowFocusProbe(surfaceId, probe),
								);
							}
						}
						if (probes.size !== 1)
							throw new Error("QA expected exactly one owned source pane");
					}
					button.click();
				}
			}
			for (const [desktopId, api] of mountedDockviewEntries()) {
				for (const panel of api.panels) {
					const binding = bindingFromPane(
						dockPanelReference(panel),
						state.agents,
						state.projects,
					);
					if (
						binding?.runtime !== "hmux_standalone_v1" ||
						binding.source !== "ssh"
					)
						continue;
					const probe = probes.get(
						hmuxPaneOwnerId(nativeWindow.label, desktopId, panel.id),
					);
					if (!probe?.connected) continue;
					const { marker, input } = sshRegistrationMarker(runId, "0001");
					const observation = await probe.observeInput(marker, input, {
						onReceipt: () => {},
						onProjection: () => {},
					});
					if (
						observation.markerCounts.painted !== 1 ||
						observation.markerCounts.projection !== 1
					)
						throw new Error("remote input marker did not render exactly once");
					if (await nativeWindow.isFocused())
						throw new Error("background SSH QA took native focus");
					await durableAppStorage.flush();
					const hosts = state.sshHosts.map(
						({
							id,
							host,
							port,
							user,
							auth,
							password,
							secretId,
							credential,
							keyPath,
						}) => ({
							id,
							host,
							port,
							user,
							auth,
							hasSecret: Boolean(password || secretId || credential || keyPath),
						}),
					);
					if (
						hosts.length !== 1 ||
						hosts[0]?.auth !== "auto" ||
						hosts[0]?.hasSecret ||
						seen.size !== 3
					)
						throw new Error(
							"registration did not converge on one non-secret host",
						);
					await publish("handoff", {
						observation,
						desktopId,
						panelId: panel.id,
						binding: {
							runtime: binding.runtime,
							source: binding.source,
							hostId: binding.hostId,
							sessionId: binding.sessionId,
							workspaceId: binding.workspaceId,
						},
						hosts,
						promptCount: seen.size,
					});
					// The client first inspects the exact Host, then arms one realm reload.
					const reloadDeadline = performance.now() + 15_000;
					while (performance.now() < reloadDeadline) {
						const next = await readSshRegistrationFixture();
						if (next.recovery) {
							const recovery = next.recovery;
							if (
								recovery.previousRealmId !== realmId ||
								recovery.panelId !== panel.id ||
								recovery.desktopId !== desktopId ||
								recovery.binding.sessionId !== binding.sessionId ||
								recovery.binding.workspaceId !== binding.workspaceId ||
								recovery.binding.hostId !== binding.hostId
							)
								throw new Error("QA reload changed its owned pane identity");
							await publish("reloading");
							location.reload();
							return;
						}
						await sleep(100);
					}
					throw new Error("QA client did not arm WebView recovery");
				}
			}
			await sleep(100);
		}
		throw new Error("SSH registration native journey timed out");
	} catch (error) {
		await publish("failed", { error: String(error) });
	} finally {
		for (const release of releaseProbes) release();
		for (const probe of probes.values()) probe.dispose();
	}
}
