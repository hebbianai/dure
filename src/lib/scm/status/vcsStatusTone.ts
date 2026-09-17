/**
 * Git status letters → vcs tone class. The one authority for every list
 * surface that colors status letters (git panel porcelain XY, diff panel
 * single letters, source-control rows), so a status can no longer wear a
 * different color per surface — before this module, untracked files were
 * green in the source-control pane but muted in the git panel, and an
 * `MD` entry hid its deletion under the modified tone.
 *
 * Design decisions this module owns:
 * - Untracked (`?`) reads as *new content* → the added green, matching the
 *   pane's `U` letter and diff `+` semantics (not the muted "disabled" grey).
 * - Destructive-first priority: a deletion signal anywhere in the XY pair
 *   outranks modification — losing content is the state a user must not
 *   miss. Then added, then renamed/copied, then modified.
 * - Unknown letters fall back to the modified tone (neutral change signal).
 */
export function vcsStatusTone(letters: string): string {
	if (letters.startsWith("?")) return "text-vcs-added";
	if (letters.includes("D")) return "text-vcs-deleted";
	if (letters.includes("A")) return "text-vcs-added";
	if (letters.includes("R") || letters.includes("C")) return "text-vcs-renamed";
	return "text-vcs-modified";
}
