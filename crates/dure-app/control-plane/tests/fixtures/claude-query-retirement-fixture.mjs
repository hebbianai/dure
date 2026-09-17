#!/usr/bin/env node

import fs from "node:fs";

import {
	readRetiredSdkHostIdentities,
	serveSharedSdkHostProcess,
	sharedSdkHostProcessArguments,
} from "../../provider-drivers/claude/shared-sdk-host-process.mjs";
import { startSharedClaudeSdkHostServer } from "../../provider-drivers/claude/shared-sdk-host-server.mjs";

function recordClose() {
	const target = process.env.DURE_QUERY_CLOSE_COUNT_FILE;
	if (target) fs.appendFileSync(target, "x", { mode: 0o600 });
}

function queryFactory() {
	return async ({ signal, terminal }) => {
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			recordClose();
			terminal({ code: 0, signal: null });
		};
		signal.addEventListener("abort", close, { once: true });
		return {
			async answerInteraction() {
				throw new Error("dure_claude_agent_sdk_interaction_stale");
			},
			async close() {
				close();
			},
			async interruptTurn() {
				return {
					cancelledMessageIds: [],
					receiptAvailable: false,
					stillQueuedMessageIds: [],
				};
			},
			async invalidate() {
				close();
			},
			pendingInteractionCount() {
				return 0;
			},
			pendingInteractions() {
				return [];
			},
			async startTurn() {
				return { stopReason: "end_turn" };
			},
		};
	};
}

const options = sharedSdkHostProcessArguments(process.argv.slice(2));
const server = await startSharedClaudeSdkHostServer({
	capabilityFile: options.capabilityFile,
	createQuery: queryFactory(),
	endpoint: options.endpoint,
	hostGeneration: options.hostGeneration,
	retiredIdentities: readRetiredSdkHostIdentities(options.retiredIdentitiesFile),
});
await serveSharedSdkHostProcess({
	fixture: true,
	options,
	sdk: { fixture: "query-retirement" },
	server,
});
