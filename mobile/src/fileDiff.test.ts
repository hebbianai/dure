import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./fileDiff";

describe("parseUnifiedDiff", () => {
  it("drops git's file header and keeps the hunk", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/.gitignore b/.gitignore",
        "index 1a2b3c4..5d6e7f8 100644",
        "--- a/.gitignore",
        "+++ b/.gitignore",
        "@@ -12,4 +12,5 @@",
        " build/",
        "+.kotlin/errors/",
        " local.properties",
        "",
      ].join("\n"),
    );

    expect(parsed.hunked).toBe(true);
    // Four header lines in, one hunk row and three body rows out. `--- a/…`
    // and `+++ b/…` read as content is how a viewer draws two phantom rows at
    // the top of every file.
    expect(parsed.rows.map((row) => row.kind)).toEqual(["hunk", "context", "added", "context"]);
  });

  it("numbers rows against the new file, and a deletion against the old one", () => {
    const parsed = parseUnifiedDiff(
      ["@@ -12,3 +12,3 @@", " keep", "-gone", "+fresh", " tail", ""].join("\n"),
    );

    // The deleted line's 13 is the old file's; the added line takes 13 in the
    // new file. Showing the new number for a row that exists only in the old
    // file would point at a line somebody cannot open.
    expect(parsed.rows).toEqual([
      { kind: "hunk", text: "@@ -12,3 +12,3 @@" },
      { kind: "context", text: "keep", line: 12 },
      { kind: "removed", text: "gone", line: 13 },
      { kind: "added", text: "fresh", line: 13 },
      { kind: "context", text: "tail", line: 14 },
    ]);
  });

  it("keeps counting across a second hunk from its own header", () => {
    const parsed = parseUnifiedDiff(
      ["@@ -1,2 +1,2 @@", " a", "+b", "@@ -80,2 +81,2 @@", " far", "+away", ""].join("\n"),
    );

    // The second hunk restarts from its own header. Carrying the first hunk's
    // counter forward is the classic bug, and it is invisible until somebody
    // compares the numbers with the file.
    expect(parsed.rows.filter((row) => row.kind === "added")).toEqual([
      { kind: "added", text: "b", line: 2 },
      { kind: "added", text: "away", line: 82 },
    ]);
  });

  it("keeps an empty context line rather than dropping the row", () => {
    const parsed = parseUnifiedDiff(["@@ -1,3 +1,3 @@", " a", " ", " c", ""].join("\n"));

    // Dropping a blank row would shift every number under it by one.
    expect(parsed.rows.map((row) => ("line" in row ? row.line : undefined))).toEqual([
      undefined,
      1,
      2,
      3,
    ]);
  });

  it("reads git's no-newline note as a note, not as a deleted line", () => {
    const parsed = parseUnifiedDiff(
      ["@@ -1 +1 @@", "-old", "\\ No newline at end of file", "+new", ""].join("\n"),
    );

    expect(parsed.rows[2]).toEqual({ kind: "note", text: "No newline at end of file" });
    // And it did not consume a line number: the added line is still line 1.
    expect(parsed.rows[3]).toEqual({ kind: "added", text: "new", line: 1 });
  });

  it("says a header-only patch had no hunks rather than returning nothing", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/old.ts b/new.ts",
        "similarity index 100%",
        "rename from old.ts",
        "rename to new.ts",
        "",
      ].join("\n"),
    );

    // A pure rename is a real answer — "nothing inside the file changed". An
    // empty screen with no explanation reads as a failed load.
    expect(parsed.rows).toEqual([]);
    expect(parsed.hunked).toBe(false);
  });

  it("returns nothing for an empty patch", () => {
    expect(parseUnifiedDiff("")).toEqual({ rows: [], hunked: false });
  });
});
