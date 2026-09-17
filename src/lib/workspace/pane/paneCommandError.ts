export type PaneCommandErrorCode =
	| "invalid_request"
	| "pane_not_found"
	| "pane_ambiguous"
	| "pane_changed"
	| "agent_identity_conflict"
	| "agent_name_conflict"
	| "project_not_found"
	| "project_ambiguous"
	| "agent_reuse_not_found"
	| "agent_reuse_runtime_unavailable"
	| "request_expired";

export class PaneCommandError extends Error {
	constructor(
		readonly code: PaneCommandErrorCode,
		message: string,
	) {
		super(message);
		this.name = "PaneCommandError";
	}
}
