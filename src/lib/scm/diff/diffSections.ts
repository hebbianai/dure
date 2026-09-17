export interface DiffSection {
  /** null identifies the commit/stat preamble rather than a file patch. */
  file: string | null;
  text: string;
  /** One-based line in the original document, including any preamble. */
  fromLine: number;
}

const unescapeGitPath = (path: string): string =>
  path.replace(/\\(["\\tn])/g, (_, c: string) => (c === "t" ? "\t" : c === "n" ? "\n" : c));
const unquotePath = (path: string): string =>
  path.startsWith('"') && path.endsWith('"') ? unescapeGitPath(path.slice(1, -1)) : path;
const stripPathPrefix = (path: string): string => unquotePath(path).replace(/^[ab]\//, "");

/** Binary/mode-only patches may have only this header. Prefer a symmetric split
 * when the actual filename contains " b/"; metadata can resolve renamed paths. */
function parseGitHeaderPath(line: string): string {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const match = rest.match(/^"a\/((?:[^"\\]|\\.)*)" "b\/((?:[^"\\]|\\.)*)"$/);
    if (match) return unescapeGitPath(match[2]);
  }
  if (rest.startsWith("a/")) {
    const body = rest.slice(2);
    for (let i = 0; i < body.length; i++) {
      if (body.startsWith(" b/", i) && body.slice(0, i) === body.slice(i + 3)) return body.slice(i + 3);
    }
  }
  const marker = rest.lastIndexOf(" b/");
  return marker >= 0 ? rest.slice(marker + 3) : rest;
}

/** One scan owns file boundaries, resolved paths and source lines for review,
 * commit detail and syntax highlighting. Preserve original patch text verbatim. */
export function splitDiffSections(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  const lines = diff.split("\n");
  let start = 0;
  let startOffset = 0;
  let offset = 0;
  let file: string | null = null;
  let inHeader = false;
  let sawNewPath = false;
  const flush = (end: number) => {
    const text = diff.slice(startOffset, end);
    if (file !== null || text.trim()) sections.push({ file, text, fromLine: start + 1 });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      flush(Math.max(0, offset - 1));
      start = i;
      startOffset = offset;
      inHeader = true;
      sawNewPath = false;
      file = parseGitHeaderPath(line);
    } else if (inHeader && line.startsWith("@@")) {
      inHeader = false;
    } else if (inHeader && !sawNewPath && line.startsWith("rename to ")) {
      // Rename metadata contains the actual path, without diff's a/ or b/ prefix.
      file = unquotePath(line.slice("rename to ".length));
    } else if (inHeader && line.startsWith("+++ ")) {
      // Git may append a tab delimiter; other trailing whitespace belongs to the filename.
      const path = line.slice(4).replace(/\t$/, "");
      if (path !== "/dev/null") {
        file = stripPathPrefix(path);
        sawNewPath = true;
      }
    } else if (inHeader && !sawNewPath && line.startsWith("--- ")) {
      const path = line.slice(4).replace(/\t$/, "");
      if (path !== "/dev/null") file = stripPathPrefix(path);
    }
    offset += line.length + 1;
  }
  flush(diff.length);
  return sections;
}
