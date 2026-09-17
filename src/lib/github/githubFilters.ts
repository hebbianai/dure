import type { GitHubWorkItemRow } from "./githubResponses";
import type {
	GitHubWorkspacePreset,
	GitHubWorkspaceView,
} from "./githubWorkspace";

interface GitHubWorkspaceFilters {
	view: GitHubWorkspaceView;
	preset: GitHubWorkspacePreset;
	query: string;
}

type GitHubWorkspaceFilterChange =
	| { type: "query"; value: string }
	| { type: "preset"; value: GitHubWorkspacePreset }
	| { type: "view"; value: GitHubWorkspaceView }
	| { type: "field"; field: GitHubFilterField; value: string };

/** Presets and text qualifiers form one query, so their changes must stay atomic. */
export function reduceGitHubWorkspaceFilters(
	current: GitHubWorkspaceFilters,
	change: GitHubWorkspaceFilterChange,
): GitHubWorkspaceFilters {
	switch (change.type) {
		case "view":
			return { view: change.value, preset: "open", query: "" };
		case "query": {
			const status = githubQueryFilters(change.value).status;
			return {
				...current,
				query: change.value,
				preset:
					current.view !== "projects" &&
					(status === "closed" || status === "merged")
						? "all"
						: current.preset,
			};
		}
		case "preset": {
			let query = current.query;
			if (current.view !== "projects") {
				query = setGitHubQueryFilter(query, "status", "");
				if (change.value === "mine")
					query = setGitHubQueryFilter(
						query,
						current.view === "pullRequests" ? "author" : "assignee",
						"",
					);
			}
			return { ...current, preset: change.value, query };
		}
		case "field": {
			const { field, value } = change;
			const status =
				githubQueryFilters(current.query).status ??
				(current.preset === "all" ? "all" : "open");
			const replacesMine =
				current.preset === "mine" &&
				field === (current.view === "pullRequests" ? "author" : "assignee");
			let preset = current.preset;
			if (field === "status") preset = value === "open" ? "open" : "all";
			else if (replacesMine) preset = status === "open" ? "open" : "all";
			const query =
				current.view === "projects"
					? current.query
					: setGitHubQueryFilter(
							current.query,
							field,
							field === "status" && value === "all" ? "" : value,
						);
			return reduceGitHubWorkspaceFilters(
				{ ...current, preset },
				{ type: "query", value: query },
			);
		}
	}
}

export type GitHubFilterField = "status" | "author" | "label" | "assignee";

/** Quoted search phrases stay intact; negative and unrelated qualifiers are untouched. */
function tokens(query: string): string[] {
	return query.match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g) ?? [];
}

function qualifier(
	token: string,
): { field: GitHubFilterField; value: string } | null {
	const match = /^(is|state|author|label|assignee):(.+)$/i.exec(token);
	if (!match) return null;
	let value = match[2];
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	const key = match[1].toLowerCase();
	if (key === "is" || key === "state") {
		return /^(open|closed|merged)$/i.test(value)
			? { field: "status", value: value.toLowerCase() }
			: null;
	}
	return { field: key as GitHubFilterField, value };
}

export function githubQueryFilters(
	query: string,
): Partial<Record<GitHubFilterField, string>> {
	return Object.fromEntries(
		tokens(query).flatMap((token) => {
			const parsed = qualifier(token);
			return parsed ? [[parsed.field, parsed.value]] : [];
		}),
	);
}

export function setGitHubQueryFilter(
	query: string,
	field: GitHubFilterField,
	value: string,
): string {
	const rest = tokens(query).filter(
		(token) => qualifier(token)?.field !== field,
	);
	const trimmed = value.trim();
	if (trimmed)
		rest.push(
			`${field === "status" ? "is" : field}:${/[\s"\\]/.test(trimmed) ? JSON.stringify(trimmed) : trimmed}`,
		);
	return rest.join(" ");
}

export function githubFilterSuggestions(
	rows: readonly GitHubWorkItemRow[],
	field: Exclude<GitHubFilterField, "status">,
): string[] {
	return [
		...new Set(
			rows.flatMap((row) =>
				field === "author"
					? row.author
						? [row.author]
						: []
					: field === "label"
						? row.labels
						: row.assignees,
			),
		),
	].sort((left, right) => left.localeCompare(right));
}
