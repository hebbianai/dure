// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OnboardingFolderStart,
} from "@/components/onboarding/OnboardingFolderStart";
import { ProviderInstallCommandRow } from "@/components/agents/ProviderInstallCommandRow";

import { DEFAULT_UI_PREFS, useStore } from "@/store";

afterEach(() => useStore.setState({ uiPrefs: { ...DEFAULT_UI_PREFS } }));

describe("ProviderInstallCommandRow", () => {
  it("shows the provider logo and runs the visible installer on click", () => {
    const onInstall = vi.fn();
    const entry = {
      provider: "claude" as const,
      command: "curl -fsSL https://claude.ai/install.sh | bash",
    };

    const { container } = render(
      <ProviderInstallCommandRow entry={entry} onInstall={onInstall} />,
    );

    const install = screen.getByRole("button", { name: "Claude Code 설치" });
    expect(install.querySelector("svg, img")).toBeTruthy();
    fireEvent.click(install);
    expect(onInstall).toHaveBeenCalledWith(entry);
    expect(container.textContent).toContain(entry.command);
  });

  it("keeps missing-provider installers visible when another CLI is installed", () => {
    render(
      <OnboardingFolderStart
        steps={[
          { id: "folder", state: "todo", optional: true },
          { id: "cli", state: "done", optional: true },
          { id: "login", state: "unknown", optional: true },
          { id: "firstPane", state: "todo", optional: true },
        ]}
        projectCount={0}
        installedProviders={["codex"]}
        missingCommands={[
          {
            provider: "pi",
            command: "npm install -g @earendil-works/pi-coding-agent",
          },
        ]}
        onInstallProvider={vi.fn()}
        onOpenFolder={vi.fn()}
        onStart={vi.fn()}
        onOpenTerminal={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
    expect(useStore.getState().uiPrefs.defaultProvider).toBe("codex");
    expect(screen.getByText("설치됨")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pi 설치" })).toBeTruthy();
  });
});
