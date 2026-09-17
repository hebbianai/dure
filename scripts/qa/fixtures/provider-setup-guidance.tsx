import { createRoot } from "react-dom/client";
import { AddAgentBody } from "@/components/agents/addAgent/AddAgentBody";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { providerInstallCommand } from "@/lib/agents/providerInstallCommand";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";
import { createAgentRunBackendFixture } from "@/test/dureAgentRunFixtures";
import type { Project } from "@/types";
import "@/index.css";

// This page uses the existing browser-only Tauri mock and canonical Run fixture.
// No command reaches a native backend or the machine's clipboard.
const project: Project = {
	id: "guide-project", name: "guide", path: "/qa/provider-guide",
	kind: "local", isRepo: false,
};
const backend = createAgentRunBackendFixture({ projectId: project.id });
const receipt = {
	closed: 0, copied: [] as string[], commands: [] as string[],
	previews: [] as unknown[], applies: [] as unknown[],
	reasonCode: "provider_executable_not_found",
};
const fixtureWindow = window as unknown as {
	__TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
	__DURE_PROVIDER_GUIDE__: unknown;
};
const invoke = fixtureWindow.__TAURI_INTERNALS__.invoke.bind(fixtureWindow.__TAURI_INTERNALS__);
let preview: unknown;
fixtureWindow.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
	receipt.commands.push(command);
	if (command === "dure_backend_route_assert") return backend.invokeCommand(command, args);
	if (command === "dure_backend_request") {
		if (args.operation === "agent_spawn.preview") {
			receipt.previews.push(args.body);
			preview = await backend.invokeCommand(command, args);
			return preview;
		}
		if (args.operation === "agent_spawn.status") return preview;
		if (args.operation === "agent_spawn.apply") {
			receipt.applies.push(args.body);
			throw {
				code: "agent_spawn_provider_unavailable", message: "Provider setup fixture failure.",
				details: { reasonCode: receipt.reasonCode, disposition: "retry_same" },
			};
		}
		throw new Error(`Unexpected backend operation: ${args.operation}`);
	}
	if (command === "list_dir") return [];
	return invoke(command, args);
};
Object.defineProperty(navigator, "clipboard", {
	configurable: true,
	value: { writeText: async (value: string) => { receipt.copied.push(value); } },
});
useStore.setState((state) => ({
	projects: [project], agents: [], accounts: [], activeAccounts: {}, sshHosts: [],
	installedAgents: ["claude", "codex"], activeSpaceId: "guide-space",
	spaces: [{ id: "guide-space", name: "Guide" }],
	uiPrefs: { ...state.uiPrefs, interfaceMode: "basic", defaultProvider: "claude" },
	ensureProjectForPath: async () => project,
}));
fixtureWindow.__DURE_PROVIDER_GUIDE__ = {
	receipt,
	labels: {
		submit: t("agents.add.submit"), guide: t("agents.add.installationGuide"),
		retry: t("common.retry"),
		failure: t("ipc.dureRun.providerNotFound"),
		provider: t("common.agent"),
		copy: t("onboarding.checklist.copyCommand", { command: providerInstallCommand("claude")! }),
	},
	command: providerInstallCommand("claude"),
};
createRoot(document.getElementById("root")!).render(
	<Dialog open onOpenChange={() => { receipt.closed += 1; }}>
		<DialogContent style={{ width: "min(94vw, 698px)", maxWidth: "698px" }}>
			<DialogTitle>{t("agents.add.title")}</DialogTitle>
			<AddAgentBody
				desktopId="guide-space" initialHostId={null} initialProvider="claude"
				onClose={() => { receipt.closed += 1; }}
				onBrowse={() => { throw new Error("Unexpected folder dialog"); }}
				onAddHost={() => { throw new Error("Unexpected host dialog"); }}
			/>
		</DialogContent>
	</Dialog>,
);
