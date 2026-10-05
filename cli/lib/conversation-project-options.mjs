/** Existing recovery journals retain the source workspace. Never discard a
 * requested destination and submit a same-workspace restart in its place. */
export function assertNoConversationProjectOptions(opts) {
  // The legacy parser leaves --option=value forms in rest; rehost's legacy
  // route must not treat those as ignored extra positionals either.
  const inlineDestination = opts.rest?.some((arg) => /^--(?:project|path|cwd)=/.test(arg));
  if (!opts.projectSpecified && !opts.pathSpecified && !Object.hasOwn(opts, "cwd") && !inlineDestination) return;
  throw Object.assign(new Error(
    "Moving an existing conversation to another project or working folder is not supported. " +
    "Resume keeps its original workspace. No restart was requested. " +
    "To keep this conversation, resume it without --project, --path or --cwd. " +
    "To work in another registered project, use dure run --project PROJECT with a new conversation.",
  ), { code: "conversation_project_move_unsupported" });
}
