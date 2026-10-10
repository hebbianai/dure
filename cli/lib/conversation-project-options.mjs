/** Existing recovery journals retain the source workspace. Never discard a
 * requested destination and submit a same-workspace restart in its place. */
export function assertNoConversationProjectOptions(opts) {
  // The legacy parser leaves --option=value forms in rest; rehost's legacy
  // route must not treat those as ignored extra positionals either.
  const inlineDestination = opts.rest?.some((arg) => /^--(?:project|path|cwd)=/.test(arg));
  if (!opts.projectSpecified && !opts.pathSpecified && !Object.hasOwn(opts, "cwd") && !inlineDestination) return;
  throw Object.assign(new Error(
    "Resume keeps its original workspace and does not accept destination options. No restart was requested. " +
    "To keep this conversation, resume it without --project, --path or --cwd. " +
    "To move a stopped native Codex conversation on the same backend without retained checkout ownership, " +
    "preview with dure runs move AGENT --project PROJECT --json and use its exact Apply command. " +
    "Claude and live-source project moves are not supported. Use dure run --project PROJECT for a new conversation.",
  ), { code: "conversation_project_move_unsupported" });
}
