import { describe, expect, it } from "vitest";
import { supportsCanonicalAddAgentRun } from "@/lib/agents/addAgentCanonicalRun";
import { repositoryQuickAgentPolicy } from "@/lib/spaces/repositoryQuickAgentLaunch";
import type { AccountProfile, Project } from "@/types";

const LOCAL: Project = {
	id: "p1",
	name: "Dure",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

const REMOTE: Project = {
	id: "p2",
	name: "Remote",
	path: "/srv/repo",
	kind: "ssh",
	sshHostId: "h1",
	isRepo: true,
};

const ACCOUNT: AccountProfile = {
	id: "acc-1",
	provider: "claude",
	name: "work",
	dir: "work",
};

describe("repositoryQuickAgentPolicy", () => {
	it("runs in the repository checkout with no worktree or setup", () => {
		const policy = repositoryQuickAgentPolicy({
			project: LOCAL,
			provider: "claude",
			actionId: "quick-add-1",
			agentName: "claude-2",
			accounts: [],
		});
		expect(policy).toMatchObject({
			project: LOCAL,
			provider: "claude",
			actionId: "quick-add-1",
			agentName: "claude-2",
			accountId: null,
			useWorktree: false,
			setupCommand: null,
		});
		expect(policy).not.toHaveProperty("account");
		// Pro mode passes no preference — the provider default must stay
		// untouched, so the key is absent rather than undefined-on-the-wire.
		expect(policy).not.toHaveProperty("interactionPreference");
		// The canonical runner accepts it — quick-add never needs its own spawn.
		expect(supportsCanonicalAddAgentRun(policy)).toBe(true);
	});

	it("forwards the basic-mode PTY pin into the canonical policy", () => {
		const policy = repositoryQuickAgentPolicy({
			project: LOCAL,
			provider: "claude",
			actionId: "quick-add-basic-1",
			agentName: "claude-2",
			accounts: [],
			interactionPreference: "native_cli",
		});
		expect(policy.interactionPreference).toBe("native_cli");
		expect(supportsCanonicalAddAgentRun(policy)).toBe(true);
	});

	it("carries the provider's active account, profile included", () => {
		const policy = repositoryQuickAgentPolicy({
			project: LOCAL,
			provider: "claude",
			actionId: "quick-add-2",
			agentName: "claude-2",
			accounts: [ACCOUNT],
			activeAccountId: "acc-1",
		});
		expect(policy.accountId).toBe("acc-1");
		expect(policy.account).toBe(ACCOUNT);
	});

	/** An account belonging to another provider is not this launch's — the
	 *  policy falls back to the provider default rather than launching under a
	 *  credential the user never selected for it. */
	it("ignores an active account that is not this provider's", () => {
		const policy = repositoryQuickAgentPolicy({
			project: LOCAL,
			provider: "codex",
			actionId: "quick-add-3",
			agentName: "codex-1",
			accounts: [ACCOUNT],
			activeAccountId: "acc-1",
		});
		expect(policy.accountId).toBeNull();
		expect(policy).not.toHaveProperty("account");
	});

	/** Remote repositories have no canonical run yet: the caller must fall
	 *  back to the dialog, and `launchRepositoryQuickAgent` reports that by
	 *  refusing this exact policy. */
	it("is not runnable for a remote repository", () => {
		const policy = repositoryQuickAgentPolicy({
			project: REMOTE,
			provider: "claude",
			actionId: "quick-add-4",
			agentName: "claude-1",
			accounts: [],
		});
		expect(supportsCanonicalAddAgentRun(policy)).toBe(false);
	});
});
