// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GeneralPage } from "@/components/settings/GeneralPage";
import { t } from "@/lib/i18n";
import { DEFAULT_UI_PREFS, useStore } from "@/store";
import { normalizePersistedState, persistedSlice } from "@/lib/persistence/persistedAppState";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  useStore.setState({
    uiPrefs: { ...DEFAULT_UI_PREFS },
    providerLaunchDefaults: null,
    providerLaunchDefaultsBackend: null,
    providerLaunchDefaultsProfileId: null,
    providerLaunchDefaultsError: null,
  });
});

describe("GeneralPage", () => {

  it("lets Pro choose new Agent panes and persists the choice without changing existing agents", () => {
    vi.stubEnv("PROD", false);
    useStore.setState((state) => ({ uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" } }));
    const agents = useStore.getState().agents;
    const view = render(<GeneralPage />);
    const terminal = screen.getByRole("radio", { name: t("common.terminal") });
    expect(terminal.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: t("settings.general.defaultAgentPane.chat") }));
    expect(useStore.getState().uiPrefs.defaultAgentPane).toBe("chat");
    const roundTrip = normalizePersistedState(JSON.parse(JSON.stringify(persistedSlice(useStore.getState()))));
    expect(roundTrip.uiPrefs.defaultAgentPane).toBe("chat");
    expect(useStore.getState().agents).toBe(agents);
    view.unmount();
    render(<GeneralPage />);
    expect(screen.getByRole("radio", { name: t("settings.general.defaultAgentPane.chat") }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: t("common.terminal") }));
    expect(useStore.getState().uiPrefs.defaultAgentPane).toBe("terminal");
  });

  it("hides the pane choice in Basic-only while preserving a saved Pro value", () => {
    vi.stubEnv("VITE_DURE_INTERFACE_MODE_POLICY", "basic-only");
    useStore.setState((state) => ({ uiPrefs: { ...state.uiPrefs, interfaceMode: "pro", defaultAgentPane: "chat" } }));
    render(<GeneralPage />);
    expect(screen.queryByRole("radio", { name: t("settings.general.defaultAgentPane.chat") })).toBeNull();
    expect(useStore.getState().uiPrefs.defaultAgentPane).toBe("chat");
  });

  it("세그먼트를 누르면 그 설정이 스토어에 반영된다", () => {
    render(<GeneralPage />);

    fireEvent.click(screen.getByRole("radio", { name: "나란히" }));
    expect(useStore.getState().uiPrefs.defaultDiffView).toBe("split");

    fireEvent.click(screen.getByRole("radio", { name: "숨김" }));
    expect(useStore.getState().uiPrefs.defaultDiffFileTree).toBe("hidden");
  });

  it("스위치는 두 줄짜리 행에서도 해당 설정만 바꾼다", () => {
    render(<GeneralPage />);
    const before = useStore.getState().uiPrefs.minimap;

    fireEvent.click(screen.getByRole("switch", { name: "미니맵" }));

    expect(useStore.getState().uiPrefs.minimap).toBe(!before);
  });

  it("hides only the mode selector in Basic-only and preserves hidden-control restore", () => {
    vi.stubEnv("VITE_DURE_INTERFACE_MODE_POLICY", "basic-only");
    useStore.setState((state) => ({
      uiPrefs: {
        ...state.uiPrefs,
        interfaceMode: "pro" as const,
        hiddenToolbarControls: ["launch-model"],
      },
    }));
    render(<GeneralPage />);

    expect(screen.queryByText(t("settings.general.interfaceMode.title"))).toBeNull();
    expect(screen.getByText(t("settings.general.hiddenControls.title"))).toBeTruthy();
    const restore = screen.getByRole("button", {
      name: t("settings.general.hiddenControls.restore"),
    });
    fireEvent.click(restore);
    expect(useStore.getState().uiPrefs.hiddenToolbarControls).toEqual([]);
  });

  it("backend projection 실패를 같은 영역에 남기고 provider 토글을 잠근다", () => {
    useStore.setState({
      providerLaunchDefaults: null,
      providerLaunchDefaultsError: "provider_launch_defaults_malformed",
    });
    render(<GeneralPage />);

    expect(screen.getByRole("alert").textContent).toContain(
      t("settings.general.providerDefaults.failed"),
    );
    for (const control of screen.getAllByRole("switch", {
      name: /권한 확인 건너뛰고 실행/,
    })) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("기본 에이전트 칩을 고르면 uiPrefs.defaultProvider에 반영되고 Auto는 지운다", () => {
    render(<GeneralPage />);

    fireEvent.click(screen.getByRole("radio", { name: /Codex/ }));
    expect(useStore.getState().uiPrefs.defaultProvider).toBe("codex");

    fireEvent.click(
      screen.getByRole("radio", { name: t("settings.general.defaultProvider.auto") }),
    );
    expect(useStore.getState().uiPrefs.defaultProvider).toBeUndefined();
  });
});
