import type { NativeSearchItem } from "@/lib/search/nativeSearch";
import type { NativeSearchFileContext } from "@/lib/search/nativeSearchCatalog";
import { shellQuote } from "@/lib/platform/shell";

export interface NativeSearchCommandContext {
	id: string;
	label: string;
	source: "local" | "ssh";
	hostId?: string;
}

export interface NativeSearchSourceExecutor {
	local(
		command: string,
	): Promise<{ stdout: string; stderr: string; code: number }>;
	ssh(
		hostId: string,
		command: string,
	): Promise<{ stdout: string; stderr: string; code: number }>;
}

const SEARCH_PRUNES = [
	".git",
	"node_modules",
	"target",
	"dist",
	"build",
	".next",
	".turbo",
];

function boundedQuery(query: string): string {
	return query.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function buildFileNameSearchCommand(
	root: string,
	query: string,
	limit: number,
): string {
	const prune = SEARCH_PRUNES.map((name) => `-name ${shellQuote(name)}`).join(
		" -o ",
	);
	const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
	return [
		`cd ${shellQuote(root)} &&`,
		"( unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX",
		"GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES;",
		"git ls-files --cached --others --exclude-standard 2>/dev/null",
		`|| command find . \\( ${prune} \\) -prune -o -type f -print; )`,
		`| command grep -iF -- ${shellQuote(boundedQuery(query))}`,
		`| command head -n ${safeLimit}`,
	].join(" ");
}

export function parseFileNameSearchOutput(
	context: NativeSearchFileContext,
	stdout: string,
): NativeSearchItem[] {
	const seen = new Set<string>();
	const items: NativeSearchItem[] = [];
	const root = context.root.replace(/\/+$/, "");
	for (const raw of stdout.split("\n")) {
		const relative = raw.replace(/\r$/, "").replace(/^\.\//, "");
		if (!relative || relative.includes("\0") || seen.has(relative)) continue;
		seen.add(relative);
		const path = `${root}/${relative}`;
		items.push({
			id: `file:${context.source}:${context.hostId ?? ""}:${path}`,
			kind: "file",
			title: relative.split("/").pop() ?? relative,
			detail: `${context.label} · ${relative}`,
			keywords: [path, context.root],
			action: {
				type: "open-file",
				path,
				source: context.source,
				hostId: context.hostId,
			},
		});
	}
	return items;
}

export function buildCommandHistorySearchCommand(
	query: string,
	limit: number,
): string {
	const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
	const files = [
		'"$HOME/.zsh_history"',
		'"$HOME/.bash_history"',
		'"$HOME/.local/share/fish/fish_history"',
	].join(" ");
	return [
		`for file in ${files}; do`,
		'if [ -f "$file" ]; then',
		'command tail -n 2500 "$file"',
		`| command grep -iF -- ${shellQuote(boundedQuery(query))}`,
		`| command tail -n ${safeLimit};`,
		"fi;",
		"done",
	].join(" ");
}

function cleanHistoryLine(raw: string): string {
	const line = raw.trim();
	if (/^#[0-9]{9,}$/.test(line) || /^(when|paths):\s*/.test(line)) return "";
	const zsh = line.match(/^:\s*\d+:\d+;(.*)$/);
	if (zsh) return zsh[1].trim();
	const fish = line.match(/^-\s*cmd:\s*(.*)$/);
	if (fish) return fish[1].replace(/\\n/g, "\n").trim();
	return line;
}

export function parseCommandHistoryOutput(
	context: NativeSearchCommandContext,
	stdout: string,
): NativeSearchItem[] {
	const seen = new Set<string>();
	const items: NativeSearchItem[] = [];
	const lines = stdout.split("\n").reverse();
	for (const raw of lines) {
		const command = cleanHistoryLine(raw);
		if (!command || seen.has(command)) continue;
		seen.add(command);
		items.push({
			id: `command:${context.id}:${items.length}:${command}`,
			kind: "command",
			title: command,
			detail: context.label,
			keywords: [context.source, context.hostId ?? ""],
			action: { type: "copy-command", command },
		});
	}
	return items;
}

async function executeInContext(
	executor: NativeSearchSourceExecutor,
	context: { source: "local" | "ssh"; hostId?: string },
	command: string,
) {
	if (context.source === "ssh") {
		if (!context.hostId) throw new Error("remote search context has no host");
		return executor.ssh(context.hostId, command);
	}
	return executor.local(command);
}

async function mapWithConcurrency<T, U>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<readonly U[]>,
): Promise<U[]> {
	const output: Array<readonly U[] | undefined> = new Array(items.length);
	let cursor = 0;
	const worker = async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			try {
				output[index] = await task(items[index]);
			} catch {
				output[index] = [];
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker),
	);
	return output.flatMap((result) => result ?? []);
}

export async function searchNativeFiles(
	contexts: readonly NativeSearchFileContext[],
	query: string,
	executor: NativeSearchSourceExecutor,
	perContextLimit = 20,
): Promise<NativeSearchItem[]> {
	if (boundedQuery(query).length < 2) return [];
	return mapWithConcurrency(contexts, 4, async (context) => {
		const result = await executeInContext(
			executor,
			context,
			buildFileNameSearchCommand(context.root, query, perContextLimit),
		);
		return parseFileNameSearchOutput(context, result.stdout);
	});
}

export async function searchNativeCommandHistory(
	contexts: readonly NativeSearchCommandContext[],
	query: string,
	executor: NativeSearchSourceExecutor,
	perContextLimit = 30,
): Promise<NativeSearchItem[]> {
	if (boundedQuery(query).length < 2) return [];
	const command = buildCommandHistorySearchCommand(query, perContextLimit);
	return mapWithConcurrency(contexts, 4, async (context) => {
		const result = await executeInContext(executor, context, command);
		return parseCommandHistoryOutput(context, result.stdout);
	});
}
