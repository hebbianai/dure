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

const INTERRUPT_MARKER = /^\[Request interrupted by user[^\]\n]*\]$/u;

/** A user record Claude Code wrote itself, which is not the person's message:
 * what its own view leaves out (`isMeta`, such as a scheduled prompt, a
 * skill's instructions or hook feedback) and a background task's
 * notification. The SDK passes on neither mark, so it is read from the
 * transcript record. The shared transcript reader (`dure-provider-transcript`,
 * `claude_turn`) follows the same rule. */
function writtenRecord(entry) {
	return (
		entry.type === "user" &&
		(entry.isMeta === true ||
			(plainObject(entry.origin) && entry.origin.kind === "task-notification"))
	);
}

const SLASH_COMMAND_TAGS = ["command-name", "command-message", "command-args"];
const SHELL_INPUT_TAGS = ["bash-input"];
const COMMAND_OUTPUT_TAGS = [
	"local-command-stdout",
	"local-command-stderr",
	"bash-stdout",
	"bash-stderr",
];

/** `text` as `<tag>…</tag>` elements with nothing but whitespace around
 * them, each tag from `tags` and at most once (tag → body), or null. */
function envelope(text, tags) {
	const elements = new Map();
	let rest = text.trimStart();
	while (rest.length > 0) {
		const tag = tags.find((name) => rest.startsWith(`<${name}>`));
		if (tag === undefined || elements.has(tag)) return null;
		const close = `</${tag}>`;
		const end = rest.indexOf(close, tag.length + 2);
		if (end === -1) return null;
		elements.set(tag, rest.slice(tag.length + 2, end));
		rest = rest.slice(end + close.length).trimStart();
	}
	return elements.size > 0 ? elements : null;
}

/** Input the person ran in Claude Code itself instead of sending it as a
 * prompt, and what that input printed. Claude Code records both as user
 * records whose whole text is one envelope of tags. `{ input }` is the
 * command line the person ran (`/effort max`, or `! git status` for shell
 * input), `{ output: true }` what it printed, which Claude Code wrote, and
 * null any other text, including the person's own text that only mentions
 * one of these tags. The shared transcript reader
 * (`dure-provider-transcript`, `claude_local_command`) follows the same rule. */
function localCommand(text) {
	const slash = envelope(text, SLASH_COMMAND_TAGS);
	if (slash !== null) {
		const name = slash.get("command-name")?.trim();
		if (!name) return null;
		const args = slash.get("command-args")?.trim();
		return { input: args ? `${name} ${args}` : name };
	}
	const shell = envelope(text, SHELL_INPUT_TAGS);
	if (shell !== null) return { input: `! ${shell.get("bash-input").trim()}` };
	return envelope(text, COMMAND_OUTPUT_TAGS) === null ? null : { output: true };
}

/** What a user message shows for `text`: the person's words, or the command
 * line they ran in Claude Code itself. Null for a record Claude Code wrote,
 * its marker where the person interrupted a turn (`[Request interrupted by
 * user]`, or its `… for tool use]` form), and what a command printed. */
function personText(text, written) {
	if (written || text.length === 0 || INTERRUPT_MARKER.test(text.trim())) return null;
	const command = localCommand(text);
	if (command === null) return text;
	return command.output ? null : command.input;
}

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

/** Marks where the seeded history starts. Placed in its transcript, it names
 * the byte offset of the oldest record shown: everything before it stays in
 * the transcript, where a reader pages it in. A window of a longer history
 * (`provider_transcript_window`) leaves part of the provider's conversation
 * out. A compaction (`provider_conversation_compacted`) leaves out only what
 * the provider's summary stands in for, so the history it opens is complete.
 * Unplaced, a window only says that at least `omittedMessages` messages
 * precede it. */
function historyBoundary(precededBy, omittedMessages, windowStart, createdAtMs) {
	const placed = Number.isSafeInteger(windowStart) && windowStart > 0;
	let reason = "provider_history_truncated";
	if (placed) {
		reason =
			precededBy === "compaction"
				? "provider_conversation_compacted"
				: "provider_transcript_window";
	}
	return historyItem(
		HISTORY_BOUNDARY_SOURCE_ID,
		null,
		{
			dropped_through_provider_sequence: placed
				? windowStart
				: Math.max(1, omittedMessages),
			reason,
			requested_after_provider_sequence: 0,
			type: "history_boundary",
		},
		createdAtMs,
	);
}

const HISTORY_BOUNDARY_BYTES = Math.max(
	...["window", "compaction"].flatMap((precededBy) =>
		[Number.MAX_SAFE_INTEGER, null].map((windowStart) =>
			jsonBytes(
				historyBoundary(
					precededBy,
					Number.MAX_SAFE_INTEGER,
					windowStart,
					Number.MAX_SAFE_INTEGER,
				),
			),
		),
	),
);

function sourceOf(item) {
	const separator = item.sourceId.indexOf(":");
	return separator === -1 ? item.sourceId : item.sourceId.slice(0, separator);
}

/** The transcript offset of the oldest record that `items` show. A
 * compaction's preserved messages follow its summary in the conversation but
 * precede it in the transcript, so the first item need not be the oldest. */
function oldestSourceOffset(items, sourceOffsets) {
	let oldest;
	for (const item of items) {
		const offset = sourceOffsets.get(sourceOf(item));
		if (Number.isSafeInteger(offset) && (oldest === undefined || offset < oldest)) {
			oldest = offset;
		}
	}
	return oldest;
}

/** The newest items that fit one snapshot, whole source messages at a time,
 * behind a history boundary when anything older is left out, or when the
 * conversation starts at a compaction with transcript records before it. */
function newestHistoryWindow(items, omittedMessages, precededBy, sourceOffsets) {
	// The byte bound covers the encoded array: brackets and separators too.
	let bytes = 1 + items.reduce((total, item) => total + jsonBytes(item) + 1, 0);
	let start = 0;
	let omitted = omittedMessages;
	const windowed = () => precededBy === "window" || omitted > 0;
	const marked = () => windowed() || precededBy === "compaction";
	const fits = () => {
		const boundary = marked() ? 1 : 0;
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
	if (!marked()) return kept;
	const windowStart = oldestSourceOffset(kept, sourceOffsets);
	// A compaction at the transcript's start leaves nothing to page in.
	if (!windowed() && (windowStart ?? 0) <= 0) return kept;
	return [
		historyBoundary(
			windowed() ? "window" : "compaction",
			omitted,
			windowStart,
			kept[0]?.createdAtMs ?? 0,
		),
		...kept,
	];
}

function contentBlocks(message) {
	if (!plainObject(message) || !Array.isArray(message.content)) return null;
	return message.content;
}

/** Normalize the pinned SDK's provider-owned history into bounded canonical bodies.
 * Every source block is represented either by a visible body or durable evidence.
 * History past the bounds keeps its newest window behind a history boundary.
 * `precededBy` says what comes before the messages themselves: `"window"` when
 * they are such a window, `"compaction"` when they start at the provider's
 * compaction, or null. `sourceOffsets` (message uuid → byte offset) places the
 * boundary in the transcript. `writtenRecords` names the user messages Claude
 * Code wrote itself, which stay evidence. */
export function normalizeClaudeHistoryMessages(
	messages,
	{ cwd, providerSessionId },
	timestamps = new Map(),
	{ precededBy = null, sourceOffsets = new Map(), writtenRecords = new Set() } = {},
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
				// A user message's provider id is its uuid: the one Dure sent a
				// Chat prompt with, so the timeline can tell the prompt it holds.
				// What Claude Code wrote stays evidence under the same id.
				const written = writtenRecords.has(sourceId);
				if (typeof source.message.content === "string") {
					const content = source.message.content;
					const markdown = personText(content, written);
					if (markdown !== null) {
						push(`${sourceId}:message:0`, sourceId, {
							markdown,
							role: "user",
							type: "message",
						});
					} else {
						push(`${sourceId}:evidence:0`, sourceId, evidence("user", { content }));
					}
					continue;
				}
				const blocks = contentBlocks(source.message);
				if (blocks === null) return incomplete("history_payload_invalid");
				if (blocks.length === 0) {
					push(`${sourceId}:empty:0`, sourceId, evidence("user", { content: [] }));
				}
				for (let index = 0; index < blocks.length; index += 1) {
					const block = jsonValue(blocks[index]);
					if (!plainObject(block)) return incomplete("history_payload_invalid");
					const markdown =
						block.type === "text" && typeof block.text === "string"
							? personText(block.text, written)
							: null;
					if (markdown !== null) {
						push(`${sourceId}:message:${index}`, sourceId, {
							markdown,
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
					push(`${sourceId}:evidence:${index}`, sourceId, evidence("user", block));
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
			newestHistoryWindow(items, omittedMessages, precededBy, sourceOffsets),
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
				const compactions = new Set();
				const written = new Set();
				sourceState.parents = parents;
				sourceState.offsets = offsets;
				sourceState.compactions = compactions;
				sourceState.written = written;
				let entries = [];
				const keepNewestEntries = () => {
					const dropped = entries.length - MAX_STORE_ENTRIES;
					if (dropped <= 0) return;
					for (const entry of entries.slice(0, dropped)) {
						parents.delete(entry.uuid);
						offsets.delete(entry.uuid);
						compactions.delete(entry.uuid);
						written.delete(entry.uuid);
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
					// A compaction cuts the parent link and names the record it
					// summarizes instead.
					if (
						typeof entry.parentUuid !== "string" &&
						typeof entry.logicalParentUuid === "string"
					) {
						compactions.add(entry.uuid);
					}
					if (writtenRecord(entry)) written.add(entry.uuid);
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

/** What the conversation the SDK chained continues from before its oldest
 * message: `"window"` when its parent links leave the entries read (only a
 * windowed read leaves any out), `"compaction"` when they end at the
 * provider's compaction, whose summary stands in for the records before it,
 * or null when they reach the conversation's start. */
function chainContinuation(messages, { compactions, parents, windowed }) {
	let uuid = messages[0]?.uuid;
	let oldest = uuid;
	for (let steps = 0; typeof uuid === "string" && steps <= parents.size; steps += 1) {
		if (!parents.has(uuid)) return windowed ? "window" : null;
		oldest = uuid;
		uuid = parents.get(uuid);
	}
	if (uuid !== null) return windowed ? "window" : null;
	return compactions.has(oldest) ? "compaction" : null;
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
			compactions: new Set(),
			offsets: new Map(),
			parents: new Map(),
			present: false,
			windowed: false,
			written: new Set(),
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
				precededBy: chainContinuation(messages, sourceState),
				sourceOffsets: sourceState.offsets,
				writtenRecords: sourceState.written,
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
