#!/usr/bin/env node

import { createClaudeRelaySpawner } from "../../provider-drivers/claude/relay-spawned-process.mjs";
import { loadPinnedClaudeSdk } from "../../provider-drivers/claude/sdk-runtime.mjs";
import { fixtureClaudeExecutableIdentity } from "./claude-executable-identity.mjs";
import {
	readRetiredSdkHostIdentities,
	serveSharedSdkHostProcess,
	sharedSdkHostProcessArguments,
} from "../../provider-drivers/claude/shared-sdk-host-process.mjs";
import { startSharedClaudeSdkHostServer } from "../../provider-drivers/claude/shared-sdk-host-server.mjs";

function relayQueryFactory() {
	return async ({ binding, emit, signal, terminal }) => {
		if (!binding.process) throw new Error("claude_shared_sdk_host_fixture_process_missing");
		const abort = new AbortController();
		const abortFromHost = () => abort.abort(signal.reason);
		signal.addEventListener("abort", abortFromHost, { once: true });
		if (signal.aborted) abortFromHost();
		const diagnostics = [];
		const spawn = createClaudeRelaySpawner({
			endpoint: binding.process.relayEndpoint,
			identity: binding.identity,
			launchCapability: binding.process.relayCapability,
			onDiagnostic: (value) => diagnostics.push(value),
		});
		const child = spawn({
			args: binding.process.args,
			command: binding.process.command,
			commandIdentity: fixtureClaudeExecutableIdentity(binding.process.command),
			cwd: binding.cwd,
			env: binding.env,
			signal: abort.signal,
		});
		child.stdin.on("error", () => {});
		child.stdout.on("error", () => {});

		let pendingTurn;
		let terminalResult;
		const exited = new Promise((resolve) => {
			child.once("exit", (code, exitSignal) => {
				signal.removeEventListener("abort", abortFromHost);
				terminalResult = { code, signal: exitSignal };
				terminal(terminalResult);
				if (pendingTurn) {
					pendingTurn.reject(new Error("claude_shared_sdk_host_fixture_exit_during_turn"));
					pendingTurn = undefined;
				}
				resolve(terminalResult);
			});
			child.once("error", (error) => {
				signal.removeEventListener?.("abort", abortFromHost);
				terminalResult = { reason: "relay_transport_error" };
				terminal(terminalResult);
				if (pendingTurn) {
					pendingTurn.reject(error);
					pendingTurn = undefined;
				}
				resolve(terminalResult);
			});
		});
		child.stdout.on("data", (chunk) => {
			if (!pendingTurn) return;
			pendingTurn.received = Buffer.concat([pendingTurn.received, chunk]);
			if (pendingTurn.received.length < pendingTurn.expected.length) return;
			if (!pendingTurn.received.equals(pendingTurn.expected)) {
				pendingTurn.reject(new Error("claude_shared_sdk_host_fixture_output_mismatch"));
				pendingTurn = undefined;
				return;
			}
			emit("assistant_delta", { text: pendingTurn.received.toString("utf8") });
			pendingTurn.resolve({ diagnostics: diagnostics.length, stopReason: "end_turn" });
			pendingTurn = undefined;
		});

		return {
			async answerInteraction() {
				throw new Error("dure_claude_agent_sdk_interaction_stale");
			},
			async startTurn({ input }) {
				if (pendingTurn) throw new Error("claude_shared_sdk_host_fixture_turn_overlap");
				const expected = Buffer.from(input, "utf8");
				const completed = new Promise((resolve, reject) => {
					pendingTurn = { expected, received: Buffer.alloc(0), reject, resolve };
				});
				child.stdin.write(expected);
				return completed;
			},
			async close() {
				if (terminalResult) return terminalResult;
				child.stdin.end();
				return exited;
			},
			async invalidate() {
				if (terminalResult) return terminalResult;
				abort.abort();
				return exited;
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

const options = sharedSdkHostProcessArguments(process.argv.slice(2));
const sdk = await loadPinnedClaudeSdk();
const server = await startSharedClaudeSdkHostServer({
	capabilityFile: options.capabilityFile,
	createQuery: relayQueryFactory(),
	endpoint: options.endpoint,
	hostGeneration: options.hostGeneration,
	retiredIdentities: readRetiredSdkHostIdentities(options.retiredIdentitiesFile),
});
await serveSharedSdkHostProcess({ fixture: true, options, sdk, server });
