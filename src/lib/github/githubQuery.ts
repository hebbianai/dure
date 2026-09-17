import { t } from "@/lib/i18n";

export interface GitHubQueryFailure {
	kind:
		| "missing-cli"
		| "timed-out"
		| "project-scope"
		| "command-failed"
		| "invalid-duplicate"
		| "malformed-response";
	detail: string;
}

export type GitHubQueryResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: GitHubQueryFailure };

export type GitHubListResult<T> =
	| { ok: true; value: T[]; limitReached: boolean }
	| { ok: false; error: GitHubQueryFailure };

/** Common read failures; operation-specific remedies stay with their caller. */
export function githubQueryFailureMessage(failure: GitHubQueryFailure): string {
	switch (failure.kind) {
		case "missing-cli":
			return t("github.auth.cliMissing");
		case "timed-out":
			return t("github.workspace.error.timedOut");
		case "malformed-response":
			return t("github.workspace.error.malformed");
		default:
			return failure.detail || t("github.workspace.error.loadFailed");
	}
}
