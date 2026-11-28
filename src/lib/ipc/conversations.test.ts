import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	followProviderConversationTranscript,
	listConversations,
	providerConversationMetadata,
	readProviderConversationTranscript,
	sshListConversations,
} from "./conversations";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
	Channel: class {
		onmessage: (message: unknown) => void = () => {};
	},
}));

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

	it("asks for the tool calls only when the caller does", async () => {
		await readProviderConversationTranscript("claude", "conversation-1", {
			includeTools: true,
		});

		expect(invokeMock).toHaveBeenCalledWith(
			"read_provider_conversation_transcript",
			{
				provider: "claude",
				conversationId: "conversation-1",
				includeTools: true,
			},
		);
	});

	it("asks for the older page that ends at an earlier read's cursor", async () => {
		await readProviderConversationTranscript("claude", "conversation-1", {
			includeTools: true,
			before: 4096,
		});

		expect(invokeMock).toHaveBeenCalledWith(
			"read_provider_conversation_transcript",
			{
				provider: "claude",
				conversationId: "conversation-1",
				includeTools: true,
				before: 4096,
			},
		);
	});

	it("asks for what was appended since an earlier read's newer cursor", async () => {
		await readProviderConversationTranscript("claude", "conversation-1", {
			includeTools: true,
			after: 8192,
		});

		expect(invokeMock).toHaveBeenCalledWith(
			"read_provider_conversation_transcript",
			{
				provider: "claude",
				conversationId: "conversation-1",
				includeTools: true,
				after: 8192,
			},
		);
	});

	it("follows a transcript's changes until the follow ends", async () => {
		invokeMock.mockResolvedValueOnce(7);
		const onChange = vi.fn();
		const end = await followProviderConversationTranscript(
			"claude",
			"conversation-1",
			onChange,
		);
		const [, request] = invokeMock.mock.calls[0] as [
			string,
			{ onChange: { onmessage(message: unknown): void } },
		];
		expect(invokeMock).toHaveBeenCalledWith(
			"follow_provider_conversation_transcript",
			{
				provider: "claude",
				conversationId: "conversation-1",
				onChange: request.onChange,
			},
		);
		request.onChange.onmessage(null);
		expect(onChange).toHaveBeenCalledTimes(1);

		invokeMock.mockResolvedValueOnce(undefined);
		end();
		expect(invokeMock).toHaveBeenLastCalledWith(
			"unfollow_provider_conversation_transcript",
			{ followId: 7 },
		);
		request.onChange.onmessage(null);
		expect(onChange).toHaveBeenCalledTimes(1);
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
