// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { t } from "@/lib/i18n";

vi.mock("@/lib/workspace/desktop/desktopPlatform", () => ({
  isMacPlatform: () => false,
}));

vi.mock("@/components/settings/AccountsPage", () => ({
  AccountsPage: () => <div>Accounts</div>,
}));

vi.mock("@/components/settings/GeneralPage", () => ({
  GeneralPage: () => <div>General page body</div>,
}));

afterEach(cleanup);

describe("SettingsDialog", () => {
  it("opens on the General page by default, not Accounts", () => {
    // 첫 방문 랜딩은 가장 단순한 페이지여야 한다(철학 불변조건 11: 간결한
    // 기본값). Accounts는 설정 중 가장 복잡한 표면이라 기본 랜딩으로 부적합.
    render(<SettingsDialog onClose={vi.fn()} />);

    expect(screen.getByText("General page body")).toBeTruthy();
    expect(screen.queryByText("Accounts")).toBeNull();
  });

  it("still honors an explicit initialPage", () => {
    render(<SettingsDialog onClose={vi.fn()} initialPage="accounts" />);

    expect(screen.getByText("Accounts")).toBeTruthy();
  });

  it("keeps the close control in a fixed header above the scrolling page", () => {
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} />);

    const close = screen.getByRole("button", { name: t("common.close") });
    const header = close.closest('[data-slot="settings-dialog-header"]');
    const scrollPage = document.querySelector(
      '[data-slot="settings-dialog-scroll-page"]',
    );

    expect(header).not.toBeNull();
    expect(header?.nextElementSibling).toBe(scrollPage);
    expect(scrollPage?.contains(close)).toBe(false);

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
