import { describe, expect, it } from "vitest";
import { onDesktopPrewarmRequest, requestDesktopPrewarm } from "@/lib/workspace/desktop/desktopPrewarm";

describe("desktopPrewarm channel", () => {
  it("delivers requests to subscribers until they unsubscribe", () => {
    const seen: string[] = [];
    const stop = onDesktopPrewarmRequest((id) => seen.push(id));
    requestDesktopPrewarm("d1");
    requestDesktopPrewarm("d2");
    stop();
    requestDesktopPrewarm("d3");
    expect(seen).toEqual(["d1", "d2"]);
  });
});
