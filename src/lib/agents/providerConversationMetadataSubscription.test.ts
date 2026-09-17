import { afterEach, describe, expect, it, vi } from "vitest";
import { installProviderConversationMetadataRuntime } from "@/lib/agents/providerConversationMetadataRuntime";
import * as conversations from "@/lib/ipc/conversations";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import type { AccountProfile } from "@/types";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("native conversation metadata subscription", () => {
	it.each([false, true])(
		"ignores presentation changes with an in-flight read: %s",
		async (inflight) => {
			const previous = useStore.getState();
			const agent = managedAgentFixture({
				id: "metadata-subscription",
				provider: "codex",
				conversationId: "thread-1",
				credentialId: "profile-1",
			});
			const accounts: AccountProfile[] = ["profile-1", "profile-2"].map(
				(id) => ({
					id,
					provider: "codex",
					name: id,
					dir: `/profiles/${id}`,
				}),
			);
			let release: (value: []) => void = () => undefined;
			const load = vi
				.spyOn(conversations, "providerConversationMetadata")
				.mockResolvedValue([]);
			if (inflight) {
				load.mockImplementationOnce(
					() =>
						new Promise<[]>((resolve) => {
							release = resolve;
						}),
				);
			}
			const intervals: Array<() => void> = [];
			vi.stubGlobal(
				"setInterval",
				vi.fn((callback: () => void) => {
					intervals.push(callback);
					return 42;
				}),
			);
			vi.stubGlobal("clearInterval", vi.fn());
			useStore.setState({ agents: [agent], accounts, sshHosts: [] });
			const stop = installProviderConversationMetadataRuntime();
			try {
				await settle();
				expect(load).toHaveBeenCalledOnce();
				for (let index = 0; index < 10; index++) {
					useStore.setState({
						agents: [{ ...agent, name: `Display ${index}` }],
					});
				}
				release([]);
				await settle();
				expect(load).toHaveBeenCalledOnce();

				// Actual lookup identity changes still invalidate immediately.
				let updated = agent;
				for (const [index, change] of [
					{ conversationId: "thread-2" },
					{ worktreePath: "/repo/moved" },
					{ credentialId: "profile-2" },
				].entries()) {
					updated = { ...updated, ...change };
					useStore.setState({ agents: [updated] });
					await settle();
					expect(load).toHaveBeenCalledTimes(index + 2);
					expect(load.mock.lastCall?.[0][0]).toMatchObject({
						conversationId: updated.conversationId,
						cwd: updated.worktreePath,
						credentialProfile: { referenceId: updated.credentialId },
					});
				}

				// Files can change without a store event; retain the existing backstop.
				for (const refresh of intervals) refresh();
				await settle();
				expect(load).toHaveBeenCalledTimes(5);

				useStore.setState({ accounts: [...useStore.getState().accounts] });
				await settle();
				expect(load).toHaveBeenCalledTimes(6);
				useStore.setState({ sshHosts: [...useStore.getState().sshHosts] });
				await settle();
				expect(load).toHaveBeenCalledTimes(7);
			} finally {
				stop();
				useStore.setState(previous, true);
			}
		},
	);
});
