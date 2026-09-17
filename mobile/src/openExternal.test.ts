import { describe, expect, it } from "vitest";
import externalLinks from "../src-tauri/capabilities/external-links.json";
import { FEEDBACK_ISSUES_URL, HELP_URL, feedbackUrl, openExternal } from "./openExternal";

/**
 * The globs the opener capability allows, read from the capability file itself
 * so the test and the app agree on one authority for what may be opened.
 */
function allowedPrefixes(): string[] {
  return externalLinks.permissions.flatMap((permission) =>
    permission.allow.map((entry) => entry.url.replace(/\*$/, "")),
  );
}

describe("openExternal", () => {
  it("피드백 주소는 이슈 폼을 버전과 UA로 미리 채운다", () => {
    const url = new URL(feedbackUrl({ version: "0.1.4", userAgent: "Mozilla/5.0 (iPhone)" }));
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/hebbianai/hebbian-releases/issues/new");
    expect(url.searchParams.get("title")).toBe("[mobile] ");
    expect(url.searchParams.get("body")).toContain("Dure Mobile 0.1.4");
    expect(url.searchParams.get("body")).toContain("Mozilla/5.0 (iPhone)");
  });

  it("도움말과 피드백 주소는 opener 권한 범위 안에 있다", () => {
    const prefixes = allowedPrefixes();
    expect(prefixes.length).toBeGreaterThan(0);
    for (const url of [HELP_URL, FEEDBACK_ISSUES_URL]) {
      expect(prefixes.some((prefix) => url.startsWith(prefix))).toBe(true);
    }
  });

  it("opener가 거부한 이유를 그대로 돌려준다", async () => {
    await expect(
      openExternal("https://x/", () => Promise.reject("Not allowed to open url x")),
    ).resolves.toBe("Not allowed to open url x");
  });

  it("열리면 null을 돌려준다", async () => {
    await expect(openExternal("https://x/", () => Promise.resolve())).resolves.toBeNull();
  });
});
