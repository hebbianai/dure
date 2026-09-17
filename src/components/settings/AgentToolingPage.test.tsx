// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const runShell = vi.fn();
const installDureCli = vi.fn();
const dureCliInstallStatus = vi.fn();

vi.mock("@/lib/ipc/process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc/process")>()),
  runShell: (cmd: string) => runShell(cmd),
}));
vi.mock("@/lib/ipc/system", () => ({
  installDureCli: () => installDureCli(),
  dureCliInstallStatus: () => dureCliInstallStatus(),
}));

import { AgentToolingPage } from "@/components/settings/AgentToolingPage";
import { resetUpdateNotices } from "@/lib/updates/updateNotice";

function integrationDetail(provider: "claude" | "codex", status: string) {
  return {
    provider,
    status,
    installRoot: `/tmp/provider/${provider}`,
    installRootRef: `install-${provider}-${"a".repeat(32)}`,
    version: "0.1.4+test",
    digest: "a".repeat(64),
    channel: "dev-pane",
    transportRef: "authenticated-control-channel:test",
    capabilities: ["event_cursor_v1"],
    fixCommand: `dure integration install --global --provider ${provider} --approve-global-config`,
    updateCommand: `dure integration update --global --provider ${provider} --approve-global-config`,
    uninstallCommand: `dure integration uninstall --global --provider ${provider} --approve-global-config`,
		refreshCommand: null,
  };
}

function skillDetail(provider: "claude" | "codex", name: string, state: string) {
  return {
    provider,
    name,
    state,
    target: `/${provider}/skills/${name}/SKILL.md`,
    fixCommand: `dure skills install ${name} --global --provider ${provider}`,
    updateCommand: `dure skills update ${name} --global --provider ${provider}`,
  };
}

/** Mirrors the doctor's own "mark everything current" transform: the
 * integration and skills dependencies each carry per-provider details whose
 * states must move to "current" alongside the dependency-level `ok` flag, or
 * the parser drops the whole entry as inconsistent. */
function toCurrentDependency(dependency: (typeof DOCTOR.dependencies)[number]) {
  if (dependency.id === "orchestration-integration") {
    return {
      ...dependency,
      ok: true,
      details: dependency.details?.map((detail) => ({ ...detail, status: "current" })),
    };
  }
  if (dependency.id === "dure-skills") {
    return {
      ...dependency,
      ok: true,
      details: dependency.details?.map((detail) => ({ ...detail, state: "current" })),
    };
  }
  return { ...dependency, ok: true };
}

const DOCTOR = {
  schemaVersion: 1,
  dependencies: [
    {
      id: "orchestration-integration",
      label: "durable orchestration integration",
      ok: false,
      fixCommand: "dure integration install --global --approve-global-config",
      updateCommand: "dure integration update --global --approve-global-config",
      uninstallCommand: "dure integration uninstall --global --approve-global-config",
      details: [integrationDetail("claude", "current"), integrationDetail("codex", "outdated")],
    },
    {
      id: "session-hook",
      label: "Claude Code SessionStart hook",
      ok: true,
      fixCommand: "dure hooks install",
    },
    {
      id: "dure-skills",
      label: "Dure skills",
      ok: false,
      fixCommand: "dure skills install --global",
      updateCommand: "dure skills update --all --global",
      details: [skillDetail("claude", "dure-cli", "missing")],
    },
  ],
};

const CURRENT_CLI = {
  state: "current",
  installed: {
    version: "0.1.4+current",
    digest: "c".repeat(64),
    installRoot: "/cli/current",
  },
  available: {
    version: "0.1.4+current",
    digest: "c".repeat(64),
    installRoot: "/cli/current",
  },
};

const VERIFIED_CHANNEL_CLI = {
  ...CURRENT_CLI,
  installed: { ...CURRENT_CLI.installed, executablePath: "/verified channel/bin/dure" },
  available: { ...CURRENT_CLI.available, executablePath: "/verified channel/bin/dure" },
};

function stubHealthyCli() {
  runShell.mockImplementation(async (cmd: string) =>
    cmd.includes("doctor")
      ? { code: 0, stdout: JSON.stringify(DOCTOR) }
      : { code: 0, stdout: "dure 1.0.0\n" },
  );
}

beforeEach(() => {
  dureCliInstallStatus.mockResolvedValue(CURRENT_CLI);
});

afterEach(() => {
  cleanup();
  resetUpdateNotices();
  runShell.mockReset();
  installDureCli.mockReset();
  dureCliInstallStatus.mockReset();
});

describe("AgentToolingPage", () => {
  it("guides the next exact repair and refreshes to the remaining partial state", async () => {
    let integrationCurrent = false;
    runShell.mockImplementation(async (cmd: string) => {
      if (cmd.includes("integration update")) {
        integrationCurrent = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd.includes("doctor")) {
        const doctor = {
          ...DOCTOR,
          dependencies: DOCTOR.dependencies.map((dependency) =>
            dependency.id === "orchestration-integration" && integrationCurrent
              ? {
                  ...dependency,
                  ok: true,
                  details: dependency.details?.map((detail) => ({
                    ...detail,
                    status: "current",
                  })),
                }
              : dependency,
          ),
        };
        return { code: 0, stdout: JSON.stringify(doctor), stderr: "" };
      }
      return { code: 0, stdout: "dure 1.0.0\n", stderr: "" };
    });
    render(<AgentToolingPage />);

    const guidance = await screen.findByRole("region", {
      name: "조치가 필요한 에이전트 도구",
    });
    expect(within(guidance).getByText("에이전트 도구 설정이 일부 완료되지 않았습니다.")).toBeTruthy();
    expect(within(guidance).getByText(/2개 항목/)).toBeTruthy();
    fireEvent.click(within(guidance).getByRole("button", { name: "업데이트" }));

    expect(await within(guidance).findByText(/1개 항목/)).toBeTruthy();
    expect(within(guidance).getByText(/Dure 스킬/)).toBeTruthy();
    fireEvent.click(within(guidance).getByRole("button", { name: "설치" }));
    expect(runShell).toHaveBeenCalledWith(
      "dure integration update --global --approve-global-config",
    );
    await vi.waitFor(() => {
      expect(runShell).toHaveBeenCalledWith("dure skills install --global");
    });
  });

  it("runs lifecycle commands through the verified channel CLI, not the login-shell dure", async () => {
    dureCliInstallStatus.mockResolvedValue(VERIFIED_CHANNEL_CLI);
    stubHealthyCli();
    render(<AgentToolingPage />);

    await screen.findByText("dure-cli · Claude");
    fireEvent.click(screen.getByRole("button", { name: "모두 업데이트" }));

    expect(runShell).toHaveBeenCalledWith(
      "'/verified channel/bin/dure' integration update --global --approve-global-config",
    );
    expect(runShell).not.toHaveBeenCalledWith(expect.stringMatching(/^dure /));
  });

  it("shows truthful per-provider integration lifecycle state", async () => {
    stubHealthyCli();
    render(<AgentToolingPage />);
    await screen.findByText("dure-cli · Claude");

    expect(screen.getByText("Durable orchestration 연동 · Claude")).toBeTruthy();
    expect(screen.getByText("Durable orchestration 연동 · Codex")).toBeTruthy();
    expect(screen.getAllByText("설치됨 · 최신")).toHaveLength(2);
    expect(screen.getByText("업데이트 필요")).toBeTruthy();
    expect(screen.getByRole("button", { name: "업데이트" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "모두 업데이트" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "설치" })).toBeTruthy();
    expect(screen.getByText("설치 안 됨")).toBeTruthy();
    expect(screen.getByText("/claude/skills/dure-cli/SKILL.md")).toBeTruthy();
    expect(screen.getByText(/\/tmp\/provider\/codex · 0\.1\.4\+test · a{12} · dev-pane · authenticated-control-channel:test/)).toBeTruthy();
  });

  it("updates every provider integration directly from one action", async () => {
    stubHealthyCli();
    render(<AgentToolingPage />);

    await screen.findByText("dure-cli · Claude");
    fireEvent.click(screen.getByRole("button", { name: "모두 업데이트" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(runShell).toHaveBeenCalledWith(
      "dure integration update --global --approve-global-config",
    );
    expect(runShell).not.toHaveBeenCalledWith(expect.stringContaining("--provider"));
  });

  it("keeps provider removal behind the destructive confirmation", async () => {
    stubHealthyCli();
    render(<AgentToolingPage />);

    await screen.findByText("dure-cli · Claude");
    fireEvent.click(screen.getAllByRole("button", { name: "제거" })[0]);

    const confirmation = screen.getByRole("dialog");
    expect(runShell).not.toHaveBeenCalledWith(expect.stringContaining("uninstall"));
    fireEvent.click(within(confirmation).getByRole("button", { name: "제거" }));
    expect(runShell).toHaveBeenCalledWith(
      "dure integration uninstall --global --provider claude --approve-global-config",
    );
  });

  it("offers a channel CLI update when a legacy doctor omits Inbox integration", async () => {
    runShell.mockImplementation(async (cmd: string) =>
      cmd.includes("doctor")
        ? {
            code: 0,
            stdout: JSON.stringify({
              schemaVersion: 1,
              dependencies: [
                {
                  id: "session-hook",
                  label: "Session hook",
                  ok: true,
                  fixCommand: "dure hooks install --global",
                },
              ],
            }),
          }
        : { code: 0, stdout: "dure 0.1.4\n" },
    );
    render(<AgentToolingPage />);

    expect(await screen.findByText("업데이트 필요")).toBeTruthy();
    expect(screen.getByText("에이전트 도구 업데이트가 필요합니다.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "업데이트" })).toHaveLength(2);
    expect(screen.queryByText("설치됨 · 최신")).toBeNull();
  });

  it("offers the exact channel update even when an older CLI understands the doctor contract", async () => {
    stubHealthyCli();
    dureCliInstallStatus.mockResolvedValue({
      ...CURRENT_CLI,
      state: "outdated",
      installed: {
        version: "0.1.4+old",
        digest: "b".repeat(64),
        installRoot: "/cli/old",
      },
    });
    render(<AgentToolingPage />);

    expect(await screen.findAllByText("업데이트 필요")).toHaveLength(2);
    expect(screen.getByText(/0\.1\.4\+old · b{64} → \/cli\/current/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "업데이트" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "모두 업데이트" })).toBeTruthy();
  });

  it("CLI가 없으면 상태 텍스트 대신 설치 버튼을 세운다", async () => {
    runShell.mockImplementation(async () => ({ code: 1, stdout: "" }));
    render(<AgentToolingPage />);
    await screen.findByText(
      "에이전트 세션을 시작하고 복구하려면 Dure CLI가 필요합니다. 지금 설치하세요.",
    );

    expect(screen.queryByText("설치됨")).toBeNull();
    expect(screen.getByText("에이전트 도구 설치가 필요합니다.")).toBeTruthy();
    const guidance = screen.getByRole("region", {
      name: "조치가 필요한 에이전트 도구",
    });
    expect(within(guidance).getByRole("button", { name: "설치" })).toBeTruthy();
  });

  it("CLI 설치 실패를 숨기지 않고 다시 시도할 수 있게 한다", async () => {
    runShell.mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    installDureCli.mockRejectedValue(
      new Error("Cannot find module 'scripts/install-dure-cli.mjs'"),
    );
    render(<AgentToolingPage />);
    const guidance = await screen.findByRole("region", {
      name: "조치가 필요한 에이전트 도구",
    });
    fireEvent.click(within(guidance).getByRole("button", { name: "설치" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Cannot find module 'scripts/install-dure-cli.mjs'",
    );
    expect(within(guidance).getByRole("button", { name: "설치" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });

  it("성공한 재검사는 이전 설치 오류를 지운다", async () => {
    let cliAvailable = false;
    runShell.mockImplementation(async (cmd: string) => {
      if (!cliAvailable) return { code: 1, stdout: "", stderr: "" };
      return cmd.includes("doctor")
        ? { code: 0, stdout: JSON.stringify(DOCTOR), stderr: "" }
        : { code: 0, stdout: "dure 1.0.0\n", stderr: "" };
    });
    installDureCli.mockRejectedValue(new Error("temporary install failure"));
    render(<AgentToolingPage />);
    const guidance = await screen.findByRole("region", {
      name: "조치가 필요한 에이전트 도구",
    });
    fireEvent.click(within(guidance).getByRole("button", { name: "설치" }));
    await screen.findByRole("alert");

    cliAvailable = true;
    fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));

    expect(await screen.findByText(/^터미널과 에이전트가 dure 명령을 쓸 수 있습니다\./)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("CLI를 설치하는 동안 진행 상태를 보이고 완료 후 자동 재검사한다", async () => {
    let installed = false;
    let finishInstall!: () => void;
    installDureCli.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishInstall = () => {
            installed = true;
            resolve();
          };
        }),
    );
    runShell.mockImplementation(async (cmd: string) => {
      if (!installed) return { code: 1, stdout: "", stderr: "" };
      return cmd.includes("doctor")
        ? { code: 0, stdout: JSON.stringify(DOCTOR), stderr: "" }
        : { code: 0, stdout: "dure 1.0.0\n", stderr: "" };
    });
    render(<AgentToolingPage />);
    const guidance = await screen.findByRole("region", {
      name: "조치가 필요한 에이전트 도구",
    });
    fireEvent.click(within(guidance).getByRole("button", { name: "설치" }));

    expect(
      within(guidance).getByRole("button", { name: "설치 중…" }).hasAttribute("disabled"),
    ).toBe(true);
    finishInstall();

    expect(await screen.findByText(/^터미널과 에이전트가 dure 명령을 쓸 수 있습니다\./)).toBeTruthy();
    expect(installDureCli).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("설치 중…")).toBeNull();
  });

  it("마지막 줄은 설치 상태 안내와 라벨 달린 다시 확인 버튼이다", async () => {
    stubHealthyCli();
    render(<AgentToolingPage />);
    await screen.findByText("dure-cli · Claude");

    expect(screen.getByText("설치 상태")).toBeTruthy();
    expect(screen.getByText("설치 상태는 이 페이지를 열 때 갱신됩니다.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 확인" })).toBeTruthy();
  });

  it("reports compatibility without claiming the CLI is latest when update status is unavailable", async () => {
    const currentDoctor = {
      ...DOCTOR,
      dependencies: DOCTOR.dependencies.map(toCurrentDependency),
    };
    runShell.mockImplementation(async (cmd: string) =>
      cmd.includes("doctor")
        ? { code: 0, stdout: JSON.stringify(currentDoctor) }
        : { code: 0, stdout: "dure 1.0.0\n" },
    );
    dureCliInstallStatus.mockRejectedValue(new Error("status unavailable"));

    render(<AgentToolingPage />);

    expect(await screen.findByText("설치됨 · 호환성 확인됨")).toBeTruthy();
    expect(screen.getByText(/Dure CLI 업데이트 상태를 확인하지 못했습니다\./)).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "조치가 필요한 에이전트 도구" }),
    ).toBeNull();
  });

  it("stays quiet when every tooling item is current", async () => {
    const currentDoctor = {
      ...DOCTOR,
      dependencies: DOCTOR.dependencies.map(toCurrentDependency),
    };
    runShell.mockImplementation(async (cmd: string) =>
      cmd.includes("doctor")
        ? { code: 0, stdout: JSON.stringify(currentDoctor) }
        : { code: 0, stdout: "dure 1.0.0\n" },
    );
    render(<AgentToolingPage />);

    await screen.findAllByText("설치됨 · 최신");
    expect(
      screen.queryByRole("region", { name: "조치가 필요한 에이전트 도구" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "업데이트" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "제거" })).toHaveLength(2);
  });

  it("runs a missing skill row's fixCommand and an outdated row's updateCommand, not the bulk command", async () => {
    const missingDetail = skillDetail("claude", "dure-cli", "missing");
    const outdatedDetail = skillDetail("codex", "dure-cli", "outdated");
    const doctor = {
      schemaVersion: 1,
      dependencies: [
        {
          id: "orchestration-integration",
          label: "durable orchestration integration",
          ok: true,
          fixCommand:
            "dure integration install --global --approve-global-config",
          updateCommand:
            "dure integration update --global --approve-global-config",
          uninstallCommand:
            "dure integration uninstall --global --approve-global-config",
          details: [
            integrationDetail("claude", "current"),
            integrationDetail("codex", "current"),
          ],
        },
        {
          id: "dure-skills",
          label: "Dure skills",
          ok: false,
          fixCommand: "dure skills install --global",
          updateCommand: "dure skills update --all --global",
          details: [missingDetail, outdatedDetail],
        },
      ],
    };
    runShell.mockImplementation(async (cmd: string) =>
      cmd.includes("doctor")
        ? { code: 0, stdout: JSON.stringify(doctor) }
        : { code: 0, stdout: "dure 1.0.0\n" },
    );
    render(<AgentToolingPage />);

    await screen.findByText("dure-cli · Claude");
    // The top guidance banner also reads "설치" here (the bulk action is
    // "install" because a skill is missing), so the row button must be
    // located outside that region to avoid matching the wrong button.
    const guidance = screen.getByRole("region", {
      name: "조치가 필요한 에이전트 도구",
    });
    const findRowInstallButton = () =>
      screen
        .getAllByRole("button", { name: "설치" })
        .find((button) => !guidance.contains(button));

    const installRowButton = findRowInstallButton();
    expect(installRowButton).toBeTruthy();
    fireEvent.click(installRowButton as HTMLElement);
    expect(runShell).toHaveBeenCalledWith(missingDetail.fixCommand);
    expect(runShell).not.toHaveBeenCalledWith("dure skills install --global");

    await vi.waitFor(() => {
      expect(findRowInstallButton()).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "업데이트" }));
    expect(runShell).toHaveBeenCalledWith(outdatedDetail.updateCommand);
    expect(runShell).not.toHaveBeenCalledWith("dure skills update --all --global");
  });
});
