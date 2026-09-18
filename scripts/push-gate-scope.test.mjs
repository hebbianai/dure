import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PUSH_GATE_SCOPES,
  classifyChangedPaths,
  classifyNullDelimitedGitDiff,
  gitDiffNameOnlyArgs,
  parseNullDelimitedGitPaths,
  verificationScopesRequireHeavyRuntime,
  verificationScopesRequireRootNodeDependencies,
} from "./lib/push-gate-scope.mjs";

function rootManifest({ scripts = {}, ...fields } = {}) {
  return JSON.stringify({ name: "dure", private: true, ...fields, scripts });
}

function classifyRootManifestChange(before, after) {
  return classifyChangedPaths(["package.json"], {
    packageManifest: { before, after },
  });
}

describe("push-gate-scope", () => {
  it("returns a canonical sorted scope union for mixed paths", () => {
    expect(
      classifyChangedPaths([
        "mobile/src/App.tsx",
        "src-tauri/src/lib.rs",
        "src/App.tsx",
        "crates/hebbian-process-sampler/src/lib.rs",
        "crates/dure-app/src/lib.rs",
        "crates/hebbian-bounded-process/src/lib.rs",
        "mobile/src-tauri/src/lib.rs",
      ]),
    ).toEqual([
      "app-core",
      "desktop",
      "frontend",
      "hmux-core",
      "mobile-rust",
      "mobile-web",
      "process",
      "sampler",
    ]);
  });

  it.each([
    "src-tauri/src/hmux/mod.rs",
    "src-tauri/vendor/tauri-runtime/src/webview.rs",
  ])("keeps the desktop-only change %s in the desktop scope", (path) => {
    expect(classifyChangedPaths([path])).toEqual(["desktop"]);
  });

  it("does not add mobile gates to an hmux-runtime-only change", () => {
    expect(classifyChangedPaths(["hmux/crates/hmux-runtime/src/main.rs"])).toEqual([
      "hmux-core",
    ]);
  });

  it("selects every Rust consumer of the terminal-state protocol crate", () => {
    for (const path of [
      "hmux/crates/terminal-state-protocol/schema/terminal/state/model/v1/model.proto",
      "hmux/crates/terminal-state-protocol/Cargo.toml",
      "hmux/crates/terminal-state-protocol/src/lib.rs",
      "hmux/crates/terminal-state-protocol/src/generated.rs",
    ]) {
      expect(classifyChangedPaths([path]), path).toEqual([
        "desktop",
        "hmux-core",
        "hmux-mobile-compat",
        "mobile-rust",
        "terminal-state-protocol",
      ]);
    }
  });

  it("selects the frontend consumer and deterministic protocol checks for TypeScript state", () => {
    for (const path of [
      "src/contracts/terminalStateProtocol.ts",
      "src/contracts/generated/terminalState/terminal/state/model/v1/model_pb.ts",
      "src/lib/terminal/state/terminalViewportFrameReplica.ts",
    ]) {
      expect(classifyChangedPaths([path]), path).toEqual([
        "frontend",
        "terminal-state-protocol",
      ]);
    }
  });

  it("keeps protocol-only tests and codegen tooling inside the deterministic leaf gate", () => {
    for (const path of [
      "hmux/crates/terminal-state-protocol/tests/golden_compat.rs",
      "hmux/crates/terminal-state-protocol/tools/check_generated.mjs",
      "hmux/xtask/terminal-state-protocol-codegen/src/bin/generate_terminal_state_protocol.rs",
    ]) {
      expect(classifyChangedPaths([path]), path).toEqual([
        "terminal-state-protocol",
      ]);
    }
  });

  it("includes transitive desktop and public API consumers without adding mobile", () => {
    expect(classifyChangedPaths(["crates/dure-app/src/lib.rs"])).toEqual([
      "app-core",
      "desktop",
      "frontend",
    ]);
    expect(classifyChangedPaths(["crates/hebbian-bounded-process/src/lib.rs"])).toEqual([
      "desktop",
      "hmux-core",
      "process",
      "sampler",
    ]);
    expect(classifyChangedPaths(["crates/hebbian-process-sampler/src/lib.rs"])).toEqual([
      "desktop",
      "hmux-core",
      "sampler",
    ]);
  });

  // The hub wire format is the one definition both halves link. Gating only its
  // own tests would let a field-order change land green and fail on a desk, with
  // a phone in hand — which is the failure this crate exists to prevent.
  it("gates the hub protocol through both the phone and the laptop that link it", () => {
    expect(classifyChangedPaths(["crates/dure-hub-protocol/src/offer.rs"])).toEqual([
      "desktop",
      "hub-protocol",
      "mobile-rust",
      "relay",
    ]);
  });

  // The relay links the protocol crate, not the other way round. A change to
  // the deployed service must not drag the phone and desktop gates along.
  it("gates a relay change through the desktop suite that tests against it", () => {
    expect(classifyChangedPaths(["crates/dure-relay/src/lib.rs"])).toEqual([
      "desktop",
      "relay",
    ]);
    // 폰은 릴레이 크레이트를 링크하지 않는다 — 릴레이로 나가 붙는 것은
    // 노트북이고, 폰은 그 결과로 이어진 소켓만 본다.
    expect(classifyChangedPaths(["crates/dure-relay/src/lib.rs"])).not.toContain("mobile-rust");
  });

  // Nothing in the repository links the feedback intake — not even as a
  // dev-dependency, which is what pulls `desktop` into a relay change — so
  // its own verification is the whole consumer set. Before it had a scope
  // the crate matched no branch at all: fail-closed to every gate, which
  // sounds safe but meant `pnpm feedback:verify` was in no gate's plan, so
  // the one suite that actually covers this crate never ran on a push.
  it("gates the feedback intake through its own verification only", () => {
    expect(
      classifyChangedPaths(["crates/dure-feedback-intake/src/sink.rs"]),
    ).toEqual(["feedback"]);
    expect(
      classifyChangedPaths(["crates/dure-feedback-intake/Cargo.toml"]),
    ).toEqual(["feedback"]);
  });

  // It depends on nothing from the hmux workspace, deliberately: a phone build
  // links it, and hmux carries the local-runtime world.
  it("does not pull hmux gates into a hub protocol change", () => {
    expect(classifyChangedPaths(["crates/dure-hub-protocol/Cargo.toml"])).not.toContain(
      "hmux-core",
    );
  });

  it("gates the generated Dure app contract only through its exact consumers", () => {
    expect(
      classifyChangedPaths([
        "src/contracts/generated/extensionContracts.ts",
      ]),
    ).toEqual(["app-core", "desktop", "frontend"]);
  });

  it("gates the control-plane capability manifest through its exact consumers", () => {
    expect(
      classifyChangedPaths(["cli/lib/control-plane-build-identity.json"]),
    ).toEqual(["app-core", "desktop", "frontend", "script-tests"]);
  });

  it("routes design evidence and engine paths to the design-coverage gate only", () => {
    for (const path of [
      "design/SOUL.md",
      "design/GLASS.md",
      "design/WRITING.md",
      "design/SOUL.web.md",
      "design/CLAUDE.mobile.md",
      "design/engine/cli.ts",
      "design/engine/judge.test.ts",
      "design/glass-mockups/Glass IDE v8.dc.html",
      "design/mockups/spaces/SpacesPane/default.html",
      "design/design-coverage-baseline.json",
      "design/inventory.overrides.yaml",
      "design/raw-color-allowlist.json",
    ]) {
      expect(classifyChangedPaths([path]), path).toEqual(["design-coverage"]);
    }
  });

  it("routes DESIGN.md to the coverage judgment (token documentation input)", () => {
    expect(classifyChangedPaths(["DESIGN.md"])).toEqual(["design-coverage"]);
  });

  it("fails closed on unknown design/ paths", () => {
    expect(classifyChangedPaths(["design/render-farm.bin"])).toEqual(PUSH_GATE_SCOPES);
    expect(classifyChangedPaths(["design/tools/helper.mjs"])).toEqual(PUSH_GATE_SCOPES);
    expect(classifyChangedPaths(["design/specs/hidden.mjs"])).toEqual(PUSH_GATE_SCOPES);
  });

  it("keeps the engine's declared scan root and token sources classified", () => {
    // AGENTS.md requires that adding a scan root or token source extends the
    // classifier in the same change. The engine declares them as module-private
    // constants, so this contract reads them out of the source: renaming one
    // fails here and forces the classifier to be reviewed alongside it.
    const declarations = [
      ["design/engine/surface-scanner.ts", /const COMPONENT_ROOT = "([^"]+)"/],
      ["design/engine/token-scanner.ts", /const TOKEN_SOURCE = "([^"]+)"/],
      [
        "design/engine/token-scanner.ts",
        /const RUNTIME_THEME_MODULE = "([^"]+)"/,
      ],
    ];
    const repositoryRoot = nodePath.resolve(
      nodePath.dirname(fileURLToPath(import.meta.url)),
      "..",
    );

    for (const [file, pattern] of declarations) {
      const match = fs
        .readFileSync(nodePath.join(repositoryRoot, file), "utf8")
        .match(pattern);
      expect(match, `${file} ${pattern}`).not.toBeNull();
      // A root is a directory; probe it with a file the scanner would read.
      const declared = match[1];
      const probe = nodePath.extname(declared)
        ? declared
        : `${declared}/Probe.tsx`;
      expect(classifyChangedPaths([probe]), probe).toContain("design-coverage");
    }
  });

  it("keeps the design-coverage gate runtime-free and node-dependent", () => {
    expect(verificationScopesRequireHeavyRuntime(["design-coverage"])).toBe(
      false,
    );
    expect(
      verificationScopesRequireRootNodeDependencies(["design-coverage"]),
    ).toBe(true);
  });

  it("keeps the raw-color gate surface inside the design-coverage classifier surface", async () => {
    // verify:push:design-coverage runs this suite, so an engine push that moves
    // GATE_ENFORCED_PREFIXES outside the classifier surface fails its own gate.
    // Budget regressions gate only paths whose pushes select the coverage
    // judgment — otherwise a regression lands green through another gate and
    // poisons the design gate for unrelated agents.
    const { GATE_ENFORCED_PREFIXES } = await import("../design/engine/raw-color-scanner.ts");
    for (const prefix of GATE_ENFORCED_PREFIXES) {
      expect(
        classifyChangedPaths([`${prefix}anything/Sample.tsx`]),
        prefix,
      ).toContain("design-coverage");
    }
  });

  it("selects the coverage judgment for every src file the engine imports", () => {
    // The engine is otherwise isolated from src/, but its contract tests import
    // the exact product modules they assert parity against. A push that changes
    // one of those must run the gate it can break, so the import closure and the
    // classifier's denominator list are not allowed to drift apart.
    const engineDir = nodePath.resolve(
      nodePath.dirname(fileURLToPath(import.meta.url)),
      "../design/engine",
    );
    const imported = new Set();
    for (const entry of fs.readdirSync(engineDir)) {
      if (!entry.endsWith(".ts")) continue;
      const source = fs.readFileSync(nodePath.join(engineDir, entry), "utf8");
      for (const match of source.matchAll(
        /from\s+["'](?:\.\.\/)+(src\/[^"']+)["']/g,
      )) {
        imported.add(match[1]);
      }
    }

    expect(imported.size).toBeGreaterThan(0);
    for (const specifier of imported) {
      expect(classifyChangedPaths([specifier]), specifier).toContain(
        "design-coverage",
      );
    }
  });

  it("adds the coverage judgment to declared scan-root and token-source pushes", () => {
    for (const entry of [
      "src/components/spaces/SpacesPane.tsx",
      "src/components/newcluster/Fresh.tsx",
      "src/index.css",
      "src/lib/theme/oklch.ts",
      "src/lib/theme/themeStyle.ts",
    ]) {
      expect(classifyChangedPaths([entry]), entry).toEqual([
        "design-coverage",
        "frontend",
      ]);
    }
    // Ordinary frontend paths must NOT drag the design gate in.
    expect(classifyChangedPaths(["src/lib/theme/resolveTheme.ts"])).toEqual(["frontend"]);
    expect(classifyChangedPaths(["src/store.ts"])).toEqual(["frontend"]);
  });

  it("fails closed for the retired legacy session daemon tree", () => {
    // hebbian-session/ was deleted with the legacy runtime retirement
    // (2026-08-16); any stray path there is an unknown input again.
    expect(classifyChangedPaths(["hebbian-session/src/main.rs"])).toEqual(
      PUSH_GATE_SCOPES,
    );
  });

  it("gates desktop and mobile consumers of shared Hmux APIs", () => {
    for (const path of [
      "hmux/crates/hmux-client/src/connection.rs",
      "hmux/crates/hmux-host/src/local_protocol/wire_frame.rs",
      "hmux/crates/hmux-runtime-contract/src/lib.rs",
    ]) {
      expect(classifyChangedPaths([path])).toEqual([
        "desktop",
        "hmux-core",
        "hmux-mobile-compat",
        "mobile-rust",
      ]);
    }
    expect(
      classifyChangedPaths(["hmux/crates/hmux-ssh-transport/src/lib.rs"]),
    ).toEqual([
      "desktop",
      "hmux-core",
      "hmux-mobile-compat",
      "mobile-rust",
    ]);
  });

  it("keeps private Hmux test modules on the Hmux core gate", () => {
    for (const path of [
      "hmux/crates/hmux-client/src/recovery_journal/tests.rs",
      "hmux/crates/hmux-runtime-contract/src/wire/tests/compatibility.rs",
    ]) {
      expect(classifyChangedPaths([path]), path).toEqual(["hmux-core"]);
    }

    expect(
      classifyChangedPaths([
        "hmux/crates/hmux-client/src/recovery_journal/tests.rs",
        "hmux/crates/hmux-client/src/recovery_journal.rs",
      ]),
    ).toEqual([
      "desktop",
      "hmux-core",
      "hmux-mobile-compat",
      "mobile-rust",
    ]);
  });

  it("keeps local-runtime-only Hmux implementation changes off mobile gates", () => {
    for (const path of [
      "hmux/crates/hmux-host/src/session_host.rs",
      "hmux/crates/hmux-host/src/terminal_replay/terminal_model.rs",
      "hmux/crates/hmux-client/src/runtime_broker.rs",
      "hmux/crates/hmux-client/src/transport/unix_socket.rs",
    ]) {
      expect(classifyChangedPaths([path]), path).toEqual([
        "desktop",
        "hmux-core",
      ]);
    }
  });

  it("maps mobile web and Rust trees independently", () => {
    expect(classifyChangedPaths(["mobile/src/App.tsx"])).toEqual(["mobile-web"]);
    expect(classifyChangedPaths(["mobile/src-tauri/src/lib.rs"])).toEqual(["mobile-rust"]);
    expect(
      classifyChangedPaths(["mobile/src/App.tsx", "mobile/src-tauri/src/lib.rs"]),
    ).toEqual(["mobile-rust", "mobile-web"]);
  });

  it("includes the native signed-request consumer when the push service changes", () => {
    for (const path of ["mobile/push-service/service.mjs", "mobile/push-service/apns.mjs", "mobile/push-service/Dockerfile"]) {
      expect(classifyChangedPaths([path]), path).toEqual(["desktop", "mobile-web"]);
    }
  });

  it("lets documentation, internal Marketing Labs Markdown, generated product media, AGENTS, and Beads metadata skip code gates", () => {
    expect(
      classifyChangedPaths([
        "docs/architecture/session.md",
        "docs/public/.mintignore",
        "docs/public/docs.json",
        "docs/public/images/workspace-overview.png",
        "docs/public/videos/workspace-overview.webm",
        "hmux/docs/protocol-v1.md",
        "marketing-labs/OPERATING_SYSTEM.md",
        "marketing-labs/experiments/ML-THR-001-ACCOUNT-REACTIVATION.md",
        "public/readme/workspace-overview.png",
        "hmux/AGENTS.md",
        ".beads/issues.jsonl",
        "README.md",
      ]),
    ).toEqual([]);
  });

  it("lets an unlisted repository-root document skip code gates", () => {
    // A stray root note (PLAN.md, NOTES.md) used to expand to every gate, which
    // made the cheapest possible change the most expensive one to land.
    expect(classifyChangedPaths(["NOTES.md", "PLAN.md", "SCRATCH.txt"])).toEqual(
      [],
    );
  });

  it("keeps DESIGN.md on the coverage judgment despite the root document rule", () => {
    expect(classifyChangedPaths(["DESIGN.md"])).toEqual(["design-coverage"]);
  });

  it("keeps markdown compiled into product code fail-closed", () => {
    // cli/skills/**/SKILL.md is shipped content of the dure-cli package
    // (cli/package.json "files" lists skills) and is read by
    // scripts/skills-commands.test.mjs, and plugins/**/SKILL.md is
    // include_bytes!'d by src-tauri, so the root document rule must never
    // reach a nested path.
    for (const path of [
      "cli/skills/dure/SKILL.md",
      "plugins/beads/agents/claude/plugins/dure-beads/skills/beads/SKILL.md",
      "sub/dir/NOTES.md",
    ]) {
      expect(classifyChangedPaths([path]), path).toEqual(PUSH_GATE_SCOPES);
    }
  });

  it("still selects code consumers when public docs and product code change together", () => {
    expect(
      classifyChangedPaths([
        "docs/public/images/workspace-overview.png",
        "src/App.tsx",
      ]),
    ).toEqual(["frontend"]);
  });

  it("isolates known media tooling while retaining its exact frontend consumers", () => {
    expect(
      classifyChangedPaths([
        "tools/media-capture/capture.mjs",
        "tools/media-capture/providers/hmux-live-source.mjs",
        "scripts/media-capture-contract.test.mjs",
      ]),
    ).toEqual(["tooling"]);
    expect(classifyChangedPaths(["src/qa.ts"])).toEqual([
      "qa-tooling",
      "tooling",
    ]);
    expect(classifyChangedPaths(["src/lib/qa/qaHarnessGlobals.ts"])).toEqual([
      "qa-tooling",
      "tooling",
    ]);
    expect(
      classifyChangedPaths([
        "src/qa/hmuxWindowFocus.tsx",
        "scripts/qa/hmux-window-background-client.mjs",
      ]),
    ).toEqual(["qa-tooling"]);
    expect(
      classifyChangedPaths([
        "tools/media-capture/scenarios.mjs",
        "src/App.tsx",
      ]),
    ).toEqual(["frontend", "tooling"]);
  });

  it("runs script test-only changes without selecting product runtimes", () => {
    expect(
      classifyChangedPaths(["scripts/dev-deploy-executor-files.json"]),
    ).toEqual(["script-tests"]);
    expect(
      classifyChangedPaths([
        "scripts/architecture-fitness-base.test.mjs",
        "scripts/qa/lib/evidence-bundle.test.mjs",
      ]),
    ).toEqual(["script-tests"]);
    expect(
      classifyChangedPaths([
        "scripts/architecture-fitness-base.test.mjs",
        "scripts/lib/disk-space.mjs",
      ]),
    ).toEqual(["script-tests"]);
    expect(
      classifyChangedPaths([
        "scripts/lib/disk-space.mjs",
        "scripts/runner-disk-maintenance.mjs",
      ]),
    ).toEqual(["script-tests"]);
    expect(
      classifyChangedPaths(["scripts/architecture-fitness-baseline.json"]),
    ).toEqual(["frontend"]);
  });

  it("routes opaque script resources through their behavioral gates", () => {
    for (const path of [
      "scripts/qa/native/helper.py",
      "scripts/qa/native/helper.sh",
      "scripts/qa/native/helper.c",
    ]) {
      expect(classifyChangedPaths([path]), path).toEqual([
        "qa-tooling",
        "script-tests",
      ]);
    }
    for (const path of [
      "scripts/native/helper.py",
      "scripts/native/helper.sh",
      "scripts/native/helper.c",
    ]) {
      expect(classifyChangedPaths([path]), path).toEqual(["script-tests"]);
    }
  });

  it("runs known Dure CLI modules through runtime-free script contracts", () => {
    expect(
      classifyChangedPaths([
        "cli/dure.mjs",
        "cli/lib/orchestration-command.mjs",
        "scripts/dure-cli-orchestration.test.mjs",
      ]),
    ).toEqual(["script-tests"]);
    expect(classifyChangedPaths(["cli/hebbian-agent-hook.py"])).toEqual(
      PUSH_GATE_SCOPES,
    );
    expect(classifyChangedPaths(["cli/package.json"])).toEqual(
      PUSH_GATE_SCOPES,
    );
    expect(classifyChangedPaths(["cli/lib/generated-contract.json"])).toEqual(
      PUSH_GATE_SCOPES,
    );
  });

  it("maps a root script-only manifest change to the referenced command scopes", () => {
    const before = rootManifest({
      scripts: { existing: "node scripts/existing.mjs" },
    });
    const after = rootManifest({
      scripts: {
        existing: "node scripts/existing.mjs",
        "test:control-plane-self-heal":
          "sh scripts/qa/control-plane-self-heal-smoke.sh",
      },
    });

    expect(classifyRootManifestChange(before, after)).toEqual([
      "qa-tooling",
      "script-tests",
    ]);
  });

  it("unions old and new script paths and follows package-script composition", () => {
    const before = rootManifest({
      scripts: {
        helper: "node scripts/existing.mjs",
        "test:moved": "node scripts/old.mjs",
      },
    });
    const after = rootManifest({
      scripts: {
        helper: "node scripts/existing.mjs",
        "test:moved": "sh scripts/qa/new-smoke.sh",
        "test:recursive": "corepack pnpm run helper",
      },
    });

    expect(classifyRootManifestChange(before, after)).toEqual([
      "qa-tooling",
      "script-tests",
    ]);
  });

  it("includes pre/post commands activated by a changed package script", () => {
    const before = rootManifest({
      scripts: { "pretest:new": "node src/preflight.ts" },
    });
    const after = rootManifest({
      scripts: {
        "pretest:new": "node src/preflight.ts",
        "test:new": "sh scripts/qa/new-smoke.sh",
      },
    });

    expect(classifyRootManifestChange(before, after)).toEqual([
      "frontend",
      "qa-tooling",
      "script-tests",
    ]);
  });

  it("treats semantically unchanged root manifests as an empty impact", () => {
    const before = '{"name":"dure","private":true,"scripts":{"check":"node scripts/check.mjs"}}';
    const after = JSON.stringify(
      {
        scripts: { check: "node scripts/check.mjs" },
        private: true,
        name: "dure",
      },
      null,
      2,
    );

    expect(classifyRootManifestChange(before, after)).toEqual([]);
  });

  it.each([
    ["dependencies", { dependencies: { react: "next" } }],
    ["workspaces", { workspaces: ["packages/*"] }],
    ["package manager", { packageManager: "pnpm@99" }],
  ])("keeps %s manifest changes fail-closed", (_label, fields) => {
    const before = rootManifest();
    const after = rootManifest(fields);
    expect(classifyRootManifestChange(before, after)).toEqual(PUSH_GATE_SCOPES);
  });

  it.each([
    ["build:frontend", "node scripts/build.mjs"],
    ["build-frontend", "node scripts/build.mjs"],
    ["prepare", "node scripts/prepare.mjs"],
    ["preinstall", "node scripts/install.mjs"],
  ])("keeps %s script changes fail-closed", (name, command) => {
    const before = rootManifest();
    const after = rootManifest({ scripts: { [name]: command } });
    expect(classifyRootManifestChange(before, after)).toEqual(PUSH_GATE_SCOPES);
  });

  it.each([
    "sh -c scripts/qa/smoke.sh",
    "node -e scripts/check.mjs",
    "sh scripts/qa/smoke.sh | tee result.log",
    "pnpm install",
    "unknown-tool scripts/check.mjs",
  ])("keeps ambiguous package command %s fail-closed", (command) => {
    const before = rootManifest();
    const after = rootManifest({ scripts: { "test:ambiguous": command } });
    expect(classifyRootManifestChange(before, after)).toEqual(PUSH_GATE_SCOPES);
  });

  it("does not reinterpret a package-manager command as a same-named script", () => {
    const before = rootManifest({
      scripts: { exec: "node scripts/existing.mjs" },
    });
    const after = rootManifest({
      scripts: {
        exec: "node scripts/existing.mjs",
        "test:ambiguous": "pnpm exec",
      },
    });
    expect(classifyRootManifestChange(before, after)).toEqual(PUSH_GATE_SCOPES);
  });

  it("does not treat a documentation path as a gate-free executable", () => {
    const before = rootManifest();
    const after = rootManifest({
      scripts: { "test:ambiguous": "public/readme/workspace-overview.png" },
    });
    expect(classifyRootManifestChange(before, after)).toEqual(PUSH_GATE_SCOPES);
  });

  it("keeps malformed or cyclic package evidence fail-closed", () => {
    expect(
      classifyRootManifestChange("{", rootManifest()),
    ).toEqual(PUSH_GATE_SCOPES);
    expect(
      classifyRootManifestChange(
        rootManifest(),
        rootManifest({
          scripts: {
            "test:a": "pnpm run test:b",
            "test:b": "pnpm run test:a",
          },
        }),
      ),
    ).toEqual(PUSH_GATE_SCOPES);
  });

  it("keeps unknown tool families fail-closed", () => {
    expect(classifyChangedPaths(["tools/unregistered/build.mjs"])).toEqual(
      PUSH_GATE_SCOPES,
    );
  });

  it("keeps tooling and mobile web unions off Rust setup", () => {
    expect(verificationScopesRequireHeavyRuntime([])).toBe(false);
    expect(verificationScopesRequireHeavyRuntime(["tooling"])).toBe(false);
    expect(verificationScopesRequireHeavyRuntime(["qa-tooling"])).toBe(false);
    expect(verificationScopesRequireHeavyRuntime(["script-tests"])).toBe(false);
    expect(
      verificationScopesRequireHeavyRuntime(["mobile-web", "tooling"]),
    ).toBe(false);
    expect(verificationScopesRequireHeavyRuntime(["frontend"])).toBe(false);
    expect(
      verificationScopesRequireHeavyRuntime(["terminal-state-protocol"]),
    ).toBe(true);
    expect(verificationScopesRequireHeavyRuntime(["mobile-rust"])).toBe(true);
    expect(verificationScopesRequireHeavyRuntime(["desktop"])).toBe(true);
    expect(verificationScopesRequireHeavyRuntime(["unknown"])).toBe(true);
    expect(verificationScopesRequireHeavyRuntime(null)).toBe(true);
  });

  it("preflights root node_modules only for scopes that consume it", () => {
    expect(verificationScopesRequireRootNodeDependencies([])).toBe(false);
    expect(verificationScopesRequireRootNodeDependencies(["frontend"])).toBe(
      true,
    );
    expect(verificationScopesRequireRootNodeDependencies(["desktop"])).toBe(
      true,
    );
    expect(
      verificationScopesRequireRootNodeDependencies(["qa-tooling", "tooling"]),
    ).toBe(true);
    expect(
      verificationScopesRequireRootNodeDependencies(["script-tests"]),
    ).toBe(true);
    expect(verificationScopesRequireRootNodeDependencies(["hmux-core"])).toBe(
      false,
    );
    expect(verificationScopesRequireRootNodeDependencies(["mobile-web"])).toBe(
      false,
    );
    expect(verificationScopesRequireRootNodeDependencies(["mobile-rust"])).toBe(
      false,
    );
    expect(verificationScopesRequireRootNodeDependencies(["unknown"])).toBe(true);
    expect(verificationScopesRequireRootNodeDependencies(null)).toBe(true);
  });

  it("fails closed for executable or unknown files placed under docs", () => {
    expect(classifyChangedPaths(["docs/examples/run.mjs"])).toEqual(
      PUSH_GATE_SCOPES,
    );
    expect(classifyChangedPaths(["docs/publicity/run.mjs"])).toEqual(
      PUSH_GATE_SCOPES,
    );
    expect(classifyChangedPaths(["hmux/docs/probe.sh"])).toEqual(
      PUSH_GATE_SCOPES,
    );
    expect(classifyChangedPaths(["marketing-labs/run.mjs"])).toEqual(
      PUSH_GATE_SCOPES,
    );
    expect(
      classifyChangedPaths(["marketing-labs/experiments/results.json"]),
    ).toEqual(PUSH_GATE_SCOPES);
    expect(classifyChangedPaths(["marketing-labs/raw-account.png"])).toEqual(
      PUSH_GATE_SCOPES,
    );
  });

  it("expands unknown, shared, toolchain, gate, CI, and root manifests to all scopes", () => {
    for (const path of [
      "totally/new/path.xyz",
      "tools/release/publish.mjs",
      "src/contracts/generated/unknown-contract.ts",
      ".cargo/config.toml",
      ".githooks/pre-push",
      "scripts/lib/hmux-artifact-impact.mjs",
      "scripts/lib/hmux-background-smoke-scope.mjs",
      "scripts/lib/package-manifest-script-impact.mjs",
      "scripts/lib/script-test-projects.mjs",
      "scripts/lib/script-test-graph-paths.mjs",
      "scripts/lib/push-gate-scope.mjs",
      "scripts/public-ci.mjs",
      "scripts/run-changed-script-tests.mjs",
      "scripts/run-push-gates.mjs",
      "scripts/stage-hmux-runtime.sh",
      ".github/workflows/ci.yml",
      "package.json",
      "pnpm-lock.yaml",
      "vitest.config.ts",
    ]) {
      expect(classifyChangedPaths([path]), path).toEqual(PUSH_GATE_SCOPES);
    }
  });

  it("returns no scopes for an empty diff and fails closed on invalid path input", () => {
    expect(classifyChangedPaths([])).toEqual([]);
    expect(classifyChangedPaths(null)).toEqual(PUSH_GATE_SCOPES);
    expect(classifyChangedPaths([""])).toEqual(PUSH_GATE_SCOPES);
    expect(classifyChangedPaths(["src/good.ts", "bad\0path"])).toEqual(PUSH_GATE_SCOPES);
  });

  it("uses a no-renames, NUL-delimited Git diff so rename endpoints are both classified", () => {
    expect(gitDiffNameOnlyArgs("base", "head")).toEqual([
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      "base..head",
      "--",
    ]);

    // With --no-renames Git emits a deletion and addition. The two endpoints
    // deliberately select both old and new consumers.
    expect(
      classifyNullDelimitedGitDiff(
        Buffer.from("src-tauri/src/old.rs\0mobile/src-tauri/src/new.rs\0"),
      ),
    ).toEqual(["desktop", "mobile-rust"]);
  });

  it("preserves special filename characters in NUL-delimited path input", () => {
    const output = Buffer.from(
      "src/file with spaces.ts\0src/file\nwith-newline.ts\0src/quote\"and\\slash.ts\0",
    );

    expect(parseNullDelimitedGitPaths(output)).toEqual([
      "src/file with spaces.ts",
      "src/file\nwith-newline.ts",
      "src/quote\"and\\slash.ts",
    ]);
    expect(classifyNullDelimitedGitDiff(output)).toEqual(["frontend"]);
  });

  it("treats a single emitted path as a deletion and malformed diff output as fail-closed", () => {
    expect(classifyNullDelimitedGitDiff(Buffer.from("mobile/src/deleted.ts\0"))).toEqual([
      "mobile-web",
    ]);
    expect(classifyNullDelimitedGitDiff(Buffer.from("src/not-terminated.ts"))).toEqual(
      PUSH_GATE_SCOPES,
    );
    expect(classifyNullDelimitedGitDiff(Uint8Array.from([0xff, 0]))).toEqual(PUSH_GATE_SCOPES);
  });
});
