import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	listConversations,
	providerConversationMetadata,
	readProviderConversationTranscript,
	sshListConversations,
} from "./conversations";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const credentialProfile = {
	referenceId: "account-work",
	directory: "/private/accounts/codex-work",
};

beforeEach(() => {
	invokeMock.mockReset().mockResolvedValue([]);
});

describe("conversation credential profile IPC", () => {
	it("batches exact provider title targets without frontend Agent ids", async () => {
		await providerConversationMetadata([
			{
				provider: "codex",
				conversationId: "conversation-1",
				cwd: "/repo",
				credentialProfile,
			},
		]);

		expect(invokeMock).toHaveBeenCalledWith("provider_conversation_metadata", {
			targets: [
				{
					provider: "codex",
					conversationId: "conversation-1",
					cwd: "/repo",
					credentialProfile,
				},
			],
		});
	});

	it("reads one exact provider transcript", async () => {
		await readProviderConversationTranscript("codex", "conversation-1");

		expect(invokeMock).toHaveBeenCalledWith(
			"read_provider_conversation_transcript",
			{
				provider: "codex",
				conversationId: "conversation-1",
			},
		);
	});

	it("passes the selected local profile as one typed value", async () => {
		await listConversations("/workspace", "codex", credentialProfile);

		expect(invokeMock).toHaveBeenCalledWith("list_conversations", {
			cwd: "/workspace",
			provider: "codex",
			credentialProfile,
		});
	});

	it("passes the selected remote profile without exposing an absolute path", async () => {
		const remoteProfile = {
			referenceId: "account-work",
			directory: ".dure/accounts/claude-work",
		};
		await sshListConversations({
			connectOpts: {
				host: "remote.test",
				user: "agent",
				port: 22,
			},
			cwd: "/workspace",
			provider: "claude",
			credentialProfile: remoteProfile,
		});

		expect(invokeMock).toHaveBeenCalledWith("ssh_list_conversations", {
			id: null,
			opts: {
				host: "remote.test",
				user: "agent",
				port: 22,
			},
			cwd: "/workspace",
			provider: "claude",
			credentialProfile: remoteProfile,
		});
	});

	it("sends the canonical provider default explicitly", async () => {
		await listConversations("/workspace", "codex");

		expect(invokeMock).toHaveBeenCalledWith("list_conversations", {
			cwd: "/workspace",
			provider: "codex",
			credentialProfile: null,
		});
	});
});
