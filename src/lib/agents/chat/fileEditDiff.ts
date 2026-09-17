/** Line-level diffs for the file edits a tool call carries, so an expanded
 * chat row can show what changed instead of the provider's raw payload.
 *
 * Two sources, one presentation: Codex sends a real unified diff per changed
 * file, Claude sends the before/after strings of an `Edit`. Both normalize
 * here into the same row list, with long unchanged runs collapsed and the
 * whole diff bounded — a chat row is a glance, not a diff viewer. */

export type FileDiffLine =
	| { readonly kind: "context" | "added" | "removed"; readonly text: string }
	/** A hunk header from a real patch, kept verbatim for its line numbers. */
	| { readonly kind: "hunk"; readonly text: string }
	/** Unchanged lines this presentation collapsed away. */
	| { readonly kind: "gap"; readonly hiddenLines: number };

export interface FileEditDiff {
	readonly lines: readonly FileDiffLine[];
	readonly added: number;
	readonly removed: number;
	/** Lines dropped from the tail because the diff exceeded the row budget. */
	readonly hiddenLines: number;
}

/** Unchanged lines kept on each side of a change. */
const CONTEXT_LINES = 3;
/** Rows a single expanded tool row may render before the tail is cut. */
const MAX_DIFF_ROWS = 160;
/** Above this the quadratic match is not worth its cost: the changed region
 * is presented as a wholesale replacement instead. */
const MAX_MATCH_CELLS = 250_000;

function splitLines(text: string): string[] {
	const lines = text.split("\n");
	// A trailing newline ends the last line; it is not an empty line of its own.
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Longest common subsequence of two line arrays, as the diff rows between
 * them. Callers trim the common prefix and suffix first, so the table stays
 * small for the usual edit: a few lines changed inside a large block. */
function matchedRows(
	oldLines: readonly string[],
	newLines: readonly string[],
): FileDiffLine[] {
	const rows: FileDiffLine[] = [];
	if (oldLines.length * newLines.length > MAX_MATCH_CELLS) {
		for (const text of oldLines) rows.push({ kind: "removed", text });
		for (const text of newLines) rows.push({ kind: "added", text });
		return rows;
	}
	const width = newLines.length + 1;
	const lengths = new Uint32Array((oldLines.length + 1) * width);
	for (let i = oldLines.length - 1; i >= 0; i -= 1) {
		for (let j = newLines.length - 1; j >= 0; j -= 1) {
			lengths[i * width + j] =
				oldLines[i] === newLines[j]
					? (lengths[(i + 1) * width + j + 1] as number) + 1
					: Math.max(
							lengths[(i + 1) * width + j] as number,
							lengths[i * width + j + 1] as number,
						);
		}
	}
	let i = 0;
	let j = 0;
	while (i < oldLines.length && j < newLines.length) {
		if (oldLines[i] === newLines[j]) {
			rows.push({ kind: "context", text: oldLines[i] as string });
			i += 1;
			j += 1;
		} else if (
			(lengths[(i + 1) * width + j] as number) >=
			(lengths[i * width + j + 1] as number)
		) {
			rows.push({ kind: "removed", text: oldLines[i] as string });
			i += 1;
		} else {
			rows.push({ kind: "added", text: newLines[j] as string });
			j += 1;
		}
	}
	for (; i < oldLines.length; i += 1) {
		rows.push({ kind: "removed", text: oldLines[i] as string });
	}
	for (; j < newLines.length; j += 1) {
		rows.push({ kind: "added", text: newLines[j] as string });
	}
	return rows;
}

/** Replaces long unchanged runs with one gap row: the reader wants the change
 * and the lines that frame it, never the untouched remainder of the file. */
function collapseContext(rows: readonly FileDiffLine[]): FileDiffLine[] {
	const collapsed: FileDiffLine[] = [];
	for (let index = 0; index < rows.length; ) {
		const row = rows[index] as FileDiffLine;
		if (row.kind !== "context") {
			collapsed.push(row);
			index += 1;
			continue;
		}
		let end = index;
		while (
			end < rows.length &&
			(rows[end] as FileDiffLine).kind === "context"
		) {
			end += 1;
		}
		const run = rows.slice(index, end) as readonly FileDiffLine[];
		const leading = index === 0 ? 0 : CONTEXT_LINES;
		const trailing = end === rows.length ? 0 : CONTEXT_LINES;
		if (run.length <= leading + trailing + 1) {
			collapsed.push(...run);
		} else {
			collapsed.push(...run.slice(0, leading));
			collapsed.push({
				kind: "gap",
				hiddenLines: run.length - leading - trailing,
			});
			if (trailing > 0) collapsed.push(...run.slice(run.length - trailing));
		}
		index = end;
	}
	return collapsed;
}

function represents(row: FileDiffLine): number {
	return row.kind === "gap" ? row.hiddenLines : 1;
}

function bounded(rows: readonly FileDiffLine[]): {
	lines: FileDiffLine[];
	hiddenLines: number;
} {
	if (rows.length <= MAX_DIFF_ROWS) return { lines: [...rows], hiddenLines: 0 };
	const kept = rows.slice(0, MAX_DIFF_ROWS);
	const hiddenLines = rows
		.slice(MAX_DIFF_ROWS)
		.reduce((total, row) => total + represents(row), 0);
	return { lines: kept, hiddenLines };
}

function finish(rows: readonly FileDiffLine[]): FileEditDiff {
	const { lines, hiddenLines } = bounded(collapseContext(rows));
	return {
		lines,
		added: rows.filter((row) => row.kind === "added").length,
		removed: rows.filter((row) => row.kind === "removed").length,
		hiddenLines,
	};
}

/** `--- a/x` / `+++ b/x` headers carry the path, which the row already shows;
 * inside the body they would read as a deletion and an addition. */
const PATCH_HEADER = /^(\+\+\+|---) (?:"?[ab]\/|\/dev\/null)/;
const PATCH_META = [
	"diff --git",
	"index ",
	"old mode ",
	"new mode ",
	"\\ No newline",
];

/** A provider's unified diff for one file, as rows. Null when the text holds
 * no change at all — an empty patch is nothing to show. */
export function unifiedDiffRows(diffText: string): FileEditDiff | null {
	const rows: FileDiffLine[] = [];
	for (const line of diffText.split("\n")) {
		if (line.startsWith("@@")) {
			rows.push({ kind: "hunk", text: line });
			continue;
		}
		if (PATCH_HEADER.test(line)) continue;
		if (PATCH_META.some((prefix) => line.startsWith(prefix))) continue;
		if (line.startsWith("+")) {
			rows.push({ kind: "added", text: line.slice(1) });
			continue;
		}
		if (line.startsWith("-")) {
			rows.push({ kind: "removed", text: line.slice(1) });
			continue;
		}
		rows.push({
			kind: "context",
			text: line.startsWith(" ") ? line.slice(1) : line,
		});
	}
	const diff = finish(rows);
	return diff.added + diff.removed > 0 ? diff : null;
}

/** The before/after strings of one edit, as rows. Null when both sides are
 * identical, which is not an edit worth drawing. */
export function editDiffRows(
	oldText: string,
	newText: string,
): FileEditDiff | null {
	if (oldText === newText) return null;
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) {
		prefix += 1;
	}
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] ===
			newLines[newLines.length - 1 - suffix]
	) {
		suffix += 1;
	}
	const head = oldLines
		.slice(0, prefix)
		.map((text): FileDiffLine => ({ kind: "context", text }));
	const middle = matchedRows(
		oldLines.slice(prefix, oldLines.length - suffix),
		newLines.slice(prefix, newLines.length - suffix),
	);
	const tail = oldLines
		.slice(oldLines.length - suffix)
		.map((text): FileDiffLine => ({ kind: "context", text }));
	return finish([...head, ...middle, ...tail]);
}

/** A whole new file's content, as added rows. */
export function addedFileRows(content: string): FileEditDiff | null {
	if (content === "") return null;
	return finish(splitLines(content).map((text) => ({ kind: "added", text })));
}
