import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

// A conversation larger than these bounds is read as its newest window, behind
// one history boundary, never dropped whole: the newest messages, entries and
// transcript bytes, then the newest items that fit one snapshot.
const MAX_SOURCE_MESSAGES = 2_048;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_STORE_ENTRIES = 65_536;
const MAX_PROJECT_ENTRIES = 131_072;
const MAX_HISTORY_ITEMS = 2_048;
const MAX_HISTORY_ITEM_BYTES = 128 * 1024;
const MIN_CLIPPED_TEXT_BYTES = 1024;
const HISTORY_BOUNDARY_SOURCE_ID = "history-boundary";
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

function jsonBytes(value) {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** The first `bytes` UTF-8 bytes of `text`, never splitting a character. */
function clipText(text, bytes) {
	const encoded = Buffer.from(text, "utf8");
	if (encoded.length <= bytes) return text;
	let end = bytes;
	while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
	return encoded.subarray(0, end).toString("utf8");
}

/** Smaller forms of one oversized body, largest first. A tool keeps its call
 * and drops its input, then its output, then both, as live tool events do;
 * text keeps its beginning, marked as clipped; evidence keeps only its block
 * kind. The last form always fits. */
function* fittedBodies(body) {
	if (body.type === "tool") {
		yield { ...body, input: null };
		if (Object.hasOwn(body, "output")) {
			yield { ...body, output: null };
			yield { ...body, input: null, output: null };
		}
	} else if (body.type === "message" || body.type === "reasoning") {
		const field = body.type === "message" ? "markdown" : "text";
		for (
			let bytes = MAX_HISTORY_ITEM_BYTES - MIN_CLIPPED_TEXT_BYTES;
			bytes >= MIN_CLIPPED_TEXT_BYTES;
			bytes = Math.floor(bytes / 2)
		) {
			yield { ...body, [field]: `${clipText(body[field], bytes)}…` };
		}
	} else if (body.type === "provider_evidence") {
		const kind = body.value?.block?.type;
		yield {
			...body,
			value: {
				block: typeof kind === "string" ? { type: clipText(kind, 64) } : {},
				sourceType: body.value?.sourceType ?? null,
			},
		};
	}
	yield {
		type: "provider_evidence",
		namespace: "provider.claude.history",
		kind: "history_block_omitted",
		value: {},
	};
}

function historyItem(sourceId, providerMessageId, body, createdAtMs) {
	return Object.freeze({
		body: Object.freeze(body),
		createdAtMs,
		providerMessageId,
		sourceId,
	});
}

function pushItem(items, sourceId, providerMessageId, body, createdAtMs) {
	let item = historyItem(sourceId, providerMessageId, body, createdAtMs);
	if (jsonBytes(item) > MAX_HISTORY_ITEM_BYTES) {
		for (const fitted of fittedBodies(body)) {
			item = historyItem(sourceId, providerMessageId, fitted, createdAtMs);
			if (jsonBytes(item) <= MAX_HISTORY_ITEM_BYTES) break;
		}
	}
	items.push(item);
}

/** Marks where a windowed history starts. Placed in its transcript, it names
 * the byte offset of the window's oldest record: everything before it stays
 * in the transcript, where a reader pages it in (`provider_transcript_window`).
 * Unplaced, it only says that at least `omittedMessages` messages precede it. */
function historyBoundary(omittedMessages, windowStart, createdAtMs) {
	const placed = Number.isSafeInteger(windowStart) && windowStart > 0;
	return historyItem(
		HISTORY_BOUNDARY_SOURCE_ID,
		null,
		{
			dropped_through_provider_sequence: placed
				? windowStart
				: Math.max(1, omittedMessages),
			reason: placed ? "provider_transcript_window" : "provider_history_truncated",
			requested_after_provider_sequence: 0,
			type: "history_boundary",
		},
		createdAtMs,
	);
}

const HISTORY_BOUNDARY_BYTES = Math.max(
	...[Number.MAX_SAFE_INTEGER, null].map((windowStart) =>
		jsonBytes(
			historyBoundary(Number.MAX_SAFE_INTEGER, windowStart, Number.MAX_SAFE_INTEGER),
		),
	),
);

function sourceOf(item) {
	const separator = item.sourceId.indexOf(":");
	return separator === -1 ? item.sourceId : item.sourceId.slice(0, separator);
}

/** The newest items that fit one snapshot, whole source messages at a time,
 * behind a history boundary when anything older is left out. */
function newestHistoryWindow(
	items,
	omittedMessages,
	precededByOmittedHistory,
	sourceOffsets,
) {
	// The byte bound covers the encoded array: brackets and separators too.
	let bytes = 1 + items.reduce((total, item) => total + jsonBytes(item) + 1, 0);
	let start = 0;
	let omitted = omittedMessages;
	const windowed = () => precededByOmittedHistory || omitted > 0;
	const fits = () => {
		const boundary = windowed() ? 1 : 0;
		return (
			items.length - start + boundary <= MAX_HISTORY_ITEMS &&
			bytes + boundary * (HISTORY_BOUNDARY_BYTES + 1) <= MAX_HISTORY_BYTES
		);
	};
	while (start < items.length && !fits()) {
		const source = sourceOf(items[start]);
		while (start < items.length && sourceOf(items[start]) === source) {
			bytes -= jsonBytes(items[start]) + 1;
			start += 1;
		}
		omitted += 1;
	}
	const kept = items.slice(start);
	if (!windowed()) return kept;
	const windowStart =
		kept.length > 0 ? sourceOffsets.get(sourceOf(kept[0])) : undefined;
	return [
		historyBoundary(omitted, windowStart, kept[0]?.createdAtMs ?? 0),
		...kept,
	];
}

function contentBlocks(message) {
	if (!plainObject(message) || !Array.isArray(message.content)) return null;
	return message.content;
}

/** Normalize the pinned SDK's provider-owned history into bounded canonical bodies.
 * Every source block is represented either by a visible body or durable evidence.
 * History past the bounds keeps its newest window behind a history boundary;
 * `precededByOmittedHistory` says the messages themselves are such a window,
 * and `sourceOffsets` (message uuid → byte offset) places it in the transcript. */
export function normalizeClaudeHistoryMessages(
	messages,
	{ cwd, providerSessionId },
	timestamps = new Map(),
	{ precededByOmittedHistory = false, sourceOffsets = new Map() } = {},
) {
	if (!Array.isArray(messages)) return incomplete("history_unavailable");
	if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0")) {
		return incomplete("history_identity_invalid");
	}
	if (!token(providerSessionId)) return incomplete("history_identity_invalid");

	const omittedMessages = Math.max(0, messages.length - MAX_SOURCE_MESSAGES);
	const seenMessages = new Set();
	const tools = new Map();
	const items = [];
	try {
		for (const source of messages.slice(omittedMessages)) {
			if (!plainObject(source) || source.session_id !== providerSessionId) {
				return incomplete("history_identity_mismatch");
			}
			const sourceId = token(source.uuid);
			if (!sourceId || seenMessages.has(sourceId)) {
				return incomplete("history_identity_invalid");
			}
			seenMessages.add(sourceId);
			const createdAtMs = timestamps.get(sourceId) ?? 0;
			const push = (itemSourceId, providerMessageId, body) =>
				pushItem(items, itemSourceId, providerMessageId, body, createdAtMs);
			if (source.parent_tool_use_id !== null) {
				const value = jsonValue(source.message);
				if (value === null) return incomplete("history_payload_invalid");
				push(`${sourceId}:nested:0`, null, evidence(source.type, value));
				continue;
			}

			if (source.type === "user" && plainObject(source.message)) {
				if (source.message.role !== "user") return incomplete("history_payload_invalid");
				if (typeof source.message.content === "string") {
					const markdown = source.message.content;
					push(
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
					push(`${sourceId}:empty:0`, null, evidence("user", { content: [] }));
				}
				for (let index = 0; index < blocks.length; index += 1) {
					const block = jsonValue(blocks[index]);
					if (!plainObject(block)) return incomplete("history_payload_invalid");
					if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
						push(`${sourceId}:message:${index}`, null, {
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
							push(`${sourceId}:tool-result:${index}`, tool.providerMessageId, {
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
					push(`${sourceId}:evidence:${index}`, null, evidence("user", block));
				}
				continue;
			}

			if (source.type === "assistant" && plainObject(source.message)) {
				if (source.message.role !== "assistant") return incomplete("history_payload_invalid");
				const providerMessageId = token(source.message.id);
				const blocks = contentBlocks(source.message);
				if (!providerMessageId || blocks === null) return incomplete("history_payload_invalid");
				if (blocks.length === 0) {
					push(`${sourceId}:empty:0`, providerMessageId, evidence("assistant", { content: [] }));
				}
				for (let index = 0; index < blocks.length; index += 1) {
					const block = jsonValue(blocks[index]);
					if (!plainObject(block)) return incomplete("history_payload_invalid");
					if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
						push(`${sourceId}:message:${index}`, providerMessageId, {
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
						push(`${sourceId}:reasoning:${index}`, providerMessageId, {
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
							push(`${sourceId}:tool-start:${index}`, providerMessageId, {
								input,
								name,
								state: "running",
								tool_call_id: toolCallId,
								type: "tool",
							});
							continue;
						}
					}
					push(`${sourceId}:evidence:${index}`, providerMessageId, evidence("assistant", block));
				}
				continue;
			}
			return incomplete("history_payload_invalid");
		}
	} catch {
		return incomplete("history_payload_invalid");
	}

	return Object.freeze({
		items: Object.freeze(
			newestHistoryWindow(
				items,
				omittedMessages,
				precededByOmittedHistory,
				sourceOffsets,
			),
		),
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

// The SDK's exact UUID resume spans projects. Keep its history reader on the
// same account-local contract without materializing or rewriting transcripts.
async function exactAccountTranscript(root, providerSessionId) {
	let directory;
	try {
		directory = await fs.opendir(path.join(root, "projects"));
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
	let found = null;
	let count = 0;
	for await (const project of directory) {
		if (++count > MAX_PROJECT_ENTRIES)
			throw new Error("dure_claude_history_store_bounds_exceeded");
		if (!project.isDirectory()) continue;
		const target = path.join(
			root,
			"projects",
			project.name,
			`${providerSessionId}.jsonl`,
		);
		let metadata;
		try {
			metadata = await fs.lstat(target);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			throw error;
		}
		if (!metadata.isFile() || found !== null) {
			throw new Error("dure_claude_history_store_identity_mismatch");
		}
		found = { target, metadata };
	}
	return found;
}

function readOnlySessionStore(
	root,
	providerSessionId,
	timestamps,
	sourceState,
) {
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
			const found = await exactAccountTranscript(root, providerSessionId);
			if (found === null) return null;
			const handle = await fs.open(
				found.target,
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
			);
			try {
				const metadata = await handle.stat();
				if (
					!metadata.isFile() ||
					metadata.dev !== found.metadata.dev ||
					metadata.ino !== found.metadata.ino
				) {
					throw new Error("dure_claude_history_store_not_file");
				}
				sourceState.present = true;
				// A transcript past the byte bound is read from its newest bytes.
				// Read one byte earlier so a record exactly on the boundary is
				// kept; the bytes up to the first newline belong to an older one.
				const start = Math.max(0, metadata.size - MAX_STORE_BYTES);
				const readFrom = Math.max(0, start - 1);
				const buffer = Buffer.alloc(metadata.size - readFrom);
				let filled = 0;
				while (filled < buffer.length) {
					const { bytesRead } = await handle.read(
						buffer,
						filled,
						buffer.length - filled,
						readFrom + filled,
					);
					if (bytesRead === 0) break;
					filled += bytesRead;
				}
				sourceState.windowed = start > 0;
				const parents = new Map();
				const offsets = new Map();
				sourceState.parents = parents;
				sourceState.offsets = offsets;
				let entries = [];
				const keepNewestEntries = () => {
					const dropped = entries.length - MAX_STORE_ENTRIES;
					if (dropped <= 0) return;
					for (const entry of entries.slice(0, dropped)) {
						parents.delete(entry.uuid);
						offsets.delete(entry.uuid);
					}
					entries = entries.slice(dropped);
					sourceState.windowed = true;
				};
				let position = 0;
				if (start > 0) {
					const newline = buffer.indexOf(10);
					position = newline === -1 || newline >= filled ? filled : newline + 1;
				}
				while (position < filled) {
					let newline = buffer.indexOf(10, position);
					if (newline === -1 || newline >= filled) newline = filled;
					const offset = readFrom + position;
					const end =
						newline > position && buffer[newline - 1] === 13 ? newline - 1 : newline;
					const line = buffer.toString("utf8", position, end);
					position = newline + 1;
					if (line.length === 0) continue;
					const entry = JSON.parse(line);
					if (!plainObject(entry) || typeof entry.type !== "string") {
						throw new Error("dure_claude_history_store_payload_invalid");
					}
					if (
						entry.sessionId !== undefined &&
						entry.sessionId !== providerSessionId
					) {
						throw new Error("dure_claude_history_store_identity_mismatch");
					}
					if (
						!SDK_HISTORY_ENTRY_TYPES.has(entry.type) ||
						typeof entry.uuid !== "string"
					) {
						continue;
					}
					entries.push(entry);
					parents.set(
						entry.uuid,
						typeof entry.parentUuid === "string" ? entry.parentUuid : null,
					);
					offsets.set(entry.uuid, offset);
					// Trim in batches so a long transcript stays linear.
					if (entries.length >= 2 * MAX_STORE_ENTRIES) keepNewestEntries();
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
				keepNewestEntries();
				return entries;
			} finally {
				await handle.close();
			}
		},
	});
}

/** Whether the conversation the SDK chained from a windowed read continues
 * before the window: its oldest message's parent links leave the entries read
 * instead of reaching the conversation's start. */
function chainLeavesWindow(messages, parents) {
	let uuid = messages[0]?.uuid;
	for (let steps = 0; typeof uuid === "string" && steps <= parents.size; steps += 1) {
		if (!parents.has(uuid)) return true;
		uuid = parents.get(uuid);
	}
	return uuid !== null;
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
		const sourceState = {
			offsets: new Map(),
			parents: new Map(),
			present: false,
			windowed: false,
		};
		try {
			const messages = await getSessionMessages(binding.providerSessionId, {
				dir: binding.cwd,
				sessionStore: readOnlySessionStore(
					root,
					binding.providerSessionId,
					timestamps,
					sourceState,
				),
			});
			if (!sourceState.present) return incomplete("history_unavailable");
			return normalizeClaudeHistoryMessages(messages, binding, timestamps, {
				precededByOmittedHistory:
					sourceState.windowed && chainLeavesWindow(messages, sourceState.parents),
				sourceOffsets: sourceState.offsets,
			});
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
