export interface SpaceRowDetailInput {
  kind: "agent" | "term" | "ssh";
  cwd: string;
  nestedSsh: boolean;
  /** Where the pane sits inside its repository: "" at the root — the row
   *  then shows the cwd itself, so Details is never empty (owner call
   *  2026-09-14) — the worktree or subfolder path below it, or the last two
   *  path segments when the cwd is outside every registered repository. Omit
   *  when unknown. */
  relativePath?: string;
  /** The session's latest activity text. */
  activityText?: string;
  /** The provider-owned conversation title, preferred over latest activity. */
  conversationTitle?: string;
}

export type SpaceRowDetail =
  | { readonly source: "conversation"; readonly text: string }
  | { readonly source: "activity"; readonly text: string }
  | { readonly source: "location"; readonly text: string }
  | { readonly source: "none"; readonly text: "" };

/** Row context controlled by the Details field alongside the other selectable
 * metadata. Its source lets a matching group heading suppress location copy
 * without guessing from display text. */
export function spaceRowDetail(input: SpaceRowDetailInput): SpaceRowDetail {
  if (input.kind === "agent") {
    if (input.conversationTitle !== undefined) {
      return { source: "conversation", text: input.conversationTitle };
    }
    if (input.activityText !== undefined) {
      return { source: "activity", text: input.activityText };
    }
    const place = input.relativePath || input.cwd;
    return place
      ? { source: "location", text: place }
      : { source: "none", text: "" };
  }
  const location =
    input.relativePath || input.cwd || (input.nestedSsh ? undefined : "~");
  return location
    ? { source: "location", text: location }
    : { source: "none", text: "" };
}
