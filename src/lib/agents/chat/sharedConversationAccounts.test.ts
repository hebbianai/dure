import { beforeEach, expect, it, vi } from "vitest";
import type { AgentInteractionBindingV1 } from "@/lib/agents/chat/agentConversationContract";
import type { SharedAgentConversationTarget } from "@/lib/agents/chat/sharedAgentConversation";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { AccountProfile } from "@/types";
import {
	sharedConversationAccounts,
	switchSharedConversationAccount,
} from "./sharedConversationAccounts";

const mocks = vi.hoisted(() => ({
	inspect: vi.fn(),
	transition: vi.fn(),
	get: vi.fn(),
	register: vi.fn(),
	client: vi.fn(),
	recovery: vi.fn(),
}));
vi.mock("@/lib/ipc/dureAgentRuntime", () => ({
	createDureAgentRuntimeClient: mocks.client,
}));
vi.mock("@/lib/ipc/dureAccountRecovery", () => ({
	createAccountRecoveryClient: mocks.recovery,
}));
vi.mock("@/lib/ipc/dureProviderCredentialProfile", () => ({
	registerDureProviderCredentialProfile: mocks.register,
}));
const target: SharedAgentConversationTarget = {
	agentId: "shared-agent",
	authority: testDureBackendRouteAuthority("team", "generation", "team"),
	profile: {
		schemaVersion: 1,
		kind: "structured_protocol",
		backendProfileId: "team",
		interactionSessionId: "conversation",
	},
};
const binding: AgentInteractionBindingV1 = {
	schemaVersion: 1,
	agentId: target.agentId,
	interactionSessionId: "conversation",
	providerId: "codex",
	executionProfile: { kind: "provider_default" },
	providerConversationRef: "provider-conversation",
	runtime: { runtimeGeneration: "runtime", providerEpoch: "provider" },
	timelineEpoch: "timeline",
	bindingRevision: 1,
	historyComplete: true,
	createdAtMs: 1,
	updatedAtMs: 1,
};
const personal: AccountProfile = {
	id: "work",
	name: "Personal Work",
	provider: "codex",
	dir: "/accounts/codex-work",
};
const serverProfile = {
	schemaVersion: 1,
	providerId: "codex",
	referenceId: "work",
	credentialGeneration: "server-credential",
};
function source() {
	return {
		state: "stable",
		agentId: target.agentId,
		providerId: "codex",
		interactionProfile: "structured_protocol",
		interactionSessionId: binding.interactionSessionId,
		providerConversationRef: binding.providerConversationRef,
		routeAuthority: target.authority,
		selectionRevision: 4,
		executionProfile: binding.executionProfile,
		binding,
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.client.mockReturnValue({
		inspectExact: mocks.inspect,
		transition: mocks.transition,
	});
	mocks.recovery.mockReturnValue({ get: mocks.get });
	mocks.inspect.mockResolvedValue(source());
	mocks.get.mockResolvedValue({
		profiles: [serverProfile],
		policy: { accounts: [{ profile: serverProfile, name: "Team Work" }] },
		routeAuthority: target.authority,
	});
	mocks.transition.mockImplementation(async (request) => ({
		...source(),
		interactionSessionId: "replacement",
		executionProfile: request.targetExecutionProfile,
	}));
	mocks.register.mockResolvedValue({
		kind: "credential_reference",
		reference_id: "work",
		credential_generation: "local-credential",
	});
});
it("offers server credentials without leaking same-named personal accounts on SSH", async () => {
	expect(
		await sharedConversationAccounts(target, "codex", [
			personal,
			{ ...personal, id: "private" },
		]),
	).toEqual([{ id: "work", name: "Team Work" }]);
	expect(mocks.get).toHaveBeenCalledWith("codex", target.authority);
	expect(mocks.register).not.toHaveBeenCalled();
});
it("includes personal accounts only on the selected local server", async () => {
	const local = {
		...target,
		authority: testDureBackendRouteAuthority("local", "generation"),
	};
	expect(
		await sharedConversationAccounts(local, "codex", [
			personal,
			{ ...personal, id: "other-provider", provider: "claude" },
		]),
	).toEqual([{ id: "work", name: "Personal Work" }]);
});
it("switches the exact shared conversation using the server's current credential generation", async () => {
	const result = await switchSharedConversationAccount(
		target,
		binding,
		"work",
		[personal],
	);
	expect(result.interactionSessionId).toBe("replacement");
	expect(mocks.client).toHaveBeenCalledWith({ profileId: "team" });
	expect(mocks.inspect).toHaveBeenCalledWith(target.agentId, target.authority);
	expect(mocks.transition).toHaveBeenCalledWith({
		agentId: target.agentId,
		expectedSourceRevision: 4,
		targetInteractionProfile: "structured_protocol",
		sourceStopPolicy: "preserve",
		routeAuthority: target.authority,
		targetExecutionProfile: {
			kind: "credential_reference",
			reference_id: "work",
			credential_generation: "server-credential",
		},
	});
	expect(mocks.register).not.toHaveBeenCalled();
});
it.each([
	{ interactionSessionId: "other-conversation" },
	{ providerConversationRef: "other-provider-conversation" },
	{
		binding: {
			...binding,
			runtime: { ...binding.runtime, runtimeGeneration: "new-runtime" },
		},
	},
	{
		routeAuthority: testDureBackendRouteAuthority(
			"other-server",
			"generation",
			"team",
		),
	},
	{ state: "transitioning" },
])(
	"rejects a changed source before preparing or switching an account: %j",
	async (change) => {
		mocks.inspect.mockResolvedValue({ ...source(), ...change });
		await expect(
			switchSharedConversationAccount(target, binding, "work", [personal]),
		).rejects.toThrow();
		expect(mocks.get).not.toHaveBeenCalled();
		expect(mocks.register).not.toHaveBeenCalled();
		expect(mocks.transition).not.toHaveBeenCalled();
	},
);
it("never provisions a missing personal account onto a remote server", async () => {
	mocks.get.mockResolvedValue({ profiles: [], policy: null });
	await expect(
		switchSharedConversationAccount(target, binding, "work", [personal]),
	).rejects.toThrow();
	expect(mocks.register).not.toHaveBeenCalled();
	expect(mocks.transition).not.toHaveBeenCalled();
});
it("registers a selected local account against the exact local route", async () => {
	const local = {
		...target,
		authority: testDureBackendRouteAuthority("local", "generation"),
	};
	mocks.inspect.mockResolvedValue({
		...source(),
		routeAuthority: local.authority,
	});
	mocks.transition.mockImplementation(async (request) => ({
		...source(),
		routeAuthority: local.authority,
		executionProfile: request.targetExecutionProfile,
	}));
	await switchSharedConversationAccount(local, binding, "work", [personal]);
	expect(mocks.register).toHaveBeenCalledWith(
		{
			providerId: "codex",
			referenceId: "work",
			profileDirectoryName: "codex-work",
		},
		{ profileId: "local", routeAuthority: local.authority },
	);
});
it("allows the server default and propagates an uncertain transition without retrying", async () => {
	mocks.transition.mockRejectedValue(new Error("response lost"));
	await expect(
		switchSharedConversationAccount(target, binding, null, []),
	).rejects.toThrow("response lost");
	expect(mocks.transition).toHaveBeenCalledTimes(1);
	expect(mocks.transition.mock.calls[0][0].targetExecutionProfile).toEqual({
		kind: "provider_default",
	});
	expect(mocks.get).not.toHaveBeenCalled();
});
