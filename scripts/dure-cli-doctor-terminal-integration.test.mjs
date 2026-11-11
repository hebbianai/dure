import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProviderRuntimeIntegrations } from "../cli/lib/provider-runtime-integration.mjs";

const CLI = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-doctor-integration-"));
  roots.push(root);
  return root;
}

function status(providers) {
  return {
    schemaVersion: 1,
    kind: "dure.provider_runtime_integration_status",
    channel: "stable",
    document: "/host/.dure/managed-provider-integrations-v1.json",
    providers,
  };
}

const MISSING = status([
  { providerId: "claude", status: "unavailable", requirement: "integration_document_missing" },
  { providerId: "codex", status: "current", requirement: null },
]);

describe("inspectProviderRuntimeIntegrations", () => {
  it("runs the control plane's own check for each provider", () => {
    const calls = [];
    const report = inspectProviderRuntimeIntegrations({
      controlPlanePath: "/bin/dure-control-plane",
      dureHome: "/host/.dure",
      run: (command, args) => {
        calls.push([command, args]);
        return { status: 0, stdout: JSON.stringify(MISSING) };
      },
    });
    expect(calls).toEqual([[
      "/bin/dure-control-plane",
      ["provider-integration-status", "--home", "/host/.dure", "--provider", "claude", "--provider", "codex"],
    ]]);
    expect(report).toEqual(MISSING);
  });

  it.each([
    ["a missing control plane", () => ({ error: Object.assign(new Error("spawn"), { code: "ENOENT" }) })],
    ["an older control plane without the check", () => ({ status: 2, stdout: "" })],
    ["output that is not JSON", () => ({ status: 0, stdout: "usage" })],
    ["another provider order", () => ({ status: 0, stdout: JSON.stringify(status([...MISSING.providers].reverse())) })],
    ["a current provider that names a requirement", () => ({
      status: 0,
      stdout: JSON.stringify(status([
        { providerId: "claude", status: "current", requirement: "integration_document_missing" },
        { providerId: "codex", status: "current", requirement: null },
      ])),
    })],
    ["a throwing runner", () => { throw new Error("spawn"); }],
  ])("reports nothing for %s", (_label, run) => {
    expect(inspectProviderRuntimeIntegrations({ controlPlanePath: "/bin/x", dureHome: "/h", run })).toBeNull();
  });
});

function runDoctor(root, report, args = ["--json"]) {
  const controlPlane = join(root, "dure-control-plane");
  writeFileSync(
    controlPlane,
    report === null
      ? "#!/bin/sh\nexit 2\n"
      : `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(report)}\nEOF\n`,
  );
  chmodSync(controlPlane, 0o755);
  return spawnSync(process.execPath, [CLI, "doctor", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      DURE_HOME: join(root, "dure-home"),
      DURE_CONTROL_PLANE_BIN: controlPlane,
    },
  });
}

describe("dure doctor terminal-session launch integration", () => {
  it("names the unmet requirement per provider", () => {
    const root = temporaryRoot();
    const result = runDoctor(root, MISSING);
    expect(result.status, result.stderr).toBe(0);
    const dependency = JSON.parse(result.stdout).dependencies.find(
      (candidate) => candidate.id === "terminal-launch-integration",
    );
    expect(dependency).toMatchObject({
      ok: false,
      state: "unavailable",
      document: MISSING.document,
      details: [
        {
          provider: "claude",
          status: "unavailable",
          requirement: "integration_document_missing",
          reason: "no Dure app has published it",
        },
        { provider: "codex", status: "current", requirement: null, reason: null },
      ],
    });

    const text = runDoctor(root, MISSING, []);
    expect(text.stdout).toContain("terminal-session launch integration — Terminal-session Runs need it");
    expect(text.stdout).toContain(
      `    claude — integration_document_missing: no Dure app has published it (${MISSING.document})`,
    );
    expect(text.stdout).not.toContain("    codex —");
  });

  it("passes when every provider's integration is current", () => {
    const root = temporaryRoot();
    const current = status([
      { providerId: "claude", status: "current", requirement: null },
      { providerId: "codex", status: "current", requirement: null },
    ]);
    const dependency = JSON.parse(runDoctor(root, current).stdout).dependencies.find(
      (candidate) => candidate.id === "terminal-launch-integration",
    );
    expect(dependency).toMatchObject({ ok: true, state: "current" });
  });

  it("reports an unknown check, not a failure, when the control plane cannot run it", () => {
    const root = temporaryRoot();
    const result = runDoctor(root, null);
    expect(result.status, result.stderr).toBe(0);
    const dependency = JSON.parse(result.stdout).dependencies.find(
      (candidate) => candidate.id === "terminal-launch-integration",
    );
    expect(dependency).toMatchObject({ ok: false, state: "unknown", details: [] });
    expect(runDoctor(root, null, []).stdout).toContain(
      "terminal-session launch integration — This CLI's control plane could not run the check.",
    );
  });
});
