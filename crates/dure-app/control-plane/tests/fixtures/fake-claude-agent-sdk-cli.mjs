#!/usr/bin/env node

import fs from "node:fs";
import readline from "node:readline";

const SESSION_ID = "99999999-8888-4777-8666-555555555555";
const claudeCodeVersion = process.env.DURE_FAKE_CLAUDE_CODE_VERSION ?? "2.1.234";
if (process.argv.length === 3 && process.argv[2] === "--version") {
	process.stdout.write(`${claudeCodeVersion} (Claude Code)\n`);
	process.exit(0);
}

const startLogFile = process.env.HEBBIAN_TEST_CLAUDE_START_LOG_FILE;
if (startLogFile) fs.appendFileSync(startLogFile, `${process.pid}\n`);

const failStartOnceFile = process.env.HEBBIAN_TEST_CLAUDE_FAIL_START_ONCE_FILE;
if (failStartOnceFile) {
	try {
		fs.unlinkSync(failStartOnceFile);
		process.exit(86);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}

function argumentValue(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function requireExpectedLaunchOptions() {
	const expectedModel = process.env.HEBBIAN_TEST_EXPECT_CLAUDE_MODEL;
	const expectedEffort = process.env.HEBBIAN_TEST_EXPECT_CLAUDE_EFFORT;
	const expectedPermissionMode = process.env.HEBBIAN_TEST_EXPECT_CLAUDE_PERMISSION_MODE;
	if (
		expectedModel === undefined &&
		expectedEffort === undefined &&
		expectedPermissionMode === undefined
	) {
		return;
	}
	if (argumentValue("--model") !== expectedModel) {
		throw new Error("fake_agent_sdk_cli_model_selection_mismatch");
	}
	if (argumentValue("--effort") !== expectedEffort) {
		throw new Error("fake_agent_sdk_cli_effort_selection_mismatch");
	}
	const expectedSdkPermissionMode =
		expectedPermissionMode === "skip_permissions" ? "bypassPermissions" : "default";
	if (argumentValue("--permission-mode") !== expectedSdkPermissionMode) {
		throw new Error("fake_agent_sdk_cli_permission_mode_mismatch");
	}
	if (
		(process.argv.includes("--allow-dangerously-skip-permissions") === true) !==
		(expectedPermissionMode === "skip_permissions")
	) {
		throw new Error("fake_agent_sdk_cli_permission_skip_authority_mismatch");
	}
}

requireExpectedLaunchOptions();
let outputSequence = 0;
let pendingTurn;

function write(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
	outputSequence += 1;
}

function initialize(requestId) {
	write({
		response: {
			request_id: requestId,
			response: {
				account: {},
				agents: [],
				available_output_styles: ["default"],
				commands: [],
				models: [],
				output_style: "default",
			},
			subtype: "success",
		},
		type: "control_response",
	});
	write({
		agents: [],
		apiKeySource: "none",
		capabilities: ["interrupt_receipt_v1"],
		claude_code_version: claudeCodeVersion,
		cwd: process.cwd(),
		mcp_servers: [],
		model: "claude-sonnet-4-6",
		output_style: "default",
		permissionMode: "default",
		plugins: [],
		session_id: SESSION_ID,
		skills: [],
		slash_commands: [],
		subtype: "init",
		tools: [],
		type: "system",
		uuid: "10000000-0000-4000-8000-000000000001",
	});
}

function textFromUserMessage(value) {
	const content = value?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) throw new Error("fake_agent_sdk_cli_user_content_invalid");
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

function completeTurn(message) {
	const text = `sdk-echo:${textFromUserMessage(message)}`;
	const providerMessageId = `fake-provider-message-${outputSequence}`;
	write({
		event: {
			message: {
				content: [],
				id: providerMessageId,
				model: "claude-sonnet-4-6",
				role: "assistant",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
			type: "message_start",
		},
		parent_tool_use_id: null,
		session_id: SESSION_ID,
		type: "stream_event",
		uuid: "20000000-0000-4000-8000-000000000001",
	});
	write({
		event: {
			content_block: { text: "", type: "text" },
			index: 0,
			type: "content_block_start",
		},
		parent_tool_use_id: null,
		session_id: SESSION_ID,
		type: "stream_event",
		uuid: "20000000-0000-4000-8000-000000000002",
	});
	write({
		event: {
			delta: { text, type: "text_delta" },
			index: 0,
			type: "content_block_delta",
		},
		parent_tool_use_id: null,
		session_id: SESSION_ID,
		type: "stream_event",
		uuid: "20000000-0000-4000-8000-000000000003",
	});
	write({
		event: { index: 0, type: "content_block_stop" },
		parent_tool_use_id: null,
		session_id: SESSION_ID,
		type: "stream_event",
		uuid: "20000000-0000-4000-8000-000000000004",
	});
	write({
		event: {
			delta: { stop_reason: "end_turn", stop_sequence: null },
			type: "message_delta",
			usage: { output_tokens: 3 },
		},
		parent_tool_use_id: null,
		session_id: SESSION_ID,
		type: "stream_event",
		uuid: "20000000-0000-4000-8000-000000000005",
	});
	write({
		event: { type: "message_stop" },
		parent_tool_use_id: null,
		session_id: SESSION_ID,
		type: "stream_event",
		uuid: "20000000-0000-4000-8000-000000000006",
	});
	write({
		message: {
			content: [{ text, type: "text" }],
			id: providerMessageId,
			model: "claude-sonnet-4-6",
			role: "assistant",
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 3 },
		},
		parent_tool_use_id: null,
		session_id: SESSION_ID,
		type: "assistant",
		uuid: "30000000-0000-4000-8000-000000000001",
	});
	write({
		duration_api_ms: 2,
		duration_ms: 4,
		is_error: false,
		modelUsage: {},
		num_turns: 1,
		permission_denials: [],
		result: text,
		session_id: SESSION_ID,
		stop_reason: "end_turn",
		subtype: "success",
		total_cost_usd: 0,
		type: "result",
		usage: { input_tokens: 1, output_tokens: 3 },
		user_message_uuid: message.uuid,
		uuid: "40000000-0000-4000-8000-000000000001",
	});
}

function requestPermission(message, kind) {
	const requestId = `fake-${kind}-request-${outputSequence}`;
	pendingTurn = { kind, message, requestId };
	if (kind === "question") {
		write({
			request: {
				input: {
					questions: [
						{
							header: "Database",
							multiSelect: false,
							options: [
								{ description: "Use the local database", label: "SQLite" },
								{ description: "Use the server database", label: "Postgres" },
							],
							question: "Which database should we use?",
						},
					],
				},
				subtype: "can_use_tool",
				tool_name: "AskUserQuestion",
				tool_use_id: "fake-question-tool-use-1",
			},
			request_id: requestId,
			type: "control_request",
		});
		return;
	}
	write({
		request: {
			blocked_path: "/workspace/permission.txt",
			decision_reason: "write requires approval",
			description: "Claude will write one test file",
			display_name: "Write file",
			input: { file_path: "/workspace/permission.txt" },
			subtype: "can_use_tool",
			title: "Claude wants to write permission.txt",
			tool_name: "Write",
			tool_use_id: "fake-permission-tool-use-1",
		},
		request_id: requestId,
		type: "control_request",
	});
}

function respondToInterrupt(requestId) {
	write({
		response: {
			request_id: requestId,
			response: { still_queued: [] },
			subtype: "success",
		},
		type: "control_response",
	});
	if (pendingTurn?.kind === "interrupt") {
		const { message } = pendingTurn;
		pendingTurn = undefined;
		completeTurn(message);
	}
}

function acceptPermission(value) {
	if (!pendingTurn || value.response?.request_id !== pendingTurn.requestId) return false;
	const result = value.response?.response;
	if (value.response?.subtype !== "success" || result?.behavior !== "allow") {
		throw new Error("fake_agent_sdk_cli_permission_response_invalid");
	}
	if (
		pendingTurn.kind === "question" &&
		result.updatedInput?.answers?.["Which database should we use?"] !== "SQLite"
	) {
		throw new Error("fake_agent_sdk_cli_question_response_invalid");
	}
	const { message } = pendingTurn;
	pendingTurn = undefined;
	completeTurn(message);
	return true;
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
for await (const line of lines) {
	if (!line) continue;
	const value = JSON.parse(line);
	if (value.type === "control_request" && value.request?.subtype === "initialize") {
		initialize(value.request_id);
	} else if (value.type === "control_request" && value.request?.subtype === "interrupt") {
		respondToInterrupt(value.request_id);
	} else if (value.type === "control_response") {
		acceptPermission(value);
	} else if (value.type === "user") {
		const text = textFromUserMessage(value);
		if (text === "permission-through-sdk") {
			requestPermission(value, "permission");
		} else if (text === "question-through-sdk") {
			requestPermission(value, "question");
		} else if (text === "interrupt-through-sdk") {
			pendingTurn = { kind: "interrupt", message: value };
		} else {
			completeTurn(value);
		}
	}
}
