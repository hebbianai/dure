import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	createClaudeAgentSdkHistoryReader,
	normalizeClaudeHistoryMessages,
} from "./agent-sdk-history.mjs";
import { loadPinnedClaudeSdkRuntime } from "./sdk-runtime.mjs";

function sdkMessage({ content, parentUuid, role, sessionId, timestamp, uuid }) {
	return {
		cwd: "/workspace/history",
		message:
			role === "assistant"
				? { content, id: `msg-${uuid}`, role }
				: { content, role },
		parentUuid,
		sessionId,
		timestamp,
		type: role,
		uuid,
	};
}

test("normalization preserves provider IDs and canonical tool wire fields", () => {
	const sessionId = "11111111-1111-4111-8111-111111111111";
	const messages = [
		{
			type: "assistant",
			uuid: "22222222-2222-4222-8222-222222222222",
			session_id: sessionId,
			parent_tool_use_id: null,
			message: {
				id: "provider-message-1",
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "consider" },
					{ type: "tool_use", id: "tool-call-1", name: "Read", input: { path: "a" } },
				],
			},
		},
		{
			type: "user",
			uuid: "33333333-3333-4333-8333-333333333333",
			session_id: sessionId,
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "tool-call-1", content: "done" },
				],
			},
		},
	];
	const history = normalizeClaudeHistoryMessages(
		messages,
		{ cwd: "/workspace/history", providerSessionId: sessionId },
		new Map([[messages[0].uuid, 12]]),
	);
	assert.equal(history.status, "complete");
	assert.equal(history.items[0].createdAtMs, 12);
	assert.equal(history.items[0].providerMessageId, "provider-message-1");
	assert.deepEqual(history.items[1].body, {
		input: { path: "a" },
		name: "Read",
		state: "running",
		tool_call_id: "tool-call-1",
		type: "tool",
	});
	assert.deepEqual(history.items[2].body, {
		input: { path: "a" },
		name: "Read",
		output: "done",
		state: "completed",
		tool_call_id: "tool-call-1",
		type: "tool",
	});
});

test("the pinned SDK reads concurrent exact profiles without ambient credential state", async () => {
	const { getSessionMessages } = await loadPinnedClaudeSdkRuntime();
	const root = await mkdtemp(path.join(os.tmpdir(), "dure-history-profiles-"));
	const priorConfig = process.env.CLAUDE_CONFIG_DIR;
	try {
		process.env.CLAUDE_CONFIG_DIR = path.join(root, "ambient-poison");
		const fixtures = [
			{
				cwd: "/workspace/profile-a",
				projectKey: "-workspace-profile-a",
				root: path.join(root, "profile-a"),
				sessionId: "11111111-1111-4111-8111-111111111111",
				text: "profile a",
				uuid: "22222222-2222-4222-8222-222222222222",
			},
			{
				cwd: "/workspace/profile-b",
				projectKey: "-workspace-profile-b",
				root: path.join(root, "profile-b"),
				sessionId: "33333333-3333-4333-8333-333333333333",
				text: "profile b",
				uuid: "44444444-4444-4444-8444-444444444444",
			},
		];
		for (const fixture of fixtures) {
			const directory = path.join(fixture.root, "projects", fixture.projectKey);
			await mkdir(directory, { recursive: true });
			await writeFile(
				path.join(directory, `${fixture.sessionId}.jsonl`),
				`${JSON.stringify(
					sdkMessage({
						content: fixture.text,
						parentUuid: null,
						role: "user",
						sessionId: fixture.sessionId,
						timestamp: "2026-01-02T03:04:05.000Z",
						uuid: fixture.uuid,
					}),
				)}\n`,
			);
		}

		const reader = createClaudeAgentSdkHistoryReader({ getSessionMessages });
		const results = await Promise.all(
			fixtures.map((fixture) =>
				reader({
					cwd: fixture.cwd,
					env: { CLAUDE_CONFIG_DIR: fixture.root, HOME: path.join(root, "wrong-home") },
					providerSessionId: fixture.sessionId,
				}),
			),
		);
		for (let index = 0; index < fixtures.length; index += 1) {
			assert.equal(results[index].status, "complete");
			assert.equal(results[index].items[0].body.markdown, fixtures[index].text);
			assert.equal(results[index].items[0].createdAtMs, 1_767_323_045_000);
		}
	} finally {
		if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = priorConfig;
		await rm(root, { recursive: true, force: true });
	}
});

test("a large provider transcript hydrates without making Chat attachment size-dependent", async () => {
	const { getSessionMessages } = await loadPinnedClaudeSdkRuntime();
	const root = await mkdtemp(path.join(os.tmpdir(), "dure-history-large-"));
	const cwd = "/workspace/large-history";
	const projectKey = "-workspace-large-history";
	const sessionId = "11111111-1111-4111-8111-111111111111";
	try {
		const directory = path.join(root, "projects", projectKey);
		await mkdir(directory, { recursive: true });
		const messages = [];
		let parentUuid = null;
		for (let index = 0; index < 1_340; index += 1) {
			const uuid = `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;
			messages.push(
				sdkMessage({
					content:
						index % 2 === 0
							? `message ${index}`
							: [{ text: `message ${index}`, type: "text" }],
					parentUuid,
					role: index % 2 === 0 ? "user" : "assistant",
					sessionId,
					timestamp: "2026-01-02T03:04:05.000Z",
					uuid,
				}),
			);
			parentUuid = uuid;
		}
		await writeFile(
			path.join(directory, `${sessionId}.jsonl`),
			`${JSON.stringify({ payload: "x".repeat(5 * 1024 * 1024), type: "file-history-snapshot" })}\n${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
		);

		const reader = createClaudeAgentSdkHistoryReader({ getSessionMessages });
		const history = await reader({
			cwd,
			env: { CLAUDE_CONFIG_DIR: root },
			providerSessionId: sessionId,
		});

		assert.equal(history.status, "complete", history.reason);
		assert.equal(history.items.length, messages.length);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an invalid explicit config root never falls back to HOME", async () => {
	let called = false;
	const reader = createClaudeAgentSdkHistoryReader({
		getSessionMessages: async () => {
			called = true;
			return [];
		},
	});
	const result = await reader({
		cwd: "/workspace/history",
		env: { CLAUDE_CONFIG_DIR: "relative", HOME: "/would-be-wrong-profile" },
		providerSessionId: "11111111-1111-4111-8111-111111111111",
	});
	assert.deepEqual(result, { reason: "history_identity_invalid", status: "incomplete" });
	assert.equal(called, false);
});

test("an exact present-empty transcript completes while a missing transcript stays incomplete", async () => {
	const { getSessionMessages } = await loadPinnedClaudeSdkRuntime();
	const root = await mkdtemp(path.join(os.tmpdir(), "dure-history-empty-"));
	const cwd = "/workspace/empty-history";
	const projectKey = "-workspace-empty-history";
	const presentSessionId = "11111111-1111-4111-8111-111111111111";
	const missingSessionId = "22222222-2222-4222-8222-222222222222";
	const corruptSessionId = "33333333-3333-4333-8333-333333333333";
	try {
		const directory = path.join(root, "projects", projectKey);
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, `${presentSessionId}.jsonl`), "");
		await writeFile(path.join(directory, `${corruptSessionId}.jsonl`), Buffer.from([0xff]));
		const reader = createClaudeAgentSdkHistoryReader({ getSessionMessages });
		assert.deepEqual(
			await reader({
				cwd,
				env: { CLAUDE_CONFIG_DIR: root },
				providerSessionId: presentSessionId,
			}),
			{ items: [], status: "complete" },
		);
		assert.deepEqual(
			await reader({
				cwd,
				env: { CLAUDE_CONFIG_DIR: root },
				providerSessionId: missingSessionId,
			}),
			{ reason: "history_unavailable", status: "incomplete" },
		);
		assert.deepEqual(
			await reader({
				cwd,
				env: { CLAUDE_CONFIG_DIR: root },
				providerSessionId: corruptSessionId,
			}),
			{ reason: "history_reader_failed", status: "incomplete" },
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
