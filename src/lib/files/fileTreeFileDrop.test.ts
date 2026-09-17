import { describe, expect, it } from "vitest";
import { ExternalFileDropError } from "./externalFileDrop";
import { describeFileTreeFileDropError } from "./fileTreeFileDrop";

/** Key-passthrough t(): renders the semantic ID plus any interpolation vars
 *  so var extraction (e.g. the destination filename) stays observable. */
const translate = (key: string, vars?: Record<string, string | number>) =>
  [key, ...Object.values(vars ?? {}).map(String)].join(" ");

describe("file tree file drop", () => {
  it("shares bounded external-file errors with terminal drops", () => {
    expect(
      describeFileTreeFileDropError(
        new ExternalFileDropError("too_many_files"),
        translate,
      ),
    ).toBe("files.transfer.tooManyFiles");
  });

  it("turns local and SSH no-clobber failures into the same message", () => {
    expect(
      describeFileTreeFileDropError(
        "dropped_file_destination_exists: README.md",
        translate,
      ),
    ).toBe("files.transfer.duplicateName README.md");
    expect(
      describeFileTreeFileDropError(
        "dropped_files_remote_publish_failed: dropped_file_destination_exists: README.md",
        translate,
      ),
    ).toBe("files.transfer.duplicateName README.md");
  });
});
