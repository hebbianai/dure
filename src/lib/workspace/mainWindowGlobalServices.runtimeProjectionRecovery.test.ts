import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	inspectRuntime: vi.fn(),
}));

vi.mock("@/lib/agents/agentAttentionNotifier", () => ({
	installAgentAttentionNotifier: () => () => undefined,
}));
vi.mock("@/lib/agents/managedAgentSemanticObserverRuntime", () => ({
	installManagedAgentSemanticObserverRuntime: () => () => undefined,
}));
vi.mock("@/lib/agents/providerConversationMetadataRuntime", () => ({
	installProviderConversationMetadataRuntime: () => () => undefined,
}));
vi.mock("@/lib/maintenance/discoveryStateGcService", () => ({
	installDiscoveryStateGcService: () => () => undefined,
}));
vi.mock("@/lib/persistence/registry", () => ({
	startRegistrySync: () => () => undefined,
}));
vi.mock("@/lib/settings/notificationActivation", () => ({
	installNotificationActivationHandler: () => () => undefined,
}));
vi.mock("@/lib/spaces/localProjectReconciliation", () => ({
	reconcilePersistedLocalProjects: async () => undefined,
}));
vi.mock("@/lib/agents/canonicalAgentStopRuntime", () => ({
	reconcileCanonicalAgentStopsOnceV1: async () => undefined,
}));
vi.mock("@/lib/ipc/dureAgentRuntime", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc/dureAgentRuntime")>()),
	createDureAgentRuntimeClient: () => ({ inspect: mocks.inspectRuntime }),
}));

import { publishHmuxControlPlaneCensus } from "@/lib/hmux/identity/hmuxControlPlaneCensusFeed";
import { useStore } from "@/store";
import {
	hmuxSessionSummaryFixture,
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import { startMainWindowGlobalServices } from "./mainWindowGlobalServices";

const stopFence = stopFenceFixture();
const agent = managedAgentFixture({
	runtimeBinding: managedBindingFixture({
		backendProfileId: "local",
		stopFence,
	}),
});
const project = {
	id: agent.projectId,
	name: "Project",
	path: "/repo",
	kind: "local" as const,
	isRepo: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	const routeAuthority = testDureBackendRouteAuthority(
		"backend-1",
		"generation-1",
	);
	mocks.inspectRuntime.mockResolvedValue({
		state: "stable",
		backend: routeAuthority.backend,
		backendProfileId: "local",
		routeAuthority,
		agentId: agent.id,
		selectionRevision: 2,
		providerId: agent.provider,
		executionProfile: { kind: "provider_default" },
		providerConversationRef: "conversation-1",
		interactionProfile: "structured_protocol",
		interactionSessionId: "interaction-1",
		launchSelection: {
			model: "gpt-5.6-sol",
			effort: "max",
			permissionMode: "skip_permissions",
		},
	});
	useStore.setState({
		agents: [agent],
		projects: [project],
		sshHosts: [],
		agentRuntimeLaunchPresentation: {},
	});
});

afterEach(() => {
	useStore.setState({
		agents: [],
		projects: [],
		sshHosts: [],
		agentRuntimeLaunchPresentation: {},
	});
});

it("recovers Chat when the backend committed after the native projection was persisted", async () => {
	const stop = startMainWindowGlobalServices();
	publishHmuxControlPlaneCensus({
		policy: {
			activation: "local_bundled_or_installed_current",
			signedReleaseFetch: "not_implemented",
			signedPackageInstall: "blocked_missing_trust_root",
		},
		sessions: [
			hmuxSessionSummaryFixture({
				lifecycle: "exited",
				health: "exited",
				terminalEpoch: stopFence.terminalEpoch,
				stopFence,
			}),
		],
		protectedBuildIds: [],
	});

	await vi.waitFor(() => {
		expect(useStore.getState().agents[0]?.interactionProfile).toEqual({
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		});
	});
	expect(mocks.inspectRuntime).toHaveBeenCalledOnce();
	stop();
});
