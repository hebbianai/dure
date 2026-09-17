import { shellQuote } from "@/lib/platform/shell";

export const MAX_WORKSPACE_SEARCH_LINES = 500;

interface WorkspaceSearchMatch {
	readonly line: number;
	readonly text: string;
}

export interface WorkspaceSearchFileGroup {
	readonly file: string;
	readonly matches: WorkspaceSearchMatch[];
}

interface WorkspaceSearchCommandOptions {
	readonly cwd: string;
	readonly query: string;
	readonly caseSensitive: boolean;
	readonly wholeWord: boolean;
	readonly includeGlob: string;
	readonly excludeGlob: string;
}

interface WorkspaceReplaceCommandOptions {
	readonly cwd: string;
	readonly query: string;
	readonly replacement: string;
	readonly caseSensitive: boolean;
	readonly wholeWord: boolean;
	readonly preserveCase: boolean;
	readonly files: readonly string[];
}

interface WorkspaceSearchReportOptions {
	readonly title: string;
	readonly query: string;
	readonly cwd: string;
	readonly groups: readonly WorkspaceSearchFileGroup[];
}

function globArgs(kind: "include" | "exclude", raw: string): string[] {
	return raw
		.split(",")
		.map((pattern) => pattern.trim())
		.filter(Boolean)
		.flatMap((pattern) =>
			kind === "include"
				? [`--include=${shellQuote(pattern)}`]
				: [
						`--exclude=${shellQuote(pattern)}`,
						`--exclude-dir=${shellQuote(pattern)}`,
					],
		);
}

/** Build the bounded literal grep used by the workspace search pane. */
export function buildWorkspaceSearchCommand(
	options: WorkspaceSearchCommandOptions,
): string {
	const flags = [
		"-RInF",
		options.caseSensitive ? "" : "-i",
		options.wholeWord ? "-w" : "",
		"--exclude-dir=.git",
		"--exclude-dir=node_modules",
		"--exclude-dir=.worktrees",
		"--exclude-dir=.claude-worktrees",
		...globArgs("include", options.includeGlob),
		...globArgs("exclude", options.excludeGlob),
	]
		.filter(Boolean)
		.join(" ");
	// BSD grep matches --exclude globs against the full path, so filtering
	// hidden paths after the search avoids a glob that accidentally drops all.
	const hiddenPathFilter = String.raw`command grep -vE '^\./([^:]*/)?\.'`;
	return `cd ${shellQuote(options.cwd)} && command grep ${flags} -e ${shellQuote(options.query)} . 2>/dev/null | ${hiddenPathFilter} | head -n ${MAX_WORKSPACE_SEARCH_LINES + 1}`;
}

/** Parse and bound grep output while preserving first-seen file order. */
export function parseWorkspaceSearchOutput(stdout: string): {
	readonly groups: WorkspaceSearchFileGroup[];
	readonly truncated: boolean;
} {
	const lines = stdout.split("\n").filter(Boolean);
	const groups: WorkspaceSearchFileGroup[] = [];
	const byFile = new Map<string, WorkspaceSearchFileGroup>();

	for (const raw of lines.slice(0, MAX_WORKSPACE_SEARCH_LINES)) {
		const match = raw.match(/^\.\/(.+?):(\d+):(.*)$/);
		if (!match) continue;
		let group = byFile.get(match[1]);
		if (!group) {
			group = { file: match[1], matches: [] };
			byFile.set(match[1], group);
			groups.push(group);
		}
		group.matches.push({
			line: Number(match[2]),
			text: match[3].trim().slice(0, 300),
		});
	}

	return {
		groups,
		truncated: lines.length > MAX_WORKSPACE_SEARCH_LINES,
	};
}

function escapePerlRegexLiteral(value: string): string {
	return value.replace(/[^A-Za-z0-9_]/g, (match) => `\\${match}`);
}

function escapePerlDoubleQuotedReplacement(value: string): string {
	return value.replace(/[\\"$@]/g, (match) => `\\${match}`);
}

function escapePerlReplacement(value: string): string {
	return value.replace(/[\\{}$@]/g, (match) => `\\${match}`);
}

/** Build the literal in-place Perl replacement for the displayed files. */
export function buildWorkspaceReplaceCommand(
	options: WorkspaceReplaceCommandOptions,
): string {
	let pattern = escapePerlRegexLiteral(options.query);
	if (options.wholeWord) pattern = `\\b${pattern}\\b`;
	const flags = options.caseSensitive ? "g" : "gi";
	const program = options.preserveCase
		? `sub pc { my ($m, $r) = @_; return uc $r if $m eq uc $m and $m ne lc $m; return ucfirst $r if $m =~ /^[[:upper:]]/; return $r } s{(${pattern})}{pc($1, "${escapePerlDoubleQuotedReplacement(options.replacement)}")}${flags}e`
		: `s{${pattern}}{${escapePerlReplacement(options.replacement)}}${flags}`;
	const files = options.files.map((file) => shellQuote(`./${file}`)).join(" ");
	return `cd ${shellQuote(options.cwd)} && perl -pi -e ${shellQuote(program)} -- ${files}`;
}

/** Serialize visible search results for the temporary Markdown report. */
export function buildWorkspaceSearchMarkdown(
	options: WorkspaceSearchReportOptions,
): string {
	const lines = [`# ${options.title}: "${options.query}" — ${options.cwd}`, ""];
	for (const group of options.groups) {
		lines.push(`## ${group.file}`);
		for (const match of group.matches) {
			lines.push(`- ${match.line}: ${match.text}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}
