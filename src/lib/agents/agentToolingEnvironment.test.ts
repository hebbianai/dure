import { describe, expect, it, vi } from "vitest";
import type { DureCliInstallStatus } from "@/lib/ipc/system";
import { probeAgentToolingEnvironment } from "./agentToolingEnvironment";

function integrationDetail(provider: "claude" | "codex") {
  return {
    provider,
    status: "current",
    installRoot: `/integration/${provider}`,
    installRootRef: `install-${provider}-${"a".repeat(32)}`,
    version: "v1",
    digest: "a".repeat(64),
    channel: "dev-test",
    transportRef: "direct-outbound",
    capabilities: ["event_cursor_v1"],
    fixCommand: `dure integration install --global --provider ${provider} --approve-global-config`,
    updateCommand: `dure integration update --global --provider ${provider} --approve-global-config`,
    uninstallCommand: `dure integration uninstall --global --provider ${provider} --approve-global-config`,
    refreshCommand: null,
  };
}

const doctor = JSON.stringify({
  schemaVersion: 1,
  dependencies: [
    {
      id: "orchestration-integration",
      label: "Orchestration integration",
      ok: true,
      fixCommand: "dure integration install --global --approve-global-config",
      updateCommand: "dure integration update --global --approve-global-config",
      uninstallCommand: "dure integration uninstall --global --approve-global-config",
      details: [integrationDetail("claude"), integrationDetail("codex")],
    },
  ],
});

const cliInstallStatus = {
  state: "current",
  installed: {
    version: "v1",
    digest: "a".repeat(64),
    installRoot: "/verified channel/v1",
    executablePath: "/verified channel/v1/bin/dure",
  },
  available: {
    version: "v1",
    digest: "a".repeat(64),
    installRoot: "/verified channel/v1",
    executablePath: "/verified channel/v1/bin/dure",
  },
} satisfies DureCliInstallStatus;

describe("agent tooling environment", () => {
  it("probes the verified channel CLI instead of an unrelated login-shell command", async () => {
    const runCommand = vi.fn(async (command: string) => ({
      code: 0,
      stdout: command.endsWith(" doctor --json") ? doctor : "dure v1",
      stderr: "",
    }));

    const snapshot = await probeAgentToolingEnvironment({
      runCommand,
      readCliInstallStatus: vi.fn(async () => cliInstallStatus),
    });

    expect(runCommand.mock.calls.map(([command]) => command)).toEqual([
      "'/verified channel/v1/bin/dure' doctor --json",
      "'/verified channel/v1/bin/dure' --version",
    ]);
    expect(snapshot.report.cliState).toBe("ok");
  });
});
