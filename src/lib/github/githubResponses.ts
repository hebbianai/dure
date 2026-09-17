import type { Project } from "@/types";

export interface GitHubRepository {
	projectId: string;
	projectName: string;
	path: string;
	nameWithOwner: string;
	owner: string;
	url: string;
	isInOrganization: boolean;
}

interface GitHubCheckSummary {
	total: number;
	passed: number;
	failed: number;
	pending: number;
}

export interface GitHubWorkItemRow {
	kind: "issue" | "pr";
	number: number;
	title: string;
	url: string;
	state: string;
	stateReason?: string;
	isDraft: boolean;
	author?: string;
	assignees: string[];
	reviewRequests: string[];
	labels: string[];
	updatedAt: string;
	headRefName?: string;
	reviewDecision?: string;
	mergeStateStatus?: string;
	checks: GitHubCheckSummary;
	repository: GitHubRepository;
}

export interface GitHubProjectRow {
	kind: "project";
	number: number;
	title: string;
	url: string;
	closed: boolean;
	shortDescription: string;
	itemCount?: number;
	owner: string;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function actorLogin(value: unknown): string | undefined {
	const candidate = record(value);
	const login = text(candidate?.login);
	return login || undefined;
}

function actorLogins(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate) => {
		const login = actorLogin(candidate);
		return login ? [login] : [];
	});
}

function labelNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate) => {
		const name = text(record(candidate)?.name);
		return name ? [name] : [];
	});
}

const PASSED_CHECK_STATES = new Set([
	"SUCCESS",
	"NEUTRAL",
	"SKIPPED",
	"EXPECTED",
]);
const FAILED_CHECK_STATES = new Set([
	"FAILURE",
	"ERROR",
	"CANCELLED",
	"TIMED_OUT",
	"ACTION_REQUIRED",
	"STALE",
]);

function checkState(value: unknown): string {
	const candidate = record(value);
	return (
		text(candidate?.conclusion) ||
		text(candidate?.state) ||
		text(candidate?.status)
	);
}

function summarizeChecks(value: unknown): GitHubCheckSummary {
	const checks = Array.isArray(value) ? value : [];
	let passed = 0;
	let failed = 0;
	for (const check of checks) {
		const state = checkState(check).toUpperCase();
		if (PASSED_CHECK_STATES.has(state)) passed += 1;
		else if (FAILED_CHECK_STATES.has(state)) failed += 1;
	}
	return {
		total: checks.length,
		passed,
		failed,
		pending: Math.max(0, checks.length - passed - failed),
	};
}

/** Parse the one authoritative repository identity returned by `gh repo view`. */
export function parseGitHubRepository(
	json: string,
	project: Pick<Project, "id" | "name" | "path">,
): GitHubRepository | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	const candidate = record(parsed);
	const nameWithOwner = text(candidate?.nameWithOwner);
	const url = text(candidate?.url);
	const owner =
		actorLogin(candidate?.owner) ?? nameWithOwner.split("/")[0] ?? "";
	if (!candidate || !nameWithOwner || !owner || !url) return null;
	return {
		projectId: project.id,
		projectName: project.name,
		path: project.path,
		nameWithOwner,
		owner,
		url,
		isInOrganization: candidate.isInOrganization === true,
	};
}

/** Parse issue/PR JSON without letting one malformed row poison the list. */
export function parseGitHubWorkItemRows(
	json: string,
	kind: "issue" | "pr",
	repository: GitHubRepository,
): GitHubWorkItemRow[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	return parsed.flatMap((raw) => {
		const row = parseGitHubWorkItem(raw, kind, repository);
		return row ? [row] : [];
	});
}

/** Decode list and detail rows once, retaining the caller's repository identity. */
export function parseGitHubWorkItem(
	raw: unknown,
	kind: "issue" | "pr",
	repository: GitHubRepository,
): GitHubWorkItemRow | null {
	const candidate = record(raw);
	if (!candidate) return null;
	const number = candidate.number;
	const title = text(candidate.title);
	const url = text(candidate.url);
	if (
		typeof number !== "number" ||
		!Number.isSafeInteger(number) ||
		!title ||
		!url
	) {
		return null;
	}
	const headRefName = text(candidate.headRefName) || undefined;
	const reviewDecision = text(candidate.reviewDecision) || undefined;
	const mergeStateStatus = text(candidate.mergeStateStatus) || undefined;
	return {
		kind,
		number,
		title,
		url,
		state: text(candidate.state) || "OPEN",
		stateReason: text(candidate.stateReason) || undefined,
		isDraft: candidate.isDraft === true,
		author: actorLogin(candidate.author),
		assignees: actorLogins(candidate.assignees),
		reviewRequests: actorLogins(candidate.reviewRequests),
		labels: labelNames(candidate.labels),
		updatedAt: text(candidate.updatedAt),
		headRefName,
		reviewDecision,
		mergeStateStatus,
		checks: summarizeChecks(candidate.statusCheckRollup),
		repository,
	};
}

/** `gh project list --format json` has used an envelope across CLI versions. */
export function parseGitHubProjectRows(
	json: string,
	owner: string,
): GitHubProjectRow[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	const envelope = record(parsed);
	const projects = Array.isArray(parsed)
		? parsed
		: envelope && Array.isArray(envelope.projects)
			? envelope.projects
			: null;
	if (!projects) return null;
	return projects.flatMap((raw) => {
		const candidate = record(raw);
		if (!candidate) return [];
		const number = candidate.number;
		const title = text(candidate.title);
		const url = text(candidate.url);
		if (
			typeof number !== "number" ||
			!Number.isSafeInteger(number) ||
			!title ||
			!url
		) {
			return [];
		}
		const items = record(candidate.items);
		return [
			{
				kind: "project" as const,
				number,
				title,
				url,
				closed: candidate.closed === true,
				shortDescription: text(candidate.shortDescription),
				itemCount:
					typeof items?.totalCount === "number" ? items.totalCount : undefined,
				owner: actorLogin(candidate.owner) ?? owner,
			},
		];
	});
}
