#!/usr/bin/env node

import {
	chmodSync,
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	readdirSync,
	realpathSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const MAX_WINDOW_BYTES = 1024 * 1024;
const MAX_FILES_PER_PROVIDER = 200;
const MAX_DIRECTORY_ENTRIES = 5000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function argument(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function boundedIntegerArgument(name, fallback, maximum) {
	const value = argument(name);
	if (value === undefined) return fallback;
	if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be an integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
		throw new Error(`${name} must be between 0 and ${maximum}`);
	}
	return parsed;
}

function requiredDirectory(name) {
	const value = argument(name);
	if (!value) throw new Error(`missing ${name}`);
	const path = realpathSync(resolve(value));
	if (!statSync(path).isDirectory()) throw new Error(`${name} is not a directory`);
	return path;
}

function outputRoot() {
	const root = requiredDirectory("--root");
	const allowed = [
		"/tmp/dure-onboarding-",
		"/private/tmp/dure-onboarding-",
		`${realpathSync(tmpdir())}/dure-onboarding-`,
	];
	if (!allowed.some((prefix) => root.startsWith(prefix))) {
		throw new Error(`refusing non-onboarding temporary root: ${root}`);
	}
	return root;
}

function safeId(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		/^[A-Za-z0-9._:+-]+$/.test(value)
	);
}

function recentJsonlFiles(root, maxDepth, minimumAgeMs) {
	const cutoff = Date.now() - MAX_AGE_MS;
	const newestAllowed = Date.now() - minimumAgeMs;
	const files = [];
	const stack = [{ path: root, depth: 0 }];
	let inspected = 0;
	while (stack.length > 0 && inspected < MAX_DIRECTORY_ENTRIES) {
		const current = stack.pop();
		for (const entry of readdirSync(current.path, { withFileTypes: true })) {
			inspected += 1;
			if (inspected > MAX_DIRECTORY_ENTRIES) break;
			const path = join(current.path, entry.name);
			if (entry.isDirectory() && current.depth < maxDepth) {
				stack.push({ path, depth: current.depth + 1 });
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const metadata = statSync(path);
			if (
				metadata.mtimeMs >= cutoff &&
				metadata.mtimeMs <= newestAllowed &&
				metadata.size > 0
			) {
				files.push({ path, mtimeMs: metadata.mtimeMs });
			}
		}
	}
	return files
		.sort((left, right) => right.mtimeMs - left.mtimeMs)
		.slice(0, MAX_FILES_PER_PROVIDER);
}

function readWindows(path) {
	const descriptor = openSync(path, "r");
	try {
		const size = fstatSync(descriptor).size;
		const length = Math.min(size, MAX_WINDOW_BYTES);
		const prefix = Buffer.alloc(length);
		readSync(descriptor, prefix, 0, length, 0);
		if (size <= MAX_WINDOW_BYTES) return prefix.toString("utf8");
		const suffix = Buffer.alloc(length);
		readSync(descriptor, suffix, 0, length, size - length);
		return `${prefix.toString("utf8")}\n${suffix.toString("utf8")}`;
	} finally {
		closeSync(descriptor);
	}
}

function jsonLines(content) {
	return content.split("\n").flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}

function textContent(value) {
	if (typeof value === "string") return value.trim() ? value : undefined;
	if (Array.isArray(value)) {
		const text = value
			.map((part) =>
				typeof part === "string"
					? part
					: typeof part?.text === "string"
						? part.text
						: "",
			)
			.join("");
		return text.trim() ? text : undefined;
	}
	return typeof value?.text === "string" ? value.text : undefined;
}

function clippedTitle(value, fallback) {
	const compact = value?.trim().replace(/\s+/g, " ");
	return (compact || fallback).slice(0, 64);
}

function claudeSnapshot(file) {
	if (file.path.includes("/subagents/")) return undefined;
	const values = jsonLines(readWindows(file.path));
	const id = basename(file.path, ".jsonl");
	if (!safeId(id)) return undefined;
	const cwd = values.find((value) => typeof value?.cwd === "string")?.cwd;
	if (typeof cwd !== "string" || !cwd.startsWith("/")) return undefined;
	const titles = values.flatMap((value) => {
		if (value?.type !== "user") return [];
		const text = textContent(value?.message?.content)?.trim();
		if (!text || text.startsWith("<") || text.startsWith("Caveat:")) return [];
		return [text];
	});
	return {
		id,
		cwd,
		title: clippedTitle(titles.at(-1), "Claude Code"),
		mtimeMs: file.mtimeMs,
	};
}

function codexUserText(value) {
	const payload = value?.payload ?? value;
	if (payload?.type === "user_message" && typeof payload.message === "string") {
		return payload.message;
	}
	if (payload?.type !== "message" || payload?.role !== "user") return undefined;
	if (typeof payload.content === "string") return payload.content;
	if (!Array.isArray(payload.content)) return undefined;
	return payload.content
		.filter((part) => part?.type === "input_text" || part?.type === "text")
		.map((part) => (typeof part?.text === "string" ? part.text : ""))
		.join("");
}

function codexSnapshot(file) {
	const values = jsonLines(readWindows(file.path));
	const metadata = values.find((value) => value?.type === "session_meta")?.payload;
	if (
		!safeId(metadata?.id) ||
		typeof metadata?.cwd !== "string" ||
		!metadata.cwd.startsWith("/") ||
		metadata?.thread_source === "subagent" ||
		metadata?.source?.subagent
	) {
		return undefined;
	}
	const excludedPrefixes = [
		"# AGENTS.md instructions for ",
		"<environment_context>",
		"<INSTRUCTIONS>",
		"<permissions instructions>",
		"<collaboration_mode>",
	];
	const titles = values
		.map(codexUserText)
		.filter(
			(text) =>
				typeof text === "string" &&
				!excludedPrefixes.some((prefix) => text.trimStart().startsWith(prefix)),
		);
	return {
		id: metadata.id,
		cwd: metadata.cwd,
		title: clippedTitle(titles.at(-1), "Codex"),
		mtimeMs: file.mtimeMs,
	};
}

function newestById(records) {
	const result = new Map();
	for (const record of records.filter(Boolean)) {
		const previous = result.get(record.id);
		if (!previous || previous.mtimeMs < record.mtimeMs) result.set(record.id, record);
	}
	return [...result.values()];
}

function writeRecord(path, content, mtimeMs) {
	mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${content}\n`, { encoding: "utf8", mode: 0o600 });
	chmodSync(path, 0o600);
	const modified = new Date(mtimeMs);
	utimesSync(path, modified, modified);
}

const root = outputRoot();
const claudeRoot = requiredDirectory("--claude-projects");
const codexRoot = requiredDirectory("--codex-sessions");
const cwdPrefix = resolve(argument("--cwd-prefix") ?? "/");
const minimumAgeMs =
	boundedIntegerArgument("--min-age-hours", 12, 24 * 30) * 60 * 60 * 1000;
const maxClaude = boundedIntegerArgument(
	"--max-claude",
	1,
	MAX_FILES_PER_PROVIDER,
);
const maxCodex = boundedIntegerArgument(
	"--max-codex",
	2,
	MAX_FILES_PER_PROVIDER,
);
const insideCwdPrefix = (cwd) =>
	cwdPrefix === "/" || cwd === cwdPrefix || cwd.startsWith(`${cwdPrefix}/`);
const eligible = (record) =>
	record &&
	insideCwdPrefix(record.cwd) &&
	!record.cwd.includes("/output/playwright/");
const claude = newestById(
	recentJsonlFiles(claudeRoot, 2, minimumAgeMs).map(claudeSnapshot),
)
	.filter(eligible)
	.slice(0, maxClaude);
const codex = newestById(
	recentJsonlFiles(codexRoot, 5, minimumAgeMs).map(codexSnapshot),
)
	.filter(eligible)
	.slice(0, maxCodex);
const home = join(root, "home");

for (const record of claude) {
	writeRecord(
		join(home, ".claude", "projects", "snapshot", `${record.id}.jsonl`),
		JSON.stringify({
			type: "user",
			uuid: `snapshot-${record.id}`,
			cwd: record.cwd,
			message: { content: record.title },
		}),
		record.mtimeMs,
	);
}
for (const record of codex) {
	writeRecord(
		join(
			home,
			".codex",
			"sessions",
			"snapshot",
			`rollout-snapshot-${record.id}.jsonl`,
		),
		[
			JSON.stringify({
				type: "session_meta",
				payload: { id: record.id, cwd: record.cwd },
			}),
			JSON.stringify({
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: record.title,
				},
			}),
		].join("\n"),
		record.mtimeMs,
	);
}

process.stdout.write(
	`${JSON.stringify({ schemaVersion: 1, claude: claude.length, codex: codex.length })}\n`,
);
