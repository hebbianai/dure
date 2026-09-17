// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DARK_TERMINAL_PALETTE } from "@/lib/theme/terminalTheme";
import { useStore } from "@/store";

const openFileDialogMock = vi.fn();
const messageDialogMock = vi.fn();
const readTextFileMock = vi.fn();
const fileSizeBytesMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openFileDialogMock(...args),
  message: (...args: unknown[]) => messageDialogMock(...args),
}));
vi.mock("@/lib/agents/providerConfig", () => ({
  readTextFile: (...args: unknown[]) => readTextFileMock(...args),
  fileSizeBytes: (...args: unknown[]) => fileSizeBytesMock(...args),
}));

// 위 vi.mock은 호이스팅되므로 실제 import는 그 뒤에 온다.
import { ThemeSchemePicker } from "@/components/settings/ThemeSchemePicker";

// 갤러리 한 번 렌더에 번들 스킴 수십 장이 딸려 온다(카드마다 팔레트 6색 +
// 타일). 기본 5초로는 이 머신에서 동기 테스트가 부하와 무관하게 터진다 —
// origin/main 단독 실행에서도 3건이 타임아웃했다(hebbian-frontend-qa6v).
// 렌더가 느린 것이지 멈춘 것이 아니므로 이 파일만 상한을 올린다.
vi.setConfig({ testTimeout: 30_000 });

const CUSTOM_THEME_JSON = JSON.stringify({
  id: "my-custom",
  name: "My Custom",
  appearance: "dark",
  terminal: DARK_TERMINAL_PALETTE,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useStore.getState().setUiPrefs({ themeScheme: undefined, theme: "dark" });
  useStore.setState({ customThemes: [] });
});

beforeEach(() => {
  // 크기 검사는 content 검증과 별개 관심사라 기본값은 항상 상한 이내로 둔다
  // — 크기 자체를 다루는 테스트만 명시적으로 덮어쓴다.
  fileSizeBytesMock.mockResolvedValue(512);
  // 갤러리 자체를 보는 테스트들은 두 슬롯이 다 펼쳐져 있어야 한다. 펼침이
  // 테마에서 파생되므로(themeSchemeDisclosure) 시스템으로 맞춰 둔다 —
  // 펼침 규칙 자체는 아래 별도 describe에서 검증한다.
  useStore.getState().setUiPrefs({ theme: "system" });
});

describe("ThemeSchemePicker", () => {
  it("스킴 카드를 고르면 해당 슬롯만 persist 대상 uiPrefs에 기록된다", () => {
    render(<ThemeSchemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /Dracula/ }));
    expect(useStore.getState().uiPrefs?.themeScheme?.dark).toBe("dracula");
    expect(useStore.getState().uiPrefs?.themeScheme?.light).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: /Solarized Light/ }));
    expect(useStore.getState().uiPrefs?.themeScheme).toEqual({
      dark: "dracula",
      light: "solarized-light",
    });
  });

  it("기본 카드를 고르면 슬롯이 비워져 기본 룩으로 돌아간다", () => {
    useStore.getState().setUiPrefs({ themeScheme: { dark: "nord" } });
    render(<ThemeSchemePicker />);
    const defaults = screen.getAllByRole("button", { name: /기본/ });
    fireEvent.click(defaults[0]);
    expect(useStore.getState().uiPrefs?.themeScheme?.dark).toBeUndefined();
  });

  it("다크 슬롯 갤러리에는 다크 스킴만, 선택 상태는 aria-pressed로 노출된다", () => {
    useStore.getState().setUiPrefs({ themeScheme: { dark: "tokyo-night" } });
    render(<ThemeSchemePicker />);
    const selected = screen
      .getAllByRole("button")
      .filter((el) => el.getAttribute("aria-pressed") === "true");
    expect(selected.map((el) => el.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Tokyo Night")]),
    );
    expect(screen.getAllByRole("button", { name: /Solarized Light/ }).length).toBe(1);
  });

  it("persist에 내장(hebbian-*) id가 남아 있으면 기본 대신 레거시 카드가 선택 상태로 뜬다", () => {
    useStore.getState().setUiPrefs({ themeScheme: { dark: "hebbian-dark" } });
    render(<ThemeSchemePicker />);
    const legacy = screen.getByRole("button", { name: /레거시 선택/ });
    expect(legacy.getAttribute("aria-pressed")).toBe("true");
    // "기본" 텍스트는 레거시 카드에도(선택 안 됨) 나타나지 않으니 이름으로
    // 걸러도 다크 슬롯의 기본 카드 하나만 잡힌다.
    const defaults = screen.getAllByRole("button", { name: /기본/ });
    expect(defaults[0].getAttribute("aria-pressed")).toBe("false");
    // 레거시 카드를 클릭하면 정리된다
    fireEvent.click(legacy);
    expect(useStore.getState().uiPrefs?.themeScheme?.dark).toBeUndefined();
  });

  it("유효한 JSON을 가져오면 커스텀 카드로 나타나고 즉시 선택할 수 있다", async () => {
    openFileDialogMock.mockResolvedValue("/tmp/my-custom.json");
    readTextFileMock.mockResolvedValue(CUSTOM_THEME_JSON);
    render(<ThemeSchemePicker />);

    fireEvent.click(screen.getByRole("button", { name: /커스텀 테마 JSON 가져오기/ }));

    await waitFor(() => {
      expect(useStore.getState().customThemes.map((theme) => theme.id)).toEqual(["my-custom"]);
    });
    expect(messageDialogMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /My Custom/ }));
    expect(useStore.getState().uiPrefs?.themeScheme?.dark).toBe("my-custom");
  });

  it("id가 이미 쓰이고 있으면 가져오기를 거부하고 사유를 보여준다", async () => {
    openFileDialogMock.mockResolvedValue("/tmp/dracula-clone.json");
    readTextFileMock.mockResolvedValue(
      JSON.stringify({
        id: "dracula", // 번들과 충돌
        name: "Dracula Clone",
        appearance: "dark",
        terminal: DARK_TERMINAL_PALETTE,
      }),
    );
    render(<ThemeSchemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /커스텀 테마 JSON 가져오기/ }));

    await waitFor(() => expect(messageDialogMock).toHaveBeenCalledTimes(1));
    expect(messageDialogMock.mock.calls[0][0]).toContain("dracula");
    expect(useStore.getState().customThemes).toHaveLength(0);
  });

  it("형식이 잘못된 JSON은 검증 에러를 보여주고 store에 추가하지 않는다", async () => {
    openFileDialogMock.mockResolvedValue("/tmp/broken.json");
    readTextFileMock.mockResolvedValue(JSON.stringify({ id: "x", name: "X" })); // appearance 누락
    render(<ThemeSchemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /커스텀 테마 JSON 가져오기/ }));

    await waitFor(() => expect(messageDialogMock).toHaveBeenCalledTimes(1));
    expect(useStore.getState().customThemes).toHaveLength(0);
  });

  it("파일 선택을 취소하면 아무 것도 하지 않는다", async () => {
    openFileDialogMock.mockResolvedValue(null);
    render(<ThemeSchemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /커스텀 테마 JSON 가져오기/ }));

    await waitFor(() => expect(openFileDialogMock).toHaveBeenCalledTimes(1));
    expect(fileSizeBytesMock).not.toHaveBeenCalled();
    expect(readTextFileMock).not.toHaveBeenCalled();
    expect(useStore.getState().customThemes).toHaveLength(0);
  });

  it("파일이 상한(64KB)보다 크면 내용을 읽지 않고 거부한다", async () => {
    openFileDialogMock.mockResolvedValue("/tmp/huge.json");
    fileSizeBytesMock.mockResolvedValue(64 * 1024 + 1);
    render(<ThemeSchemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /커스텀 테마 JSON 가져오기/ }));

    await waitFor(() => expect(messageDialogMock).toHaveBeenCalledTimes(1));
    expect(readTextFileMock).not.toHaveBeenCalled();
    expect(useStore.getState().customThemes).toHaveLength(0);
  });

  it("크기 조회가 0이면(읽기 실패) 내용을 읽지 않고 거부한다", async () => {
    openFileDialogMock.mockResolvedValue("/tmp/unreadable.json");
    fileSizeBytesMock.mockResolvedValue(0);
    render(<ThemeSchemePicker />);
    fireEvent.click(screen.getByRole("button", { name: /커스텀 테마 JSON 가져오기/ }));

    await waitFor(() => expect(messageDialogMock).toHaveBeenCalledTimes(1));
    expect(readTextFileMock).not.toHaveBeenCalled();
  });

  it("커스텀 스킴 제거 버튼은 목록에서 지우고 선택돼 있었으면 슬롯도 비운다", () => {
    useStore.setState({
      customThemes: [
        { id: "my-custom", name: "My Custom", appearance: "dark", terminal: DARK_TERMINAL_PALETTE },
      ],
    });
    useStore.getState().setUiPrefs({ themeScheme: { dark: "my-custom" } });
    render(<ThemeSchemePicker />);

    fireEvent.click(screen.getByRole("button", { name: "커스텀 스킴 제거" }));

    expect(useStore.getState().customThemes).toHaveLength(0);
    expect(useStore.getState().uiPrefs?.themeScheme?.dark).toBeUndefined();
  });
});

/** 각 슬롯 헤더가 접기/펼치기 버튼이다 — 제목이 접근 가능한 이름의 앞부분. */
const darkHeader = () => screen.getByRole("button", { name: /^컬러 스킴/ });
const lightHeader = () => screen.getByRole("button", { name: /^라이트 컬러 스킴/ });
const isOpen = (header: HTMLElement) => header.getAttribute("aria-expanded") === "true";
const setTheme = (theme: "system" | "dark" | "light") => {
  act(() => {
    useStore.getState().setUiPrefs({ theme });
  });
};

describe("ThemeSchemePicker 펼침", () => {
  it("시스템이면 둘 다 펼쳐진다 — 다크·라이트가 둘 다 실제로 쓰인다", () => {
    setTheme("system");
    render(<ThemeSchemePicker />);
    expect(isOpen(darkHeader())).toBe(true);
    expect(isOpen(lightHeader())).toBe(true);
    expect(screen.getAllByRole("button", { name: /Dracula/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Solarized Light/ })).toHaveLength(1);
  });

  it("다크로 고정하면 다크만 펼쳐지고 라이트 카드는 접힌다", () => {
    setTheme("dark");
    render(<ThemeSchemePicker />);
    expect(isOpen(darkHeader())).toBe(true);
    expect(isOpen(lightHeader())).toBe(false);
    expect(screen.queryByRole("button", { name: /Solarized Light/ })).toBeNull();
  });

  it("라이트로 고정하면 라이트만 펼쳐진다", () => {
    setTheme("light");
    render(<ThemeSchemePicker />);
    expect(isOpen(darkHeader())).toBe(false);
    expect(isOpen(lightHeader())).toBe(true);
    expect(screen.queryByRole("button", { name: /Dracula/ })).toBeNull();
  });

  it("접힌 슬롯도 헤더로 직접 펼칠 수 있다 — 미리 골라 둘 수 있어야 한다", () => {
    setTheme("dark");
    render(<ThemeSchemePicker />);
    fireEvent.click(lightHeader());
    expect(isOpen(lightHeader())).toBe(true);
    // 한 번에 하나만 열리는 아코디언이 아니다 — 다른 쪽은 그대로 둔다.
    expect(isOpen(darkHeader())).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Solarized Light/ }));
    expect(useStore.getState().uiPrefs?.themeScheme?.light).toBe("solarized-light");
  });

  it("테마를 바꾸면 손으로 접은 상태를 잊고 새 테마 기준으로 되돌아간다", () => {
    setTheme("dark");
    render(<ThemeSchemePicker />);
    fireEvent.click(darkHeader()); // 손으로 접는다
    expect(isOpen(darkHeader())).toBe(false);

    setTheme("light");
    expect(isOpen(darkHeader())).toBe(false);
    expect(isOpen(lightHeader())).toBe(true);

    setTheme("system");
    expect(isOpen(darkHeader())).toBe(true);
    expect(isOpen(lightHeader())).toBe(true);
  });

  it("접힌 슬롯 헤더는 지금 고른 스킴을 요약해 보여준다", () => {
    useStore.getState().setUiPrefs({ themeScheme: { light: "solarized-light" } });
    setTheme("dark");
    render(<ThemeSchemePicker />);
    expect(lightHeader().textContent).toContain("Solarized Light");
  });
});
