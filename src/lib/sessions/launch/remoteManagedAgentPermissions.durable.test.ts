// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addAgent } from "@/lib/agents/agentRegistration";
import {
	normalizePersistedState,
	persistedSlice,
} from "@/lib/persistence/persistedAppState";
import { ensureRemoteManagedAgentRuntime } from "@/lib/sessions/launch/remoteManagedAgentRuntime";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	PERSIST_VERSION,
	rehydrateAppStoreFromDurableStorage,
	useStore,
} from "@/store";
import type { Project, SshHostConfig } from "@/types";

const remote = vi.hoisted(() => ({
	create: vi.fn(),
	preflight: vi.fn(),
	trust: vi.fn(),
}));
vi.mock("@/lib/agents/remoteAccountOverlay", () => ({
	preflightRemoteAccountLaunch: remote.preflight,
}));
vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	remoteHmuxManagedCreateAdvance: remote.create,
	remoteHmuxKnownHostTrust: remote.trust,
}));

const project: Project = {
	id: "qa-project",
	name: "QA",
	path: "/qa",
	kind: "ssh",
	isRepo: true,
	sshHostId: "qa-host",
};
const host: SshHostConfig = {
	id: "qa-host",
	name: "QA",
	host: "example.test",
	port: 22,
	user: "qa",
	auth: "key",
	keyPath: "/tmp/qa-key",
};

beforeEach(async () => {
	vi.clearAllMocks();
	await durableAppStorage.flush();
	useStore.setState({
		providerLaunchDefaults: null,
		providerLaunchDefaultsBackend: null,
		providerLaunchDefaultsProfileId: null,
		providerLaunchDefaultsError: null,
		skipPermissions: {},
		legacySkipPermissions: undefined,
	});
	await durableAppStorage.transact(DURABLE_APP_STORE_NAME, () => ({
		value: {
			version: PERSIST_VERSION,
			state: persistedSlice({
				...normalizePersistedState({}),
				projects: [project],
				sshHosts: [host],
			}),
		},
		result: undefined,
	}));
	await rehydrateAppStoreFromDurableStorage();
	remote.preflight.mockResolvedValue(undefined);
	remote.trust.mockResolvedValue({
		schemaVersion: 1,
		hostId: host.id,
		hostKeyFingerprints: ["SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
	});
	// Capture the actual launch request without creating a runtime in unit QA.
	remote.create.mockRejectedValue(new Error("QA captured remote create"));
});

describe("SSH permissions after durable registration", () => {
	it.each([
		{ bypass: true, override: undefined, expected: true },
		{ bypass: false, override: undefined, expected: false },
		{ bypass: true, override: false, expected: false },
		{ bypass: false, override: true, expected: true },
	])(
		"preserves the backend default and explicit overrides: %j",
		async ({ bypass, override, expected }) => {
			const defaults = {
				schemaVersion: 1 as const,
				revision: 1,
				defaults: {
					codex: {
						permissionMode: bypass
							? ("bypass_approvals" as const)
							: ("require_approvals" as const),
					},
				},
				fingerprint: `sha256:${"a".repeat(64)}`,
			};
			useStore
				.getState()
				.applyProviderLaunchDefaultsProjection(
					defaults,
					{ id: "qa-backend", generation: "qa-generation" },
					"local",
				);
			const registered = await addAgent({
				projectId: project.id,
				name: "codex-ssh",
				provider: "codex",
				useWorktree: false,
				skipPermissions: override,
			});
			await expect(
				ensureRemoteManagedAgentRuntime(registered, { columns: 80, rows: 24 }),
			).rejects.toThrow("QA captured remote create");
			expect(remote.create).toHaveBeenCalledWith(
				expect.objectContaining({
					permissionMode: expected ? "bypass_approvals" : "default",
					command: expected
						? "codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false"
						: "codex -c check_for_update_on_startup=false",
				}),
			);
			expect(useStore.getState().skipPermissions.codex).toBe(bypass);
			expect(useStore.getState().providerLaunchDefaults).toEqual(defaults);
			expect(useStore.getState().legacySkipPermissions).toBeUndefined();
		},
	);
});
