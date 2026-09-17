/** Aggregation model for a burst of consecutive tool calls: the collapsed
 * transcript line reads as one quiet sentence ("read 3 files · ran a command")
 * instead of one row per call. Categories are keyed by the same provider tool
 * vocabulary `presentToolRow` understands; the component owns localization.
 * File categories count DISTINCT files — repeated edits of one file are the
 * common agent pattern and must not overstate ("edited 3 files"). */
export type ToolBurstCategory = "read" | "edit" | "run" | "search" | "other";

interface ToolBurstPart {
	readonly category: ToolBurstCategory;
	readonly count: number;
}

export interface ToolBurstSummary {
	readonly parts: readonly ToolBurstPart[];
	readonly failed: number;
	readonly running: boolean;
}

const CATEGORY_BY_TOOL: Readonly<Record<string, ToolBurstCategory>> = {
	Read: "read",
	NotebookRead: "read",
	imageView: "read",
	Edit: "edit",
	Write: "edit",
	NotebookEdit: "edit",
	fileChange: "edit",
	Bash: "run",
	BashOutput: "run",
	commandExecution: "run",
	Grep: "search",
	Glob: "search",
	WebSearch: "search",
	webSearch: "search",
	WebFetch: "search",
};

const FILE_CATEGORIES = new Set<ToolBurstCategory>(["read", "edit"]);

const CATEGORY_ORDER: readonly ToolBurstCategory[] = [
	"read",
	"edit",
	"run",
	"search",
	"other",
];

function filePathKey(input: unknown): string | null {
	if (typeof input !== "object" || input === null) return null;
	const fields = input as Record<string, unknown>;
	for (const field of ["file_path", "notebook_path", "path"]) {
		const value = fields[field];
		if (typeof value === "string" && value) return value;
	}
	return null;
}

export function summarizeToolBurst(
	tools: readonly { name: string; state: string; input?: unknown }[],
): ToolBurstSummary {
	const counted = new Map<ToolBurstCategory, Set<string>>();
	let failed = 0;
	let running = false;
	tools.forEach((tool, index) => {
		const category = CATEGORY_BY_TOOL[tool.name] ?? "other";
		const key = FILE_CATEGORIES.has(category)
			? (filePathKey(tool.input) ?? `call:${index}`)
			: `call:${index}`;
		const keys = counted.get(category) ?? new Set<string>();
		keys.add(key);
		counted.set(category, keys);
		if (tool.state === "failed") failed += 1;
		if (tool.state === "running") running = true;
	});
	return {
		parts: CATEGORY_ORDER.flatMap((category) => {
			const count = counted.get(category)?.size ?? 0;
			return count > 0 ? [{ category, count }] : [];
		}),
		failed,
		running,
	};
}
