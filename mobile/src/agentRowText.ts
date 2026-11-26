/**
 * The phone's words for the shared agent row (`@/lib/agents/agentRowModel`).
 *
 * The row model decides what a row says, as semantic values: why a person is
 * needed, the agents above it, what it manages. This file turns them into this
 * app's copy, as the desktop's `AgentRow` turns them into its own. A status or
 * a count never gets a second meaning here.
 */

import type {
	AgentRowManagedSummary,
	AgentRowStatus,
} from "@/lib/agents/agentRowModel";
import { t } from "./i18n";

/** Why only a person can move the agent forward. "result" is not a wait. */
export type NeedsPersonStatus = Exclude<AgentRowStatus, "result">;

const NEEDS_PERSON_TEXT: Readonly<Record<NeedsPersonStatus, string>> = {
	approval: "home.needsYou.approval",
	input: "home.needsYou.input",
	error: "home.needsYou.error",
	unexpected_exit: "home.needsYou.unexpectedExit",
	sign_in_exit: "home.needsYou.signInExit",
};

export function needsPersonText(status: NeedsPersonStatus): string {
	return t(NEEDS_PERSON_TEXT[status]);
}

/** The agents above this one, outermost first, on one line. */
export function agentPathText(path: readonly string[]): string {
	return path.join(" › ");
}

/** What the agent manages over its whole subtree; zero counts say nothing. */
export function managedText(managed: AgentRowManagedSummary): string {
	return [
		t("home.row.manages", { n: managed.count }),
		managed.needsPerson > 0
			? t("home.row.managedNeedYou", { n: managed.needsPerson })
			: undefined,
		managed.working > 0
			? t("home.row.managedWorking", { n: managed.working })
			: undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");
}
