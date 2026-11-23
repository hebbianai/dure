import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

test("project moves read the exact account history without copying or changing it", async () => {
	const { getSessionMessages } = await loadPinnedClaudeSdkRuntime();
	const root = await mkdtemp(path.join(os.tmpdir(), "dure-history-move-"));
	const sessionId = "11111111-1111-4111-8111-111111111111";
	const original = path.join(root, "account-a", "projects", "original-project");
	const file = path.join(original, `${sessionId}.jsonl`);
	try {
		await mkdir(original, { recursive: true });
		const content = `${JSON.stringify(
			sdkMessage({
				content: "original context",
				parentUuid: null,
				role: "user",
				sessionId,
				timestamp: "2026-01-02T03:04:05.000Z",
				uuid: "22222222-2222-4222-8222-222222222222",
			}),
		)}\n`;
		await writeFile(file, content);
		const reader = createClaudeAgentSdkHistoryReader({ getSessionMessages });
		const binding = {
			cwd: "/workspace/destination",
			env: { CLAUDE_CONFIG_DIR: path.join(root, "account-a") },
			providerSessionId: sessionId,
		};
		const result = await reader(binding);
		assert.equal(result.status, "complete", result.reason);
		assert.equal(result.items[0].body.markdown, "original context");
		assert.equal(await readFile(file, "utf8"), content);
		assert.deepEqual(await readdir(path.dirname(original)), [
			"original-project",
		]);
		assert.deepEqual(
			await reader({
				...binding,
				env: { CLAUDE_CONFIG_DIR: path.join(root, "account-b") },
			}),
			{ status: "incomplete", reason: "history_unavailable" },
		);
		const duplicate = path.join(path.dirname(original), "duplicate");
		await mkdir(duplicate);
		await writeFile(path.join(duplicate, `${sessionId}.jsonl`), content);
		assert.equal(
			(await reader(binding)).status,
			"incomplete",
			"ambiguous UUID must fail closed",
		);
		await rm(duplicate, { recursive: true });
		await writeFile(
			file,
			content.replaceAll(sessionId, "33333333-3333-4333-8333-333333333333"),
		);
		assert.equal(
			(await reader(binding)).status,
			"incomplete",
			"filename alone cannot grant identity",
		);
		await rm(file);
		await writeFile(path.join(root, "outside.jsonl"), content);
		await symlink(path.join(root, "outside.jsonl"), file);
		assert.equal(
			(await reader(binding)).status,
			"incomplete",
			"transcript symlinks cannot escape account storage",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

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

const HISTORY_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const HISTORY_ITEM_BYTES = 128 * 1024;

function historyUuid(index) {
	return `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;
}

function sessionMessage(index, role, content) {
	return {
		message:
			role === "assistant"
				? { content, id: `msg_${index}`, role }
				: { content, role },
		parent_tool_use_id: null,
		session_id: HISTORY_SESSION_ID,
		type: role,
		uuid: historyUuid(index),
	};
}

function itemBytes(item) {
	return Buffer.byteLength(JSON.stringify(item), "utf8");
}

test("an oversized block shrinks to fit instead of dropping the whole history", () => {
	const history = normalizeClaudeHistoryMessages(
		[
			sessionMessage(0, "user", "before"),
			sessionMessage(1, "assistant", [
				{ id: "toolu_big", input: { path: "a" }, name: "Read", type: "tool_use" },
			]),
			sessionMessage(2, "user", [
				{ content: "x".repeat(300 * 1024), tool_use_id: "toolu_big", type: "tool_result" },
			]),
			sessionMessage(3, "user", [
				{ source: { data: "y".repeat(600 * 1024), type: "base64" }, type: "image" },
			]),
			sessionMessage(4, "user", "z".repeat(300 * 1024)),
			sessionMessage(5, "assistant", [{ text: "after", type: "text" }]),
		],
		{ cwd: "/workspace/history", providerSessionId: HISTORY_SESSION_ID },
	);

	assert.equal(history.status, "complete", history.reason);
	assert.deepEqual(
		history.items.map((item) => item.body.type),
		["message", "tool", "tool", "provider_evidence", "message", "message"],
		"nothing before the oversized blocks is dropped and no boundary is claimed",
	);
	for (const item of history.items) {
		assert.ok(itemBytes(item) <= HISTORY_ITEM_BYTES, item.sourceId);
	}
	assert.deepEqual(history.items[2].body, {
		input: { path: "a" },
		name: "Read",
		output: null,
		state: "completed",
		tool_call_id: "toolu_big",
		type: "tool",
	});
	assert.deepEqual(history.items[3].body.value, {
		block: { type: "image" },
		sourceType: "user",
	});
	assert.match(history.items[4].body.markdown, /^z+…$/u);
	assert.equal(history.items[5].body.markdown, "after");
});

test("history past the byte bound keeps its newest window behind a history boundary", () => {
	const messages = Array.from({ length: 40 }, (_, index) =>
		sessionMessage(index, "user", `${index}:${"w".repeat(120 * 1024)}`),
	);
	const history = normalizeClaudeHistoryMessages(messages, {
		cwd: "/workspace/history",
		providerSessionId: HISTORY_SESSION_ID,
	});

	assert.equal(history.status, "complete", history.reason);
	assert.ok(Buffer.byteLength(JSON.stringify(history.items), "utf8") <= 4 * 1024 * 1024);
	const [boundary, ...window] = history.items;
	assert.equal(boundary.providerMessageId, null);
	assert.equal(boundary.sourceId, "history-boundary");
	assert.deepEqual(boundary.body, {
		dropped_through_provider_sequence: messages.length - window.length,
		reason: "provider_history_truncated",
		requested_after_provider_sequence: 0,
		type: "history_boundary",
	});
	assert.ok(window.length > 0);
	assert.ok(window[0].body.markdown.startsWith(`${messages.length - window.length}:`));
	assert.ok(window.at(-1).body.markdown.startsWith("39:"));
});

test("a conversation past the message bound reads its newest messages", async () => {
	const { getSessionMessages } = await loadPinnedClaudeSdkRuntime();
	const root = await mkdtemp(path.join(os.tmpdir(), "dure-history-long-"));
	const cwd = "/workspace/long-history";
	try {
		const directory = path.join(root, "projects", "-workspace-long-history");
		await mkdir(directory, { recursive: true });
		const lines = [];
		let parentUuid = null;
		for (let index = 0; index < 2_100; index += 1) {
			const uuid = historyUuid(index);
			lines.push(
				JSON.stringify(
					sdkMessage({
						content:
							index % 2 === 0
								? `message ${index}`
								: [{ text: `message ${index}`, type: "text" }],
						parentUuid,
						role: index % 2 === 0 ? "user" : "assistant",
						sessionId: HISTORY_SESSION_ID,
						timestamp: "2026-01-02T03:04:05.000Z",
						uuid,
					}),
				),
			);
			parentUuid = uuid;
		}
		const source = `${lines.join("\n")}\n`;
		await writeFile(path.join(directory, `${HISTORY_SESSION_ID}.jsonl`), source);

		const history = await createClaudeAgentSdkHistoryReader({ getSessionMessages })({
			cwd,
			env: { CLAUDE_CONFIG_DIR: root },
			providerSessionId: HISTORY_SESSION_ID,
		});

		assert.equal(history.status, "complete", history.reason);
		assert.equal(history.items.length, 2_048);
		// The boundary names where the window starts in the transcript, so a
		// reader pages the older records in without repeating any.
		assert.deepEqual(history.items[0].body, {
			dropped_through_provider_sequence: Buffer.byteLength(
				lines.slice(0, 53).map((line) => `${line}\n`).join(""),
			),
			reason: "provider_transcript_window",
			requested_after_provider_sequence: 0,
			type: "history_boundary",
		});
		assert.equal(history.items[1].body.markdown, "message 53");
		assert.equal(history.items.at(-1).body.markdown, "message 2099");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a transcript past the store window reads its newest part and marks only a cut chain", async () => {
	const { getSessionMessages } = await loadPinnedClaudeSdkRuntime();
	const root = await mkdtemp(path.join(os.tmpdir(), "dure-history-window-"));
	const cwd = "/workspace/window-history";
	const file = path.join(root, "projects", "-workspace-window-history", `${HISTORY_SESSION_ID}.jsonl`);
	const junk = JSON.stringify({
		payload: "x".repeat(65 * 1024 * 1024),
		type: "file-history-snapshot",
	});
	const line = (index, parentUuid) =>
		JSON.stringify(
			sdkMessage({
				content: index % 2 === 0 ? `message ${index}` : [{ text: `message ${index}`, type: "text" }],
				parentUuid,
				role: index % 2 === 0 ? "user" : "assistant",
				sessionId: HISTORY_SESSION_ID,
				timestamp: "2026-01-02T03:04:05.000Z",
				uuid: historyUuid(index),
			}),
		);
	const read = () =>
		createClaudeAgentSdkHistoryReader({ getSessionMessages })({
			cwd,
			env: { CLAUDE_CONFIG_DIR: root },
			providerSessionId: HISTORY_SESSION_ID,
		});
	try {
		await mkdir(path.dirname(file), { recursive: true });

		// The whole conversation follows the oversized prefix: nothing is lost.
		await writeFile(file, `${junk}\n${line(0, null)}\n${line(1, historyUuid(0))}\n`);
		const whole = await read();
		assert.equal(whole.status, "complete", whole.reason);
		assert.deepEqual(
			whole.items.map((item) => item.body.markdown),
			["message 0", "message 1"],
		);

		// The conversation starts before the window: its newest part is shown
		// behind a boundary instead of nothing.
		const prefix = `${line(0, null)}\n${junk}\n`;
		await writeFile(file, `${prefix}${line(1, historyUuid(0))}\n${line(2, historyUuid(1))}\n`);
		const cut = await read();
		assert.equal(cut.status, "complete", cut.reason);
		assert.equal(cut.items[0].body.type, "history_boundary");
		assert.equal(cut.items[0].body.reason, "provider_transcript_window");
		assert.equal(
			cut.items[0].body.dropped_through_provider_sequence,
			Buffer.byteLength(prefix),
		);
		assert.deepEqual(
			cut.items.slice(1).map((item) => item.body.markdown),
			["message 1", "message 2"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
