// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  availableProviders,
  detectInstalledProviders,
  useAvailableProviders,
  useQuickStartProviders,
} from "@/lib/agents/agentInstalls";
import { agentLogoIds } from "@/lib/agents/agentLogos";
import { useStore } from "@/store";
import { PROVIDERS, type Provider } from "@/types";

const mocks = vi.hoisted(() => ({
  homeDir: vi.fn(),
  providerPreflight: vi.fn(),
  runShell: vi.fn(),
}));

vi.mock("@/lib/ipc/process", () => ({ runShell: mocks.runShell }));
vi.mock("@/lib/ipc", () => ({
  homeDir: mocks.homeDir,
  providerPreflight: mocks.providerPreflight,
}));
vi.mock("@/lib/workspace/desktop/desktopPlatform", () => ({
  detectDesktopPlatform: () => "windows",
}));

beforeEach(() => {
  useStore.setState({ installedAgents: [], uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "pro" } });
  mocks.homeDir.mockReset().mockResolvedValue("C:\\Users\\me");
  mocks.providerPreflight.mockReset().mockImplementation(async ({ provider }) => ({
    provider,
    executable: provider === "codex" || provider === "command-code",
    ready: provider === "codex",
  }));
  mocks.runShell.mockReset().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
});

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("메뉴에 띄울 에이전트", () => {
  it("감지 전에는 기본 세 개만 — 메뉴가 비지 않는다", () => {
    expect(availableProviders()).toEqual(["claude", "codex", "kimi"]);
  });

  it("설치된 에이전트가 PROVIDERS 순서대로 합류한다", () => {
    useStore.setState({ installedAgents: ["opencode", "gemini"] });
    expect(availableProviders()).toEqual(["claude", "codex", "kimi", "gemini", "opencode"]);
  });

  it("설치되지 않은 에이전트는 실행 메뉴에 뜨지 않는다", () => {
    useStore.setState({ installedAgents: ["gemini"] });
    expect(availableProviders()).not.toContain("hermes");
  });
});

describe("로고 연결", () => {
  it("spec의 logo가 가리키는 파일이 실제로 번들돼 있다", () => {
    const bundled = new Set(agentLogoIds());
    const missing = (Object.keys(PROVIDERS) as Provider[])
      .map((id) => PROVIDERS[id].logo)
      .filter((logo): logo is string => !!logo)
      .filter((logo) => !bundled.has(logo));
    expect(missing).toEqual([]);
  });

  it("claude/codex는 내장 글리프를 쓰므로 로고 파일을 지정하지 않는다", () => {
    expect(PROVIDERS.claude.logo).toBeUndefined();
    expect(PROVIDERS.codex.logo).toBeUndefined();
  });

  it("claude/codex 말고는 모두 로고가 붙어 있다", () => {
    const withoutLogo = (Object.keys(PROVIDERS) as Provider[]).filter(
      (id) => !PROVIDERS[id].logo && id !== "claude" && id !== "codex",
    );
    expect(withoutLogo).toEqual([]);
  });
});

describe("detectInstalledProviders", () => {
  it.each(["macos", "linux"] as const)(
    "detects the native Claude launcher through the existing %s shell lookup",
    async (platform) => {
      mocks.runShell.mockResolvedValue({
        stdout: "claude\t/Users/me/.local/bin/claude\n",
        stderr: "",
        code: 0,
      });

      await expect(detectInstalledProviders(platform)).resolves.toEqual(["claude"]);
      expect(mocks.runShell).toHaveBeenCalledTimes(1);
      expect(mocks.providerPreflight).not.toHaveBeenCalled();
    },
  );

  it("uses the native Windows provider lookup instead of a POSIX shell probe", async () => {
    const providers = await detectInstalledProviders();
    expect(providers).toContain("codex");
    expect(mocks.providerPreflight).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        command: "codex",
        cwd: "C:\\Users\\me",
      }),
    );
    expect(providers).not.toContain("command-code");
    expect(mocks.runShell).not.toHaveBeenCalled();
  });

  it("keeps the single-shell POSIX discovery path", async () => {
    mocks.runShell.mockResolvedValue({
      stdout: "codex\t/usr/local/bin/codex\npi\t\n",
      stderr: "",
      code: 0,
    });

    await expect(detectInstalledProviders("linux")).resolves.toContain("codex");
    expect(mocks.runShell).toHaveBeenCalledTimes(1);
  });
});

describe("provider rollout", () => {
	it("hides installed unqualified providers in Basic", () => {
		useStore.setState({
			installedAgents: Object.keys(PROVIDERS) as Provider[],
			uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "basic" },
		});
		expect(availableProviders()).toEqual(["claude", "codex", "kimi"]);
	});

	it("uses effective Basic under the Basic-only policy even with a saved Beta preference", () => {
		vi.stubEnv("VITE_DURE_INTERFACE_MODE_POLICY", "basic-only");
		useStore.setState({ installedAgents: ["gemini"] });
		expect(availableProviders()).toEqual(["claude", "codex", "kimi"]);
	});

	it("offers installed Beta providers in a production build", () => {
		vi.stubEnv("PROD", true);
		useStore.setState({ installedAgents: ["gemini"] });
		expect(availableProviders()).toContain("gemini");
	});

	it("updates launch menus and quick-start buttons when the mode changes without changing installed facts", () => {
		useStore.setState({ installedAgents: ["gemini", "codex"] });
		const { result } = renderHook(() => ({
			available: useAvailableProviders(),
			quick: useQuickStartProviders(3),
		}));
		expect(result.current.available).toContain("gemini");
		expect(result.current.quick.quick).toContain("gemini");
		act(() =>
			useStore.setState({
				uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "basic" },
			}),
		);
		expect(result.current.available).toEqual(["claude", "codex", "kimi"]);
		expect(result.current.quick.available).toEqual(result.current.available);
		expect(result.current.quick.quick).not.toContain("gemini");
		expect(useStore.getState().installedAgents).toEqual(["gemini", "codex"]);
		act(() =>
			useStore.setState({
				uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "pro" },
			}),
		);
		expect(result.current.available).toContain("gemini");
	});
});
