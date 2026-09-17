import { describe, expect, it } from "vitest";
import { managedProviderCommand } from "@/lib/sessions/managed/managedProviderCommand";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

function managedAgent(patch: Partial<Agent> = {}): Agent {
	return agentFixture({
		id: "agent-target",
		name: "document-manager",
		worktreePath: "/repo/.worktrees/document-manager",
		branch: "agent/document-manager",
		sessionId: "session-target",
		runtimeBinding: managedBindingFixture({
			sessionId: "session-target",
			workspaceId: "project-1",
			createIdempotencyKey: undefined,
		}),
		...patch,
	});
}

describe("managedProviderCommand", () => {
	it("resumes only one exact persisted conversation", () => {
		expect(
			managedProviderCommand(
				managedAgent({
					started: true,
					conversationId: "conversation-exact",
				}),
			),
		).toBe(
			"codex -c check_for_update_on_startup=false resume conversation-exact",
		);
	});

	it("never selects another pane's last conversation", () => {
		const otherPane = managedAgent({
			id: "agent-other",
			conversationId: "conversation-other",
		});
		const targetPane = managedAgent({ started: true });

		expect(managedProviderCommand(otherPane)).toBe(
			"codex -c check_for_update_on_startup=false resume conversation-other",
		);
		expect(managedProviderCommand(targetPane)).toBe(
			"codex -c check_for_update_on_startup=false",
		);
		expect(managedProviderCommand(targetPane)).not.toContain("--last");
	});

	it("resumes the exact Qwen conversation without changing the agent", () => {
		const agent = managedAgent({
			provider: "qwen-code",
			conversationId: "conversation-exact",
		});
		const before = structuredClone(agent);
		expect(managedProviderCommand(agent)).toBe("qwen --resume conversation-exact");
		expect(agent).toEqual(before);
	});

	it.each(["continue"] as const)(
		"refuses an exact %s conversation without a resume adapter",
		(provider) => {
			const agent = managedAgent({
				provider,
				conversationId: "conversation-exact",
			});
			const before = structuredClone(agent);
			expect(() => managedProviderCommand(agent)).toThrowError(
				expect.objectContaining({ code: "explicit_resume_unsupported", provider }),
			);
			expect(agent).toEqual(before);
		},
	);
});
