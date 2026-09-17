import { describe, expect, it } from "vitest";
import { sanitizeSessionTitle } from "@/lib/sessions/sessionTitle";

describe("sanitizeSessionTitle", () => {
  it.each([
    "<task-notification><task-id>b3jd014iq</task-id><status>completed</status><summary>Done</summary></task-notification>",
    "<task-notification>\n<task-id>b3jd014iq</task-id>\n<output-file>/tmp/task.output</output-file>",
    "<system-reminder><task-notification><task-id>b3jd014iq</task-id></task-notification></system-reminder>",
  ])("omits internal task notifications from presentation: %s", (text) => {
    expect(sanitizeSessionTitle(text)).toBe("");
  });

  it("preserves human text surrounding internal task notifications", () => {
    expect(sanitizeSessionTitle(
      "Review <div> rendering <task-notification><task-id>one</task-id></task-notification> and tests <task-notification><task-id>two</task-id></task-notification>",
    )).toBe("Review <div> rendering and tests");
  });

  it("unwraps the grok prompt envelope", () => {
    expect(sanitizeSessionTitle("<user_query> hi </user_query>")).toBe("hi");
    expect(sanitizeSessionTitle("<user_query>\nhi\n</user_query>")).toBe("hi");
  });

  it("drops envelope tags left dangling by a truncated title", () => {
    expect(sanitizeSessionTitle("<user_query> refactor the store")).toBe("refactor the store");
    expect(sanitizeSessionTitle("fix the bell </user_query>")).toBe("fix the bell");
  });

  it("keeps plain titles as a single trimmed line", () => {
    expect(sanitizeSessionTitle("  claude · agent-ide  ")).toBe("claude · agent-ide");
    expect(sanitizeSessionTitle("build\tthe   runtime")).toBe("build the runtime");
    expect(sanitizeSessionTitle(undefined)).toBe("");
  });

  it("removes a provider activity glyph from the start of a human title", () => {
    expect(sanitizeSessionTitle("✻ 서비스 업그레이드")).toBe("서비스 업그레이드");
    expect(sanitizeSessionTitle("✳ Review authentication flow")).toBe(
      "Review authentication flow",
    );
    for (const frame of ["◐", "◓", "◑", "◒"]) {
      expect(sanitizeSessionTitle(`${frame} Figma integration`)).toBe(
        "Figma integration",
      );
    }
    for (const frame of ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]) {
      expect(sanitizeSessionTitle(`${frame} terminal-parsing`)).toBe(
        "terminal-parsing",
      );
    }
    expect(sanitizeSessionTitle("⠋terminal-parsing")).toBe("⠋terminal-parsing");
  });

  it("removes Pi branding from its terminal title envelope", () => {
    expect(sanitizeSessionTitle("π - PI session - agent-ide")).toBe(
      "PI session - agent-ide",
    );
    expect(sanitizeSessionTitle("π – Review changes – agent-ide")).toBe(
      "Review changes – agent-ide",
    );
  });

  it("leaves inline angle brackets alone", () => {
    expect(sanitizeSessionTitle("fix <div> rendering")).toBe("fix <div> rendering");
    expect(sanitizeSessionTitle("a < b && c > d")).toBe("a < b && c > d");
  });

  it("returns empty when only envelope tags remain, so callers can fall back", () => {
    expect(sanitizeSessionTitle("<user_query></user_query>")).toBe("");
  });
});
