import fs from "node:fs/promises";
import path from "node:path";

const MAX_SOURCE_MESSAGES = 2_048;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_STORE_ENTRIES = 65_536;
const MAX_HISTORY_ITEMS = 2_048;
const MAX_HISTORY_ITEM_BYTES = 128 * 1024;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SDK_HISTORY_ENTRY_TYPES = new Set([
	"assistant",
	"attachment",
	"progress",
	"system",
	"user",
]);

function incomplete(reason) {
	return Object.freeze({ reason, status: "incomplete" });
}

function plainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function token(value) {
	return typeof value === "string" && SAFE_TOKEN.test(value) ? value : null;
}

function jsonValue(value) {
	try {
		const encoded = JSON.stringify(value);
		if (typeof encoded !== "string") return null;
		return JSON.parse(encoded);
	} catch {
		return null;
	}
}

function evidence(sourceType, block) {
	return {
		type: "provider_evidence",
		namespace: "provider.claude.history",
		kind: "history_block",
		value: { block, sourceType },
	};
}

function pushItem(items, sourceId, providerMessageId, body) {
	const item = { body: Object.freeze(body), providerMessageId, sourceId };
	if (Buffer.byteLength(JSON.stringify(item), "utf8") > MAX_HISTORY_ITEM_BYTES) {
		throw new Error("history_item_too_large");
	}
	items.push(item);
	if (items.length > MAX_HISTORY_ITEMS) throw new Error("history_item_limit");
}

function contentBlocks(message) {
	if (!plainObject(message) || !Array.isArray(message.content)) return null;
	return message.content;
}

/** Normalize the pinned SDK's provider-owned history into bounded canonical bodies.
 * Every source block is represented either by a visible body or durable evidence. */
export function normalizeClaudeHistoryMessages(
	messages,
	{ cwd, providerSessionId },
	timestamps = new Map(),
) {
	if (!Array.isArray(messages) || messages.length > MAX_SOURCE_MESSAGES) {
		return incomplete("history_unavailable");
	}
	if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0")) {
		return incomplete("history_identity_invalid");
	}
	if (!token(providerSessionId)) return incomplete("history_identity_invalid");

	const seenMessages = new Set();
	const tools = new Map();
	const items = [];
	try {
		for (const source of messages) {
			if (!plainObject(source) || source.session_id !== providerSessionId) {
				return incomplete("history_identity_mismatch");
			}
			const sourceId = token(source.uuid);
			if (!sourceId || seenMessages.has(sourceId)) {
				return incomplete("history_identity_invalid");
			}
			seenMessages.add(sourceId);
			if (source.parent_tool_use_id !== null) {
				const value = jsonValue(source.message);
				if (value === null) return incomplete("history_payload_invalid");
				pushItem(items, `${sourceId}:nested:0`, null, evidence(source.type, value));
				continue;
			}

			if (source.type === "user" && plainObject(source.message)) {
				if (source.message.role !== "user") return incomplete("history_payload_invalid");
				if (typeof source.message.content === "string") {
					const markdown = source.message.content;
					pushItem(
						items,
						`${sourceId}:message:0`,
						null,
						markdown.length > 0
							? { markdown, role: "user", type: "message" }
							: evidence("user", { content: "" }),
					);
					continue;
				}
				const blocks = contentBlocks(source.message);
				if (blocks === null) return incomplete("history_payload_invalid");
				if (blocks.length === 0) {
					pushItem(items, `${sourceId}:empty:0`, null, evidence("user", { content: [] }));
				}
				for (let index = 0; index < blocks.length; index += 1) {
					const block = jsonValue(blocks[index]);
					if (!plainObject(block)) return incomplete("history_payload_invalid");
					if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
						pushItem(items, `${sourceId}:message:${index}`, null, {
							markdown: block.text,
							role: "user",
							type: "message",
						});
						continue;
					}
					if (block.type === "tool_result") {
						const toolCallId = token(block.tool_use_id);
						const tool = toolCallId === null ? null : tools.get(toolCallId);
						if (tool) {
							pushItem(items, `${sourceId}:tool-result:${index}`, tool.providerMessageId, {
								input: tool.input,
								name: tool.name,
								output: block.content ?? null,
								state: block.is_error === true ? "failed" : "completed",
								tool_call_id: toolCallId,
								type: "tool",
							});
							continue;
						}
					}
					pushItem(items, `${sourceId}:evidence:${index}`, null, evidence("user", block));
				}
				continue;
			}

			if (source.type === "assistant" && plainObject(source.message)) {
				if (source.message.role !== "assistant") return incomplete("history_payload_invalid");
				const providerMessageId = token(source.message.id);
				const blocks = contentBlocks(source.message);
				if (!providerMessageId || blocks === null) return incomplete("history_payload_invalid");
				if (blocks.length === 0) {
					pushItem(
						items,
						`${sourceId}:empty:0`,
						providerMessageId,
						evidence("assistant", { content: [] }),
					);
				}
				for (let index = 0; index < blocks.length; index += 1) {
					const block = jsonValue(blocks[index]);
					if (!plainObject(block)) return incomplete("history_payload_invalid");
					if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
						pushItem(items, `${sourceId}:message:${index}`, providerMessageId, {
							markdown: block.text,
							role: "assistant",
							type: "message",
						});
						continue;
					}
					if (
						block.type === "thinking" &&
						typeof block.thinking === "string" &&
						block.thinking.length > 0
					) {
						pushItem(items, `${sourceId}:reasoning:${index}`, providerMessageId, {
							text: block.thinking,
							type: "reasoning",
						});
						continue;
					}
					if (block.type === "tool_use") {
						const toolCallId = token(block.id);
						const name = token(block.name);
						const input = jsonValue(block.input);
						if (toolCallId && name && input !== null) {
							const tool = Object.freeze({ input, name, providerMessageId });
							if (tools.has(toolCallId)) return incomplete("history_identity_invalid");
							tools.set(toolCallId, tool);
							pushItem(items, `${sourceId}:tool-start:${index}`, providerMessageId, {
								input,
								name,
								state: "running",
								tool_call_id: toolCallId,
								type: "tool",
							});
							continue;
						}
					}
					pushItem(
						items,
						`${sourceId}:evidence:${index}`,
						providerMessageId,
						evidence("assistant", block),
					);
				}
				continue;
			}
			return incomplete("history_payload_invalid");
		}
	} catch {
		return incomplete("history_bounds_exceeded");
	}

	const normalizedItems = items.map((item) => {
		const separator = item.sourceId.indexOf(":");
		const sourceId = separator === -1 ? item.sourceId : item.sourceId.slice(0, separator);
		return Object.freeze({
			...item,
			createdAtMs: timestamps.get(sourceId) ?? 0,
		});
	});
	const source = JSON.stringify(normalizedItems);
	if (Buffer.byteLength(source, "utf8") > MAX_HISTORY_BYTES) {
		return incomplete("history_bounds_exceeded");
	}
	return Object.freeze({
		items: Object.freeze(normalizedItems),
		status: "complete",
	});
}

function absoluteDirectory(value) {
	return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0")
		? path.resolve(value)
		: null;
}

function configRoot(env) {
	if (Object.hasOwn(env, "CLAUDE_CONFIG_DIR")) {
		return absoluteDirectory(env.CLAUDE_CONFIG_DIR);
	}
	const home = absoluteDirectory(env.HOME);
	return home === null ? null : path.join(home, ".claude");
}

function safeProjectKey(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 240 &&
		value !== "." &&
		value !== ".." &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes("\0")
	);
}

function timestamp(value) {
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function readOnlySessionStore(root, providerSessionId, timestamps, sourceState) {
	return Object.freeze({
		async append() {
			throw new Error("dure_claude_history_store_read_only");
		},
		async load(key) {
			if (
				!plainObject(key) ||
				!safeProjectKey(key.projectKey) ||
				key.sessionId !== providerSessionId ||
				key.subpath !== undefined
			) {
				throw new Error("dure_claude_history_store_identity_mismatch");
			}
			const target = path.join(
				root,
				"projects",
				key.projectKey,
				`${providerSessionId}.jsonl`,
			);
			let handle;
			try {
				handle = await fs.open(target, "r");
			} catch (error) {
				if (error?.code === "ENOENT") return null;
				throw error;
			}
			try {
				const metadata = await handle.stat();
				if (!metadata.isFile()) {
					throw new Error("dure_claude_history_store_not_file");
				}
				sourceState.present = true;
				const entries = [];
				let bytes = 0;
				for await (const line of handle.readLines()) {
					if (line.length === 0) continue;
					const entry = JSON.parse(line);
					if (!plainObject(entry) || typeof entry.type !== "string") {
						throw new Error("dure_claude_history_store_payload_invalid");
					}
					if (!SDK_HISTORY_ENTRY_TYPES.has(entry.type) || typeof entry.uuid !== "string") {
						continue;
					}
					bytes += Buffer.byteLength(line, "utf8");
					if (bytes > MAX_STORE_BYTES) {
						throw new Error("dure_claude_history_store_bounds_exceeded");
					}
					entries.push(entry);
					if (entries.length > MAX_STORE_ENTRIES) {
						throw new Error("dure_claude_history_store_bounds_exceeded");
					}
					const sourceId = token(entry.uuid);
					const createdAtMs = timestamp(entry.timestamp);
					if (sourceId && createdAtMs !== null) {
						const prior = timestamps.get(sourceId);
						if (prior !== undefined && prior !== createdAtMs) {
							throw new Error("dure_claude_history_store_identity_mismatch");
						}
						timestamps.set(sourceId, createdAtMs);
					}
				}
				return entries;
			} finally {
				await handle.close();
			}
		},
	});
}

/** Read one exact provider-owned transcript through the pinned SDK without
 * consulting or changing the shared host process environment. */
export function createClaudeAgentSdkHistoryReader({
	getSessionMessages,
} = {}) {
	if (typeof getSessionMessages !== "function") {
		throw new Error("dure_claude_history_sdk_invalid");
	}
	const read = async (binding) => {
		if (!plainObject(binding) || !plainObject(binding.env)) {
			return incomplete("history_identity_invalid");
		}
		if (binding.providerSessionId === null) return incomplete("history_unavailable");
		const root = configRoot(binding.env);
		if (root === null || !token(binding.providerSessionId)) {
			return incomplete("history_identity_invalid");
		}
		const timestamps = new Map();
		const sourceState = { present: false };
		try {
			const messages = await getSessionMessages(binding.providerSessionId, {
				dir: binding.cwd,
				limit: MAX_SOURCE_MESSAGES + 1,
				sessionStore: readOnlySessionStore(
					root,
					binding.providerSessionId,
					timestamps,
					sourceState,
				),
			});
			if (!sourceState.present) return incomplete("history_unavailable");
			return normalizeClaudeHistoryMessages(messages, binding, timestamps);
		} catch {
			return incomplete("history_reader_failed");
		}
	};
	let prior = Promise.resolve();
	return (binding) => {
		const result = prior.then(
			() => read(binding),
			() => read(binding),
		);
		prior = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
}
