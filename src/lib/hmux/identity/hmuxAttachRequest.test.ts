import { describe, expect, it } from "vitest";
import {
  HmuxAttachRequestError,
  hmuxAttachTargetFromRequest,
} from "@/lib/hmux/identity/hmuxAttachRequest";

describe("Hmux IDE attach request", () => {
  it("accepts one exact human name without opaque ids", () => {
    expect(
      hmuxAttachTargetFromRequest({ name: " hmux-spawn-reliability " }),
    ).toEqual({
      kind: "name",
      name: "hmux-spawn-reliability",
    });
  });

  it("preserves the canonical exact identity request", () => {
    expect(
      hmuxAttachTargetFromRequest({
        sessionId: "standalone-1",
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      kind: "exact",
      sessionId: "standalone-1",
      workspaceId: "workspace-1",
    });
  });

  it("refuses mixed name and identity selectors", () => {
    expect(() =>
      hmuxAttachTargetFromRequest({
        name: "dev",
        sessionId: "standalone-1",
        workspaceId: "workspace-1",
      }),
    ).toThrow(HmuxAttachRequestError);
  });

  it("refuses an incomplete exact identity", () => {
    expect(() =>
      hmuxAttachTargetFromRequest({ sessionId: "standalone-1" }),
    ).toThrow("name or both sessionId and workspaceId are required");
  });
});
