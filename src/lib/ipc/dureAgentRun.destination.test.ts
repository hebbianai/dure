import { describe, expect, it } from "vitest";
import { createDureAgentRunTransport } from "@/lib/ipc/dureAgentRun";
import { createAgentRunBackendFixture } from "@/test/dureAgentRunFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const request = {
	projectPath: "/repo",
	providerId: "claude" as const,
	agentName: "claude-1",
	worktree: { kind: "project_root" as const },
	idempotencyKey: "add-agent:project-repo:claude-1",
};
const routeAuthority = testDureBackendRouteAuthority(
	"dure-local",
	"generation-1",
);

describe("Dure Agent Run checkout destination", () => {
	it.each(["native_cli", "structured_protocol"] as const)(
		"projects a selected existing checkout for %s",
		async (interactionProfile) => {
			const reference = {
				canonicalPath: "/repo/preexisting-checkout",
				gitCommonDir: "/repo/.git",
				gitDir: "/repo/.git/worktrees/preexisting-checkout",
				branch: "user/work",
				head: "a".repeat(40),
			};
			const fixture = createAgentRunBackendFixture({ interactionProfile });
			const transport = createDureAgentRunTransport({
				invokeCommand: fixture.invokeCommand,
			});
			const run = await transport.run(
				{ ...request, worktree: { kind: "existing_checkout", reference } },
				routeAuthority,
			);
			expect(run.worktree).toEqual({
				kind: "existing_checkout",
				branch: reference.branch,
				rootPath: reference.canonicalPath,
			});
			expect(run.providerConversationRef).toBeNull();
			expect(fixture.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]);
		},
	);

	it.each(["native_cli", "structured_protocol"] as const)(
		"projects the actual checkout destination from a %s receipt",
		async (interactionProfile) => {
			const rootPath = "/canonical/custom/claude-1";
			const fixture = createAgentRunBackendFixture({
				interactionProfile,
				checkoutRoot: rootPath,
			});
			const calls: unknown[] = [];
			const transport = createDureAgentRunTransport({
				invokeCommand: (command, args) => {
					calls.push(args.body);
					return fixture.invokeCommand(command, args);
				},
			});
			const result = await transport.run(
				{
					...request,
					worktree: {
						kind: "dedicated",
						branch: "agent/claude-1",
						baseCommitSha: "a".repeat(40),
						branchMode: "existing",
						checkoutPath: "/selected/custom/claude-1",
					},
				},
				routeAuthority,
			);
			expect(calls[0]).toMatchObject({
				worktree: {
					checkout_path: "/selected/custom/claude-1",
					branch_mode: "existing",
				},
			});
			expect(result.worktree).toEqual({
				kind: "dedicated",
				branch: "agent/claude-1",
				directoryName: "claude-1",
				rootPath,
			});
		},
	);
});
