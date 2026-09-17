import { describe, expect, it } from "vitest";
import { shellQuote } from "@/lib/platform/shell";

describe("shellQuote", () => {
  it("quotes spaces and apostrophes as one POSIX shell word", () => {
    expect(shellQuote("/tmp/a b's")).toBe("'/tmp/a b'\\''s'");
  });

  it("keeps command substitutions literal", () => {
    expect(shellQuote("$(touch /tmp/nope); rm -rf target")).toBe(
      "'$(touch /tmp/nope); rm -rf target'",
    );
  });
});
