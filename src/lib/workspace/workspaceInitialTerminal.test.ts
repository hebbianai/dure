import { describe, expect, it } from "vitest";
import {
  shouldCreateDefaultInitialTerminal,
  shouldOpenPendingInitialTerminal,
} from "@/lib/workspace/workspaceInitialTerminal";

function layout(...panelIds: string[]) {
  return {
    panels: Object.fromEntries(panelIds.map((panelId) => [panelId, {}])),
  };
}

describe("shouldOpenPendingInitialTerminal", () => {
  it("opens only when both the live and persisted desktop are empty", () => {
    expect(
      shouldOpenPendingInitialTerminal({
        livePanelCount: 0,
        persistedLayout: undefined,
      }),
    ).toBe(true);
  });

  it("does not add a default terminal after a pane move filled the live Dockview", () => {
    expect(
      shouldOpenPendingInitialTerminal({
        livePanelCount: 1,
        persistedLayout: layout("term:moved"),
      }),
    ).toBe(false);
  });

  it("does not add a default terminal while a persisted move awaits projection", () => {
    expect(
      shouldOpenPendingInitialTerminal({
        livePanelCount: 0,
        persistedLayout: layout("term:moved"),
      }),
    ).toBe(false);
  });
});

describe("shouldCreateDefaultInitialTerminal", () => {
  it("does not create a session before a new user reviews the import preview", () => {
    expect(
      shouldCreateDefaultInitialTerminal({
        projectCount: 0,
        onboardingDismissed: false,
      }),
    ).toBe(false);
  });

  it("keeps the normal default terminal after a location exists", () => {
    expect(
      shouldCreateDefaultInitialTerminal({
        projectCount: 1,
        onboardingDismissed: false,
      }),
    ).toBe(true);
  });

  it("opens a usable terminal when the user dismissed onboarding", () => {
    expect(
      shouldCreateDefaultInitialTerminal({
        projectCount: 0,
        onboardingDismissed: true,
      }),
    ).toBe(true);
  });
});
