import { type GitHubWorkItemRow, parseGitHubWorkItem } from "./githubResponses";

interface GitHubIssueComment {
	id: string;
	body: string;
	author: string;
	createdAt: string;
	url: string;
}

export interface GitHubIssueDetails extends GitHubWorkItemRow {
	id: string;
	kind: "issue";
	state: "OPEN" | "CLOSED";
	body: string;
	createdAt: string;
	comments: GitHubIssueComment[];
}

export type GitHubIssueMutation =
	| { kind: "comment"; body: string }
	| { kind: "state"; state: "OPEN" }
	| { kind: "state"; state: "CLOSED"; reason?: "completed" | "not planned" }
	| { kind: "duplicate"; number: number }
	| { kind: "body"; body: string }
	| { kind: "assignees" | "labels"; before: string[]; after: string[] };

export const ISSUE_DETAIL_FIELDS =
	"id,number,title,url,state,stateReason,body,author,assignees,labels,createdAt,updatedAt,comments";

export function githubAvatarUrl(
	login: string,
	repositoryUrl: string,
): string | undefined {
	if (!login) return undefined;
	try {
		const repository = new URL(repositoryUrl);
		if (repository.protocol !== "https:") return undefined;
		return `${repository.origin}/${encodeURIComponent(login)}.png?size=40`;
	} catch {
		return undefined;
	}
}

export function parseDuplicateIssueNumber(
	value: string,
	currentNumber: number,
): number | null {
	const match = /^#?([1-9]\d*)$/.exec(value.trim());
	const number = match ? Number(match[1]) : NaN;
	return Number.isSafeInteger(number) && number !== currentNumber
		? number
		: null;
}

export function parseGitHubIssueIdentity(
	value: unknown,
	target: Pick<GitHubWorkItemRow, "number" | "url">,
): { id: string } | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		candidate.number === target.number &&
		candidate.url === target.url
		? { id: candidate.id }
		: null;
}

/** Bind one atomic close-and-link mutation to the two resolved issue identities. */
export function githubCloseDuplicateArgs(
	row: GitHubIssueDetails,
	duplicateId: string,
): string[] {
	return [
		"api",
		"graphql",
		"--hostname",
		new URL(row.repository.url).hostname,
		"-f",
		"query=mutation($issue:ID!,$duplicate:ID!){closeIssue(input:{issueId:$issue,stateReason:DUPLICATE,duplicateIssueId:$duplicate}){issue{id state stateReason}}}",
		"-f",
		`issue=${row.id}`,
		"-f",
		`duplicate=${duplicateId}`,
		"--jq",
		".data.closeIssue.issue",
	];
}

/** Keep the selected repository/number as the authority, even if the checkout changes. */
export function githubIssueTarget(row: GitHubWorkItemRow): string[] {
	return [String(row.number), "--repo", row.repository.url];
}

export function parseGitHubIssueDetails(
	json: string,
	target: GitHubWorkItemRow,
): GitHubIssueDetails | null {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	const identity = parseGitHubIssueIdentity(value, target);
	if (
		!identity ||
		typeof value.body !== "string" ||
		(value.state !== "OPEN" && value.state !== "CLOSED") ||
		typeof value.createdAt !== "string" ||
		!Array.isArray(value.comments)
	)
		return null;
	const row = parseGitHubWorkItem(value, "issue", target.repository);
	if (!row || row.url !== target.url) return null;
	const comments: GitHubIssueComment[] = [];
	for (const raw of value.comments) {
		if (
			!raw ||
			typeof raw !== "object" ||
			typeof raw.id !== "string" ||
			typeof raw.body !== "string" ||
			typeof raw.createdAt !== "string" ||
			typeof raw.url !== "string"
		)
			return null;
		comments.push({
			id: raw.id,
			body: raw.body,
			createdAt: raw.createdAt,
			url: raw.url,
			author: typeof raw.author?.login === "string" ? raw.author.login : "",
		});
	}
	return {
		...row,
		id: identity.id,
		kind: "issue",
		state: value.state,
		body: value.body,
		createdAt: value.createdAt,
		comments,
	};
}

/** Only explicit user edits become CLI arguments; user text is never shell input. */
export function githubIssueMutationArgs(
	row: GitHubWorkItemRow,
	mutation: Exclude<GitHubIssueMutation, { kind: "duplicate" }>,
): string[] | null {
	const target = githubIssueTarget(row);
	switch (mutation.kind) {
		case "comment":
			return mutation.body.trim()
				? ["issue", "comment", ...target, "--body", mutation.body]
				: null;
		case "body":
			return ["issue", "edit", ...target, "--body", mutation.body];
		case "state":
			return mutation.state === "OPEN"
				? ["issue", "reopen", ...target]
				: [
						"issue",
						"close",
						...target,
						"--reason",
						mutation.reason ?? "completed",
					];
		default: {
			const field = mutation.kind === "labels" ? "label" : "assignee";
			const changes = [
				...mutation.after
					.filter((item) => !mutation.before.includes(item))
					.flatMap((item) => [`--add-${field}`, item]),
				...mutation.before
					.filter((item) => !mutation.after.includes(item))
					.flatMap((item) => [`--remove-${field}`, item]),
			];
			return changes.length ? ["issue", "edit", ...target, ...changes] : null;
		}
	}
}

export function parseIssueMetadataInput(value: string): string[] {
	return [
		...new Set(
			value
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];
}
