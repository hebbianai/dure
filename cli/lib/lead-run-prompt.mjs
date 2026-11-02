// The prompt `dure run --lead` sends: a short brief that names the role and
// sends the agent to the bundled dure-lead guide, followed by the goal.
//
// The guide itself is deliberately not inlined. A Run prompt is capped at
// 16 KiB (validPromptHint in ./agent-spawn-query.mjs) and the lead guide
// alone is most of that; and the guide an agent must follow is the one
// shipped with the CLI it will be running, which `dure skills get dure-lead`
// serves verbatim. Pointing there keeps the brief small and keeps the loop
// text in one place, next to the commands it describes.

export const LEAD_SKILL_NAME = "dure-lead";

// How worker pull requests reach the default branch. `auto` is the guide's
// default (a worker merges its own green pull request) and adds nothing to
// the brief, so a lead started without --merge-policy gets the same prompt
// as before. `review` holds every merge for a person's approval; it is
// written into the brief so the lead uses the review variant of the worker
// brief from the first dispatch instead of learning the rule mid-run.
export const LEAD_MERGE_POLICIES = Object.freeze(["auto", "review"]);
export const LEAD_APPROVED_LABEL = "lead:approved";

const MERGE_POLICY_LINES = {
  auto: "",
  review: `Merge policy: review. Every worker pull request waits for a person's approval before it is merged. Use the review variant of the worker brief from the first dispatch, so no worker merges its own pull request, and follow the guide's review gate: merge only a green pull request that GitHub reports as approved or that a person labelled \`${LEAD_APPROVED_LABEL}\`, and never approve or label one yourself. A green pull request awaiting review counts as finished for the close-out: report it as awaiting review, then merge it after approval on a later turn and close out again.

`,
};

const LEAD_BRIEF = `You are the lead agent for a Dure team. This Run was started with \`dure run --lead\`; the goal is at the end of this message.

Before anything else, read the lead guide bundled with this CLI and follow it as written:

    dure skills get ${LEAD_SKILL_NAME}

It covers the whole loop: settle the project and repository, split the goal into tracked GitHub issues, start one worker Run per item in its own worktree with the standard worker brief, keep at most the agreed number of workers active, watch them with \`dure ls\`, \`dure wait\` and \`dure read\`, treat a Run receipt that ends in \`prompt_delivery_uncertain\` with a \`startup_gate\` (or a session showing \`input_required\`) as a worker that has not started, merge the pull requests that pass, escalate decisions with the \`needs:founder\` label, and close out on GitHub. When the last item is merged, handed back or escalated, continue in the same turn: update the tracking comment to every item's final state and post the report the guide specifies on the tracking issue with \`gh issue comment\`. A summary printed only in your session does not finish the Run. You do not implement work items yourself. If \`dure skills get ${LEAD_SKILL_NAME}\` fails, report that in your session and stop instead of improvising the loop.

`;

/** The full prompt for a lead Run: the brief above, the merge-policy
 *  paragraph when the policy is not the default, then the goal verbatim
 *  (surrounding whitespace trimmed). Throws on a blank goal or an unknown
 *  policy so cmdRun's usage refusal, not a malformed brief, is what the
 *  user sees. */
export function leadRunPrompt(goal, { mergePolicy = "auto" } = {}) {
  if (typeof goal !== "string" || goal.trim() === "") {
    throw new TypeError("dure run --lead needs a goal: the prompt is the goal.");
  }
  if (!LEAD_MERGE_POLICIES.includes(mergePolicy)) {
    throw new TypeError(
      `dure run --lead --merge-policy takes ${LEAD_MERGE_POLICIES.join(" or ")}.`,
    );
  }
  return `${LEAD_BRIEF}${MERGE_POLICY_LINES[mergePolicy]}Goal:\n${goal.trim()}`;
}
