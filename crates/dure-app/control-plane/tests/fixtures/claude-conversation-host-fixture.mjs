#!/usr/bin/env node

import { loadPinnedClaudeSdk } from "../../provider-drivers/claude/sdk-runtime.mjs";
import {
	readRetiredSdkHostIdentities,
	serveSharedSdkHostProcess,
	sharedSdkHostProcessArguments,
} from "../../provider-drivers/claude/shared-sdk-host-process.mjs";
import { startSharedClaudeSdkHostServer } from "../../provider-drivers/claude/shared-sdk-host-server.mjs";

function queryFactory() {
	return async ({ binding, emit, signal, terminal }) => {
		const selected = binding.identity.runtimeGeneration.endsWith("-1");
		if (
			binding.permissionMode !== (selected ? "skip_permissions" : "default") ||
			binding.model !== (selected ? "claude-opus-4-1" : null) ||
			binding.effort !== (selected ? "xhigh" : null)
		) {
			throw new Error("claude_conversation_host_fixture_launch_options_mismatch");
		}
		emit("provider_event", { subtype: "bind_fixture", type: "system" });
		let closed = false;
		const close = () => {
			if (closed) return { code: 0, signal: null };
			closed = true;
			const result = { code: 0, signal: null };
			terminal(result);
			return result;
		};
		signal.addEventListener("abort", close, { once: true });
		return {
			async answerInteraction() {
				throw new Error("dure_claude_agent_sdk_interaction_stale");
			},
			async startTurn({ clientMessageId, input }) {
				const providerMessageId = `provider-${clientMessageId}`;
				emit("assistant_delta", {
					blockIndex: 0,
					finalFragment: true,
					parentToolUseId: null,
					providerMessageId,
					text: input,
				});
				emit("assistant_message_completed", {
					blockCount: 1,
					error: null,
					parentToolUseId: null,
					providerMessageId,
					providerSessionId: `session-${clientMessageId}`,
				});
				return { clientMessageId, stopReason: "end_turn" };
			},
			async close() {
				return close();
			},
			async invalidate() {
				return close();
			},
			async interruptTurn() {
				return {
					cancelledMessageIds: [],
					receiptAvailable: false,
					stillQueuedMessageIds: [],
				};
			},
			pendingInteractionCount() {
				return 0;
			},
			pendingInteractions() {
				return [];
			},
		};
	};
}

function historyReader() {
	return async (binding) => {
		if (binding.env.DURE_TEST_HISTORY_INCOMPLETE === "1") {
			return { reason: "history_unavailable", status: "incomplete" };
		}
		if (binding.providerSessionId === null) {
			return { reason: "history_unavailable", status: "incomplete" };
		}
		return {
			status: "complete",
			items: [
				{
					body: { markdown: "prior question", role: "user", type: "message" },
					createdAtMs: 0,
					providerMessageId: null,
					sourceId: "fixture-history-user:message:0",
				},
				{
					body: { markdown: "prior answer", role: "assistant", type: "message" },
					createdAtMs: 0,
					providerMessageId: "fixture-history-assistant-message",
					sourceId: "fixture-history-assistant:message:0",
				},
			],
		};
	};
}

const options = sharedSdkHostProcessArguments(process.argv.slice(2));
const sdk = await loadPinnedClaudeSdk();
const server = await startSharedClaudeSdkHostServer({
	capabilityFile: options.capabilityFile,
	createQuery: queryFactory(),
	endpoint: options.endpoint,
	hostGeneration: options.hostGeneration,
	readHistory: historyReader(),
	retiredIdentities: readRetiredSdkHostIdentities(options.retiredIdentitiesFile),
});
await serveSharedSdkHostProcess({ fixture: true, options, sdk, server });
