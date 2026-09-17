import { getCurrentWindow } from "@tauri-apps/api/window";
import { hmuxPaneOwnerId } from "@/lib/hmux/hmuxPaneRetirement";
import { StructuredTerminalQaProbe } from "@/lib/terminal/qa/structuredTerminalQaProbe";
import { registerTerminalWindowFocusProbe } from "@/lib/terminal/qa/terminalWindowFocusProbeRegistry";
import { findAgentPanel } from "@/lib/workspace/dock/dockPanelParameters";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";

/** Observe the production surface before its first React mount. No input or focus. */
export function observeQuickStartPresentation(spaceId: string) {
	const nativeWindow = getCurrentWindow();
	const probes = new Map<string, StructuredTerminalQaProbe>();
	const registrations: (() => void)[] = [];
	let failure: unknown;
	const stop = useStore.subscribe((state) => {
		const api = getDockview(spaceId);
		if (!api) return;
		for (const agent of state.agents) {
			if (probes.has(agent.id)) continue;
			const pane = findAgentPanel(api, agent.id);
			if (!pane) continue;
			if (probes.size === 1) {
				failure = new Error("Quick-start QA created more than one Agent");
				continue;
			}
			const surfaceId = hmuxPaneOwnerId(nativeWindow.label, spaceId, pane.id);
			const probe = new StructuredTerminalQaProbe(surfaceId, {
				onConnected: () => () => {},
				onFocused: () => {},
				onHydrationChange: () => {},
				onSynchronized: () => {},
				onPresented: () => {},
				onError: (error) => {
					failure = error;
				},
			});
			probes.set(agent.id, probe);
			registrations.push(registerTerminalWindowFocusProbe(surfaceId, probe));
		}
	});
	return {
		async ready(agentId: string) {
			const deadline = performance.now() + 30_000;
			const marker = "Welcome to Claude Code!";
			while (
				!probes.get(agentId)?.connected ||
				!probes.get(agentId)?.bufferState(marker)
					?.logicalScrollbackMarkerPresent
			) {
				if (failure) throw failure;
				if (performance.now() >= deadline)
					throw new Error(
						"Quick-start provider pane did not attach and present",
					);
				await new Promise<void>((resolve) => setTimeout(resolve, 50));
			}
			const state = probes.get(agentId)!.bufferState();
			const visible = await nativeWindow.isVisible();
			const focused = await nativeWindow.isFocused();
			if (
				!state ||
				state.concealed ||
				state.columns <= 0 ||
				state.rows <= 0 ||
				!visible ||
				focused
			)
				throw new Error(
					"Quick-start QA requires a presented, unfocused native pane",
				);
			return {
				connected: true,
				presented: true,
				providerOutput: true,
				columns: state.columns,
				rows: state.rows,
				visible,
				focused,
			};
		},
		dispose() {
			stop();
			for (const release of registrations) release();
			for (const probe of probes.values()) probe.dispose();
		},
	};
}
