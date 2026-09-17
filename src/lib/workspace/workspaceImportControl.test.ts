import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applyWorkspaceImportPlan,
	clearWorkspaceImportPlansForTest,
	createWorkspaceImportPreview,
	defaultWorkspaceImportDraft,
	discoverWorkspaceImportDraftProgressively,
} from "@/lib/workspace/workspaceImportControl";
import type { ProviderConversationDiscoverySnapshot } from "@/lib/agents/providerConversationDiscovery";

const mocks = vi.hoisted(() => ({
	apply: vi.fn(),
	list: vi.fn(),
	discover: vi.fn(),
}));

vi.mock("@/lib/onboarding/onboardingImportApply", () => ({
	applyOnboardingImportDraft: mocks.apply,
}));
vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	listProviderConversations: mocks.list,
	discoverProviderConversationsProgressively: mocks.discover,
}));

afterEach(() => {
	clearWorkspaceImportPlansForTest();
	vi.clearAllMocks();
});

const session = {
	provider: "codex" as const,
	id: "conversation-one",
	cwd: "/repo",
	title: "One",
	mtime: Math.floor(Date.now() / 1000),
	resumeCapability: "exact" as const,
	executionLocation: "local" as const,
	repositoryRoot: "/repo",
};

describe("workspace import control", () => {
	it("projects successful source keys as refresh authority", async () => {
		mocks.discover.mockImplementation(
			async (
				_hosts: readonly unknown[],
				onUpdate: (snapshot: ProviderConversationDiscoverySnapshot) => void,
			) => {
				const snapshot: ProviderConversationDiscoverySnapshot = {
					records: [session],
					sources: [
						{
							key: "local",
							kind: "local",
							status: "succeeded",
							count: 1,
						},
						{
							key: "ssh:offline",
							kind: "ssh",
							status: "failed",
							count: 0,
						},
					],
					complete: true,
				};
				onUpdate(snapshot);
				return snapshot;
			},
		);
		const updates: Parameters<
			Parameters<typeof discoverWorkspaceImportDraftProgressively>[0]
		>[0][] = [];

		await discoverWorkspaceImportDraftProgressively((update) =>
			updates.push(update),
		);

		expect(updates).toHaveLength(1);
		expect(updates[0].authoritativeSourceKeys).toEqual(["local"]);
		expect(updates[0].draft.discoveredCount).toBe(1);
	});

	it("builds the same default draft used by onboarding", () => {
		const draft = defaultWorkspaceImportDraft([session]);
		expect(draft.discoveredCount).toBe(1);
		expect(draft.desktops[0].panes[0]).toMatchObject({
			conversationId: "conversation-one",
			selected: true,
		});
	});

	it("applies only the exact cached preview token and expires it after success", async () => {
		mocks.list.mockResolvedValue([session]);
		mocks.apply.mockResolvedValue({
			projectIds: ["project-1"],
			desktopIds: ["desktop-1"],
			agentIds: ["agent-1"],
			committedAtMs: 200,
		});
		const preview = await createWorkspaceImportPreview(100);

		await expect(applyWorkspaceImportPlan(preview.planToken, 101)).resolves.toMatchObject({
			agentIds: ["agent-1"],
		});
		expect(mocks.apply).toHaveBeenCalledWith(preview.draft);
		await expect(applyWorkspaceImportPlan(preview.planToken, 102)).rejects.toThrow(
			"missing or expired",
		);
	});
});
