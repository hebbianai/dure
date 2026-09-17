/** Typed reading of a tool call's opaque input/output for the expanded row:
 * shell calls show `$ command` plus extracted text output, file mutations show
 * the changed lines when the payload carries enough to derive them plus an
 * honest diffstat, and anything unrecognized stays raw JSON — the presentation
 * never guesses. */

import {
	addedFileRows,
	editDiffRows,
	type FileEditDiff,
	unifiedDiffRows,
} from "@/lib/agents/chat/fileEditDiff";

/** One file a tool call changed, with the lines it changed when they are
 * derivable from the payload. */
interface ToolFileChange {
	readonly path: string | null;
	readonly diff: FileEditDiff;
}

export type ToolDetailPresentation =
	| { kind: "shell"; command: string; output: string | null }
	| {
			kind: "file";
			/** The single changed path, or null when the call changed several. */
			path: string | null;
			added: number | null;
			removed: number | null;
			/** Empty when no payload field carried the change itself. */
			files: readonly ToolFileChange[];
	  }
	| { kind: "json" };

const SHELL_TOOLS = new Set(["Bash", "commandExecution"]);
const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "fileChange"]);

const OUTPUT_TEXT_FIELDS = [
	"stdout",
	"aggregatedOutput",
	"output",
	"result",
	"content",
	"text",
] as const;

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function commandText(value: unknown): string | null {
	if (typeof value === "string" && value.trim()) return value;
	if (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
	) {
		const joined = value.join(" ");
		return joined.trim() ? joined : null;
	}
	return null;
}

function outputText(output: unknown): string | null {
	if (output === null || output === undefined) return null;
	if (typeof output === "string") return output;
	const fields = record(output);
	if (!fields) return null;
	for (const field of OUTPUT_TEXT_FIELDS) {
		const value = fields[field];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

function lineCount(value: unknown): number | null {
	return typeof value === "string" ? value.split("\n").length : null;
}

/** Codex reports every file of one patch in `changes`, each with its own
 * unified diff. Claude's tools carry a single file. */
function codexChanges(value: unknown): ToolFileChange[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const change = record(entry);
		const diffText = text(change?.diff);
		if (!diffText) return [];
		const diff = unifiedDiffRows(diffText);
		return diff ? [{ path: text(change?.path), diff }] : [];
	});
}

function fileDetail(
	path: string | null,
	files: readonly ToolFileChange[],
	fallback?: { added: number | null; removed: number | null },
): ToolDetailPresentation {
	if (files.length === 0) {
		return {
			kind: "file",
			path,
			added: fallback?.added ?? null,
			removed: fallback?.removed ?? null,
			files,
		};
	}
	const total = (pick: (diff: FileEditDiff) => number): number =>
		files.reduce((sum, file) => sum + pick(file.diff), 0);
	return {
		kind: "file",
		path:
			path ?? (files.length === 1 ? (files[0] as ToolFileChange).path : null),
		added: total((diff) => diff.added),
		removed:
			fallback && fallback.removed === null
				? null
				: total((diff) => diff.removed),
		files,
	};
}

export function presentToolDetail(
	name: string,
	input: unknown,
	output: unknown,
): ToolDetailPresentation {
	const fields = record(input);
	if (SHELL_TOOLS.has(name)) {
		const command = commandText(fields?.command);
		if (command) return { kind: "shell", command, output: outputText(output) };
		return { kind: "json" };
	}
	if (FILE_TOOLS.has(name)) {
		const path = text(fields?.file_path) ?? text(fields?.notebook_path);
		if (name === "fileChange") {
			return fileDetail(null, codexChanges(fields?.changes));
		}
		if (name === "Edit") {
			const before = text(fields?.old_string);
			const after = text(fields?.new_string);
			const diff =
				before !== null && after !== null ? editDiffRows(before, after) : null;
			return fileDetail(path, diff ? [{ path, diff }] : []);
		}
		// A write replaces the file wholesale: its new content is all added, and
		// what it displaced is not in the payload — never claim zero removed.
		const written = text(fields?.content) ?? text(fields?.new_source);
		const diff = written !== null ? addedFileRows(written) : null;
		return fileDetail(path, diff ? [{ path, diff }] : [], {
			added: lineCount(written),
			removed: null,
		});
	}
	return { kind: "json" };
}
