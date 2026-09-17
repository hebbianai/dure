// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const systemFontFamiliesMock = vi.fn();
vi.mock("@/lib/ipc", () => ({
  systemFontFamilies: () => systemFontFamiliesMock(),
}));
vi.mock("@/components/terminal/TerminalFontPreview", () => ({
  TerminalFontPreview: () => null,
}));
vi.mock("@/components/settings/ThemeSchemePicker", () => ({
  ThemeSchemePicker: () => null,
}));

import { AppearancePage } from "@/components/settings/AppearancePage";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";

const setFont = (name: string) => {
  useStore.getState().setUiPrefs({ terminalFontFamily: name });
};

/** 글꼴군 Select 트리거에 실제로 보이는 글자 (언어 Select와 구분). */
const triggerText = () =>
  screen.getByRole("combobox", { name: "글꼴군" }).textContent ?? "";

beforeEach(() => {
  // Glass/split sections are pro surfaces; basic (fresh-store default)
  // folds them.
  useStore.setState((state) => ({
    uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" as const },
  }));
  systemFontFamiliesMock.mockResolvedValue([
    { name: "Menlo", monospaced: true },
    { name: "Helvetica", monospaced: false },
  ]);
});
afterEach(() => {
  cleanup();
  setFont("");
  useStore.getState().setUiPrefs({
    theme: "dark",
    splitterSize: 4,
    terminalLineHeight: 1.25,
  });
});

describe("AppearancePage 글꼴군", () => {
  it("설치된 글꼴을 읽어온다", async () => {
    render(<AppearancePage />);
    await waitFor(() => expect(systemFontFamiliesMock).toHaveBeenCalled());
  });

  it("저장된 글꼴이 목록에 있으면 그대로 보여준다", async () => {
    setFont("Menlo");
    render(<AppearancePage />);
    await waitFor(() => expect(triggerText()).toContain("Menlo"));
  });

  it("목록에 없는 저장 글꼴도 빈칸이 되지 않는다 — 다시 고를 수 있어야 한다", async () => {
    // SF Mono는 보호된 시스템 글꼴이라 열거되지 않지만 렌더는 된다.
    // 항목을 만들어 주지 않으면 Radix가 트리거를 빈칸으로 그리고, 그 값을
    // 되돌릴 방법이 사라진다.
    setFont("SF Mono");
    render(<AppearancePage />);
    await waitFor(() => expect(systemFontFamiliesMock).toHaveBeenCalled());
    await waitFor(() => expect(triggerText()).toContain("SF Mono"));
  });

  it("열거에 실패해도 저장된 글꼴이 사라지지 않는다", async () => {
    systemFontFamiliesMock.mockRejectedValue(new Error("nope"));
    setFont("SF Mono");
    render(<AppearancePage />);
    await waitFor(() => expect(triggerText()).toContain("SF Mono"));
  });

  it("번들 글꼴은 열거 결과와 무관하게 표시된다", async () => {
    systemFontFamiliesMock.mockResolvedValue([]);
    setFont("Geist Mono Variable");
    render(<AppearancePage />);
    await waitFor(() => expect(triggerText()).toContain("Geist Mono"));
  });

  it("시스템 기본은 빈 값으로 남는다", async () => {
    setFont("");
    render(<AppearancePage />);
    await waitFor(() => expect(systemFontFamiliesMock).toHaveBeenCalled());
    expect(triggerText()).not.toContain("목록에 없음");
  });
});

describe("AppearancePage terminal line height", () => {
  it("commits line height independently from the font size", async () => {
    const previousFontSize = useStore.getState().terminalFontSize;
    render(<AppearancePage />);
    await waitFor(() => expect(systemFontFamiliesMock).toHaveBeenCalled());

    const field = screen.getByLabelText(
      t("settings.appearance.lineHeight.title"),
    );
    fireEvent.change(field, { target: { value: "1.6" } });
    fireEvent.blur(field);

    expect(useStore.getState().uiPrefs.terminalLineHeight).toBe(1.6);
    expect(useStore.getState().terminalFontSize).toBe(previousFontSize);
  });
});

describe("AppearancePage 레이아웃 (시안 2524:68410)", () => {
  it("카드 없이 구획으로 나누고, 이름 있는 구획만 라벨을 단다", async () => {
    const { container } = render(<AppearancePage />);
    await waitFor(() => expect(systemFontFamiliesMock).toHaveBeenCalled());

    for (const label of ["터미널 글꼴", "상태 표시줄"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // 720px 카드(rounded-xl border bg-background)가 다시 붙으면 실패한다.
    expect(container.querySelector('[class*="rounded-xl"]')).toBeNull();
  });

  it("테마 세그먼트가 프리퍼런스를 바꾼다", async () => {
    render(<AppearancePage />);
    await waitFor(() => expect(systemFontFamiliesMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("radio", { name: "라이트" }));

    expect(useStore.getState().uiPrefs.theme).toBe("light");
  });
});

describe("AppearancePage 분할 패널", () => {
  it("does not expose a pane-dimming control", async () => {
    render(<AppearancePage />);
    await waitFor(() => expect(systemFontFamiliesMock).toHaveBeenCalled());

    expect(screen.queryByLabelText("비활성 창 불투명도")).toBeNull();
  });

  it("구분선 두께는 정수 px로 저장된다", async () => {
    render(<AppearancePage />);
    await waitFor(() => expect(systemFontFamiliesMock).toHaveBeenCalled());

    const field = screen.getByLabelText("구분선 두께");
    fireEvent.change(field, { target: { value: "3.6" } });
    fireEvent.blur(field);

    expect(useStore.getState().uiPrefs.splitterSize).toBe(4);
  });
});

describe("AppearancePage language ownership", () => {
	it("does not render a language picker — General owns the language setting", async () => {
		// The same store value was exposed on two pages; a duplicated control is
		// a second writer for one fact and doubles the surface a new user scans.
		render(<AppearancePage />);
		await waitFor(() => expect(systemFontFamiliesMock).toHaveBeenCalled());

		expect(
			screen.queryByRole("combobox", { name: /언어|Language/ }),
		).toBeNull();
	});
});
