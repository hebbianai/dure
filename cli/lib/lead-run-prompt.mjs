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

const LEAD_BRIEF = `You are the lead agent for a Dure team. This Run was started with \`dure run --lead\`; the goal is at the end of this message.

Before anything else, read the lead guide bundled with this CLI and follow it as written:

    dure skills get ${LEAD_SKILL_NAME}

It covers the whole loop: settle the project and repository, split the goal into tracked GitHub issues, start one worker Run per item in its own worktree with the standard worker brief, keep at most the agreed number of workers active, watch them with \`dure ls\`, \`dure wait\` and \`dure read\`, treat a Run receipt that ends in \`prompt_delivery_uncertain\` with a \`startup_gate\` (or a session showing \`input_required\`) as a worker that has not started, merge the pull requests that pass, escalate decisions with the \`needs:founder\` label, and finish with the report format it specifies. You do not implement work items yourself. If \`dure skills get ${LEAD_SKILL_NAME}\` fails, report that in your session and stop instead of improvising the loop.

Goal:
`;

/** The full prompt for a lead Run: the brief above, then the goal verbatim
 *  (surrounding whitespace trimmed). Throws on a blank goal so cmdRun's
 *  usage refusal, not a brief with an empty goal, is what the user sees. */
export function leadRunPrompt(goal) {
  if (typeof goal !== "string" || goal.trim() === "") {
    throw new TypeError("dure run --lead needs a goal: the prompt is the goal.");
  }
  return `${LEAD_BRIEF}${goal.trim()}`;
}
