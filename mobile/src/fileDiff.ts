/**
 * A unified diff, turned into the rows a screen draws.
 *
 * Pure, so the numbering — the part that is easy to get wrong and invisible
 * when it is — can be tested without a repository or a DOM.
 *
 * # Why the numbers are computed here and not sent
 *
 * git prints line numbers only on the `@@` header; every line after it is
 * positional. Something has to count, and counting on the phone means the
 * numbers always match the body beside them. Sending them would double the
 * size of the largest field in the round trip to carry values that are a
 * function of what is already there.
 *
 * # One column, not two
 *
 * The mockup (Figma 3048:81027) draws one number per row. A context line has
 * two numbers that are usually different; the one shown is the **new** file's,
 * because that is the file on disk — the thing somebody would open to look. A
 * deleted line has no new number, so it shows the old one; that is the only
 * row where the column changes meaning, and it is also the only row where the
 * old file is the only place the line exists.
 */

/** One drawn row. */
export type DiffRow =
  /** A `@@ … @@` header. Drawn as its own dim row, as in the mockup. */
  | { readonly kind: "hunk"; readonly text: string }
  /** A line of the file. `line` is absent when neither side numbers it. */
  | {
      readonly kind: "context" | "added" | "removed";
      readonly text: string;
      readonly line?: number;
    }
  /** git's own note, e.g. "\ No newline at end of file". Never a file line. */
  | { readonly kind: "note"; readonly text: string };

/** What a patch adds up to. */
export interface ParsedDiff {
  readonly rows: readonly DiffRow[];
  /**
   * Whether any `@@` header was found.
   *
   * False with a non-empty patch means git printed a header and no hunks —
   * a pure rename, or a mode change. That is a real answer ("nothing inside
   * the file changed") and must not be drawn as an empty screen, which reads
   * as "this did not load".
   */
  readonly hunked: boolean;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Split a unified diff into rows.
 *
 * Everything before the first `@@` is git's own file header (`diff --git`,
 * `index`, `---`, `+++`). It is dropped: the screen already shows the path,
 * and those four lines would push the first real change below the fold on a
 * phone. A `+++`/`---` line inside a hunk cannot be confused with them because
 * a body line always carries exactly one prefix character.
 */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let hunked = false;

  // A trailing newline splits into one empty tail element that is not a line
  // of the file. Dropping it here keeps an empty row off the bottom of every
  // patch git produces, which is all of them.
  const lines = patch.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      hunked = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    // Still in the file header. `hunked` rather than a prefix test: a header
    // line can begin with any of the body prefixes ("--- a/x", "+++ b/x"), and
    // reading those as content is how a diff viewer draws two phantom rows at
    // the top of every file.
    if (!hunked) continue;
    if (line.startsWith("\\")) {
      rows.push({ kind: "note", text: line.slice(1).trim() });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "added", text: line.slice(1), line: newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "removed", text: line.slice(1), line: oldLine });
      oldLine += 1;
      continue;
    }
    // A context line carries a leading space. An empty string here is an empty
    // context line from a producer that stripped it, and dropping the row would
    // silently shift every number below it.
    rows.push({ kind: "context", text: line.slice(1), line: newLine });
    oldLine += 1;
    newLine += 1;
  }
  return { rows, hunked };
}
