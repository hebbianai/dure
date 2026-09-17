import { t } from "@/lib/i18n";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import type { GraphIssue } from "./graphContract";
import { scheduleErrorMessage } from "./scheduleContract";

const issueMessages: Record<string, string> = {
	input_missing: "missingInput",
	output_reference_missing: "missingOutput",
	upstream_output_unavailable: "missingOutput",
	input_type_mismatch: "typeMismatch",
	output_type_mismatch: "typeMismatch",
	output_may_be_missing: "missingOutput",
	input_requires_literal: "literalRequired",
	graph_cycle: "cycle",
	action_unsupported: "unsupportedAction",
	command_directory_invalid: "locationRequired",
	command_timeout_invalid: "timeoutInvalid",
	agent_timeout_invalid: "timeoutInvalid",
	agent_project_unavailable: "projectUnavailable",
	agent_prompt_invalid: "requiredValue",
	command_script_invalid: "requiredValue",
	graph_empty: "empty",
	workflow_revision_conflict: "revisionConflict",
};

export function graphIssueMessage(issue: GraphIssue): string {
	return t(
		`automations.graph.issues.${issueMessages[issue.code] ?? "invalid"}`,
		{ code: issue.code },
	);
}

export function graphFieldLabel(field: string): string {
	return t(`automations.graph.fields.${field}`);
}

export function graphErrorMessage(error: unknown): string {
	if (error instanceof DureBackendRequestError && issueMessages[error.code])
		return graphIssueMessage({ code: error.code });
	if (error instanceof Error && error.message === "workflow_response_invalid")
		return t("automations.invalidResponse");
	return scheduleErrorMessage(error);
}
