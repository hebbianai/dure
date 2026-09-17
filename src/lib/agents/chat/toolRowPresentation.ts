/** Presentation model for one tool timeline row: a short verb plus the one
 * argument a reader scans for (file path, command, query), extracted from the
 * provider's opaque input JSON. The raw JSON stays available behind the
 * disclosure — this model only decides the collapsed one-line summary. */
export interface ToolRowPresentation {
	readonly label: string;
	readonly detail: string | null;
}

/** Codex timeline tool rows are named by the provider item type. These map to
 * the same short untranslated verb register as Claude's own tool names
 * (Read, Edit, Bash…), which the transcript already shows verbatim. */
const CODEX_KIND_LABELS: Readonly<Record<string, string>> = {
	commandExecution: "Shell",
	fileChange: "Edit",
	mcpToolCall: "MCP",
	dynamicToolCall: "Tool",
	collabAgentToolCall: "Agent",
	webSearch: "Search",
	imageView: "Image",
	imageGeneration: "Image",
};

/** Checked in order; the first present string-ish field becomes the detail.
 * Covers Claude SDK tool inputs (file_path, command, pattern…) and the codex
 * bridge's normalized input ({command, changes, arguments, prompt, tool}). */
const DETAIL_FIELDS: readonly string[] = [
	"file_path",
	"notebook_path",
	"path",
	"command",
	"pattern",
	"url",
	"query",
	"tool",
	"skill",
	"description",
	"prompt",
];

const DETAIL_MAX_LENGTH = 120;

/** Claude MCP tool names arrive as `mcp__<server>__<tool>`; the tool segment
 * alone is the scannable verb — the server prefix would eat a narrow row. */
const MCP_TOOL_NAME = /^mcp__.+__(.+)$/;

function toolLabel(name: string): string {
	const mcp = MCP_TOOL_NAME.exec(name);
	if (mcp) return mcp[1] as string;
	return CODEX_KIND_LABELS[name] ?? name;
}

function compactText(value: string): string | null {
	const collapsed = value.replace(/\s+/g, " ").trim();
	if (!collapsed) return null;
	return collapsed.length > DETAIL_MAX_LENGTH
		? `${collapsed.slice(0, DETAIL_MAX_LENGTH - 1)}…`
		: collapsed;
}

/** Long absolute paths keep only their last segments so the row stays one
 * scannable line; the full path remains in the expanded JSON. */
function shortenPath(value: string): string {
	const segments = value.split("/").filter(Boolean);
	if (!value.includes("/") || segments.length <= 3) return value;
	return `…/${segments.slice(-3).join("/")}`;
}

function fieldDetail(field: string, value: unknown): string | null {
	if (typeof value === "string") {
		const text = compactText(value);
		if (!text) return null;
		return field.endsWith("path") ? shortenPath(text) : text;
	}
	if (
		field === "command" &&
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
	) {
		return compactText(value.join(" "));
	}
	return null;
}

function changedPaths(changes: unknown): string | null {
	const paths = Array.isArray(changes)
		? changes.flatMap((entry) =>
				typeof entry === "object" &&
				entry !== null &&
				"path" in entry &&
				typeof entry.path === "string"
					? [entry.path]
					: [],
			)
		: typeof changes === "object" && changes !== null
			? Object.keys(changes)
			: [];
	if (paths.length === 0) return null;
	const first = shortenPath(paths[0] as string);
	return paths.length === 1 ? first : `${first} +${paths.length - 1}`;
}

export function presentToolRow(
	name: string,
	input: unknown,
): ToolRowPresentation {
	const label = toolLabel(name);
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { label, detail: null };
	}
	const record = input as Record<string, unknown>;
	if ("changes" in record) {
		const detail = changedPaths(record.changes);
		if (detail) return { label, detail };
	}
	for (const field of DETAIL_FIELDS) {
		if (!(field in record)) continue;
		const detail = fieldDetail(field, record[field]);
		if (detail) return { label, detail };
	}
	return { label, detail: null };
}
