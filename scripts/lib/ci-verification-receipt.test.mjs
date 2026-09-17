import fs from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  ALL_VERIFICATION_SCOPES,
  CI_BEHAVIOR_RECEIPT_SCHEMA,
  CI_HMUX_BACKGROUND_SMOKE_CAPABILITY,
  CI_PRODUCT_GATE_CAPABILITY,
  CI_PRODUCT_VERIFICATION_ARTIFACT,
  CI_VERIFICATION_PLAN_SCHEMA,
  CI_VERIFICATION_SCHEMA,
  classifyVerificationScopes,
  behaviorReceiptRecords,
  createBehaviorReceipt,
  describeFingerprintMismatch,
  downloadBehaviorReceipt,
  hmuxSmokeReuseDecision,
  createVerificationReceipt,
  determineVerificationPlan,
  downloadVerificationReceipt,
  LEGACY_CI_VERIFICATION_SCHEMA,
  observedVerificationScopes,
  parseBehaviorReceipt,
  parseVerificationPlanHandoff,
  parseVerificationReceipt,
  PRE_CAPABILITY_CI_VERIFICATION_ARTIFACT,
  PRE_CAPABILITY_CI_VERIFICATION_SCHEMA,
  requiresHmuxBackgroundSmoke,
  verificationScopesSatisfy,
} from "./ci-verification-receipt.mjs";
import { createCompletedVerificationDiagnostics } from "./verification-diagnostics.mjs";

const FULL_BASE = "a".repeat(40);
const BACKEND = "b".repeat(40);
const FRONTEND = "c".repeat(40);
const NEXT = "d".repeat(40);

function runRecord(databaseId, headSha, conclusion = "success") {
  return {
    conclusion,
    databaseId,
    headSha,
    status: "completed",
  };
}

function receipt(databaseId, scopes, verifiedBase, verifiedHead) {
  return createVerificationReceipt({
    runId: databaseId,
    scopes,
    verifiedBase,
    verifiedHead,
  });
}

function legacyReceipt(databaseId, scope, verifiedBase, verifiedHead) {
  return {
    runId: String(databaseId),
    schema: LEGACY_CI_VERIFICATION_SCHEMA,
    scope,
    verifiedBase,
    verifiedHead,
  };
}

function preCapabilityReceipt(
  databaseId,
  scopes,
  verifiedBase,
  verifiedHead,
) {
  return {
    runId: String(databaseId),
    schema: PRE_CAPABILITY_CI_VERIFICATION_SCHEMA,
    scopes,
    verifiedBase,
    verifiedHead,
  };
}

function ancestry(ancestor, descendant) {
  const order = [FULL_BASE, BACKEND, FRONTEND, NEXT];
  return order.indexOf(ancestor) <= order.indexOf(descendant);
}

describe("CI verification receipts", () => {
  test("reuses the push classifier for canonical consumer scope sets", () => {
    expect(
      classifyVerificationScopes([
        "src/App.tsx",
        "docs/operations/recovery.md",
        ".beads/issues.jsonl",
      ]),
    ).toEqual(["frontend"]);
    expect(
      classifyVerificationScopes(["src/App.tsx", "src-tauri/src/lib.rs"]),
    ).toEqual(["desktop", "frontend"]);
    expect(
      classifyVerificationScopes([
        "docs/public/docs.json",
        "docs/public/images/workspace-overview.png",
        "docs/public/videos/workspace-overview.webm",
      ]),
    ).toEqual([]);
    expect(classifyVerificationScopes(["mobile/src/App.tsx"])).toEqual([
      "mobile-web",
    ]);
    expect(classifyVerificationScopes(["unknown-input"])).toEqual(
      ALL_VERIFICATION_SCOPES,
    );
  });

  test("accepts only a canonical exact-head verification plan handoff", () => {
    const plan = {
      requiresHmuxArtifact: false,
      requiresHmuxSmoke: false,
      schema: CI_VERIFICATION_PLAN_SCHEMA,
      scopes: ["script-tests"],
      verifiedBase: FULL_BASE,
      verifiedHead: BACKEND,
    };

    expect(parseVerificationPlanHandoff(plan, BACKEND)).toEqual(plan);
    expect(() =>
      parseVerificationPlanHandoff({ ...plan, verifiedHead: FRONTEND }, BACKEND),
    ).toThrow("does not match the current commit");
    expect(() =>
      parseVerificationPlanHandoff(
        { ...plan, schema: "dure-ci-verification-plan/v0" },
        BACKEND,
      ),
    ).toThrow("schema is unsupported");
    expect(() =>
      parseVerificationPlanHandoff(
        { ...plan, scopes: ["script-tests", "script-tests"] },
        BACKEND,
      ),
    ).toThrow("scopes must be canonical");
    expect(() =>
      parseVerificationPlanHandoff(
        { ...plan, requiresHmuxArtifact: undefined },
        BACKEND,
      ),
    ).toThrow("artifact requirement must be boolean");
  });

  test("round-trips a canonical versioned machine-readable receipt", () => {
    const source = receipt(
      42,
      ["mobile-web", "desktop", "desktop"],
      FULL_BASE,
      BACKEND,
    );

    expect(parseVerificationReceipt(JSON.stringify(source))).toEqual({
      capabilities: [CI_PRODUCT_GATE_CAPABILITY],
      runId: "42",
      schema: CI_VERIFICATION_SCHEMA,
      scopes: ["desktop", "mobile-web"],
      verifiedBase: FULL_BASE,
      verifiedHead: BACKEND,
    });
  });

  test("keeps behavior proof outside the product scope receipt", () => {
    const source = createBehaviorReceipt({
      runId: 42,
      verifiedHead: BACKEND,
    });

    expect(parseBehaviorReceipt(JSON.stringify(source))).toEqual({
      capabilities: [CI_HMUX_BACKGROUND_SMOKE_CAPABILITY],
      runId: "42",
      schema: CI_BEHAVIOR_RECEIPT_SCHEMA,
      verifiedHead: BACKEND,
    });
    expect(() => parseVerificationReceipt(JSON.stringify(source))).toThrow(
      /unsupported CI verification receipt schema/,
    );
  });

  test("round-trips additive phase diagnostics without changing scope proof", () => {
    const diagnostics = createCompletedVerificationDiagnostics({
      ci: { jobName: "verify", runAttempt: "1", runId: "42" },
      executionMs: 4_000,
      hostResourceWaitMs: 300,
      runnerWaitMs: 200,
      workflowConcurrencyMs: 100,
    });
    const source = createVerificationReceipt({
      diagnostics,
      runId: 42,
      scopes: ["frontend"],
      verifiedBase: FULL_BASE,
      verifiedHead: BACKEND,
    });

    expect(parseVerificationReceipt(JSON.stringify(source))).toEqual(source);
    expect(observedVerificationScopes(source)).toEqual(["frontend"]);
  });

  test("rejects noncanonical v3 scope and capability arrays", () => {
    const source = {
      ...receipt(42, ["desktop", "mobile-web"], FULL_BASE, BACKEND),
      scopes: ["mobile-web", "desktop"],
    };

    expect(() => parseVerificationReceipt(JSON.stringify(source))).toThrow(
      /must be canonical/,
    );
    expect(() =>
      parseVerificationReceipt(
        JSON.stringify({
          ...source,
          capabilities: [],
          scopes: ["desktop", "mobile-web"],
        }),
      ),
    ).toThrow(/must prove product-gate/);
  });

  test("reads pre-capability v2 receipts without upgrading their schema", () => {
    const source = preCapabilityReceipt(
      42,
      ["desktop"],
      FULL_BASE,
      BACKEND,
    );

    expect(parseVerificationReceipt(JSON.stringify(source))).toEqual(source);
    expect(observedVerificationScopes(source)).toEqual(["desktop"]);
  });

  test("reads v1 receipts without treating legacy full as mobile coverage", () => {
    const parsed = parseVerificationReceipt(
      JSON.stringify(legacyReceipt(41, "full", FULL_BASE, BACKEND)),
    );
    const observed = observedVerificationScopes(parsed);

    expect(parsed.schema).toBe(LEGACY_CI_VERIFICATION_SCHEMA);
    expect(observed).toContain("desktop");
    expect(observed).not.toContain("mobile-rust");
    expect(observed).not.toContain("mobile-web");
    expect(
      verificationScopesSatisfy(ALL_VERIFICATION_SCOPES, observed),
    ).toBe(false);
  });

  test("requires every required scope to be present in observed evidence", () => {
    expect(
      verificationScopesSatisfy(
        ["desktop", "frontend"],
        ["frontend", "desktop", "hmux-core"],
      ),
    ).toBe(true);
    expect(
      verificationScopesSatisfy(
        ["desktop", "mobile-web"],
        ["desktop", "frontend"],
      ),
    ).toBe(false);
    expect(verificationScopesSatisfy(["not-a-scope"], [])).toBe(false);
  });

  test("runs the background smoke only for changes that consume the terminal Host path", () => {
    expect(requiresHmuxBackgroundSmoke(["src/App.tsx"])).toBe(false);
    expect(
      requiresHmuxBackgroundSmoke(["src/components/SpacesRows.tsx"]),
    ).toBe(false);
    expect(
      requiresHmuxBackgroundSmoke(["src/components/terminal/TerminalViewChrome.tsx"]),
    ).toBe(true);
    expect(requiresHmuxBackgroundSmoke(["src-tauri/src/lib.rs"])).toBe(true);
    expect(
      requiresHmuxBackgroundSmoke(["hmux/crates/hmux-runtime/src/main.rs"]),
    ).toBe(true);
    expect(requiresHmuxBackgroundSmoke(["mobile/src/App.tsx"])).toBe(false);
    expect(
      requiresHmuxBackgroundSmoke(["mobile/src-tauri/src/lib.rs"]),
    ).toBe(false);
    expect(
      requiresHmuxBackgroundSmoke([
        "docs/operations/verification.md",
        ".githooks/pre-push",
      ]),
    ).toBe(false);
    expect(requiresHmuxBackgroundSmoke([])).toBe(true);
    expect(requiresHmuxBackgroundSmoke(["unknown"])).toBe(true);
  });

  test("downloads the product receipt artifact scoped to one run", async () => {
    const record = runRecord(42, BACKEND);
    const expected = receipt(
      42,
      ALL_VERIFICATION_SCOPES,
      FULL_BASE,
      BACKEND,
    );
    const run = vi.fn((_command, args) => {
      const directory = args[args.indexOf("--dir") + 1];
      fs.writeFileSync(
        path.join(directory, "receipt.json"),
        JSON.stringify(expected),
      );
      return { status: 0, stderr: "", stdout: "" };
    });

    await expect(
      downloadVerificationReceipt(run, "hebbianai/HebbianIDE", record),
    ).resolves.toEqual(expected);
    expect(run).toHaveBeenCalledWith("gh", [
      "run",
      "download",
      "42",
      "--repo",
      "hebbianai/HebbianIDE",
      "--name",
      CI_PRODUCT_VERIFICATION_ARTIFACT,
      "--dir",
      expect.any(String),
    ]);
  });

  test("downloads a listed product artifact directly without another run lookup", async () => {
    const record = { ...runRecord(42, BACKEND), artifactId: "99" };
    const expected = receipt(
      42,
      ALL_VERIFICATION_SCOPES,
      FULL_BASE,
      BACKEND,
    );
    const run = vi.fn((command) => {
      if (command === "gh") {
        return {
          status: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from("zip archive"),
        };
      }
      return { status: 0, stderr: "", stdout: JSON.stringify(expected) };
    });

    await expect(
      downloadVerificationReceipt(run, "hebbianai/dure-internal", record),
    ).resolves.toEqual(expected);
    expect(run.mock.calls[0]).toEqual([
      "gh",
      [
        "api",
        "repos/hebbianai/dure-internal/actions/artifacts/99/zip",
      ],
      { encoding: "buffer", maxBuffer: 1024 * 1024 },
    ]);
    expect(run.mock.calls[1]).toEqual([
      "unzip",
      ["-p", expect.stringMatching(/receipt\.zip$/), "receipt.json"],
      { maxBuffer: 1024 * 1024 },
    ]);
  });

  test("treats a failed direct artifact download as no reusable proof", async () => {
    const record = { ...runRecord(42, BACKEND), artifactId: "99" };
    const run = vi.fn(() => ({
      status: 1,
      stderr: Buffer.from("unavailable"),
      stdout: Buffer.alloc(0),
    }));

    await expect(
      downloadVerificationReceipt(run, "hebbianai/dure-internal", record),
    ).resolves.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("falls back to a pre-capability artifact for a green legacy run", async () => {
    const record = runRecord(42, BACKEND);
    const expected = preCapabilityReceipt(
      42,
      ALL_VERIFICATION_SCOPES,
      FULL_BASE,
      BACKEND,
    );
    const run = vi.fn((_command, args) => {
      if (args[args.indexOf("--name") + 1] === CI_PRODUCT_VERIFICATION_ARTIFACT) {
        return { status: 1, stderr: "not found", stdout: "" };
      }
      const directory = args[args.indexOf("--dir") + 1];
      fs.writeFileSync(
        path.join(directory, "receipt.json"),
        JSON.stringify(expected),
      );
      return { status: 0, stderr: "", stdout: "" };
    });

    await expect(
      downloadVerificationReceipt(run, "hebbianai/dure-internal", record),
    ).resolves.toEqual(expected);
    expect(run.mock.calls[1][1]).toContain(
      PRE_CAPABILITY_CI_VERIFICATION_ARTIFACT,
    );
  });

  test("reuses product proof from a run whose later behavior smoke failed", async () => {
    const changedPaths = vi.fn(async (base, head) => {
      if (base === FULL_BASE && head === BACKEND) {
        return ["src-tauri/src/lib.rs"];
      }
      if (base === BACKEND && head === FRONTEND) {
        return ["src/App.tsx"];
      }
      throw new Error(`unexpected range ${base}..${head}`);
    });
    const loadReceipt = vi.fn(async (record) =>
      record.databaseId === 2
        ? receipt(2, ["desktop"], FULL_BASE, BACKEND)
        : receipt(1, ALL_VERIFICATION_SCOPES, FULL_BASE, FULL_BASE),
    );

    const plan = await determineVerificationPlan({
      changedPaths,
      fallbackBase: BACKEND,
      head: FRONTEND,
      isAncestor: ancestry,
      loadReceipt,
      records: [
        runRecord(2, BACKEND, "failure"),
        runRecord(1, FULL_BASE),
      ],
    });

    expect(plan).toMatchObject({
      reason: "complete-watermark",
      scopes: ["frontend"],
      verifiedBase: BACKEND,
    });
  });

  test("reuses published product proof while later behavior smoke is still running", async () => {
    const activeProductRun = {
      conclusion: "",
      databaseId: 2,
      headSha: BACKEND,
      status: "in_progress",
    };
    const changedPaths = vi.fn(async (base, head) => {
      if (base === FULL_BASE && head === BACKEND) {
        return ["src-tauri/src/lib.rs"];
      }
      if (base === BACKEND && head === FRONTEND) {
        return ["src/App.tsx"];
      }
      throw new Error(`unexpected range ${base}..${head}`);
    });
    const plan = await determineVerificationPlan({
      changedPaths,
      fallbackBase: BACKEND,
      head: FRONTEND,
      isAncestor: ancestry,
      loadReceipt: async (record) =>
        record.databaseId === 2
          ? receipt(2, ["desktop"], FULL_BASE, BACKEND)
          : receipt(1, ALL_VERIFICATION_SCOPES, FULL_BASE, FULL_BASE),
      records: [activeProductRun, runRecord(1, FULL_BASE)],
    });

    expect(plan).toMatchObject({
      reason: "complete-watermark",
      scopes: ["frontend"],
      verifiedBase: BACKEND,
    });
  });

  test.each([
    ["failed", runRecord(2, BACKEND, "failure")],
    [
      "in-progress",
      {
        conclusion: "",
        databaseId: 2,
        headSha: BACKEND,
        status: "in_progress",
      },
    ],
  ])("does not reuse pre-capability proof from a %s workflow", async (_state, untrustedRun) => {
    const changedPaths = vi.fn(async () => [
      "src-tauri/src/lib.rs",
      "src/App.tsx",
    ]);
    const plan = await determineVerificationPlan({
      changedPaths,
      fallbackBase: BACKEND,
      head: FRONTEND,
      isAncestor: ancestry,
      loadReceipt: async (record) =>
        record.databaseId === 2
          ? preCapabilityReceipt(2, ["desktop"], FULL_BASE, BACKEND)
          : receipt(1, ALL_VERIFICATION_SCOPES, FULL_BASE, FULL_BASE),
      records: [
        untrustedRun,
        runRecord(1, FULL_BASE),
      ],
    });

    expect(plan.verifiedBase).toBe(FULL_BASE);
    expect(plan.scopes).toEqual(["desktop", "frontend"]);
  });

  test("carries cancelled desktop work into a later frontend push", async () => {
    const activeAllScopes = runRecord(1, FULL_BASE);
    const cancelledBackend = runRecord(2, BACKEND, "cancelled");
    const currentFrontend = {
      conclusion: "",
      databaseId: 3,
      headSha: FRONTEND,
      status: "in_progress",
    };
    const loadReceipt = vi.fn(async (record) =>
      record.databaseId === 1
        ? receipt(1, ALL_VERIFICATION_SCOPES, FULL_BASE, FULL_BASE)
        : null,
    );
    const changedPaths = vi.fn(async () => [
      "src-tauri/src/lib.rs",
      "src/App.tsx",
    ]);

    const plan = await determineVerificationPlan({
      changedPaths,
      fallbackBase: BACKEND,
      head: FRONTEND,
      isAncestor: ancestry,
      loadReceipt,
      records: [currentFrontend, cancelledBackend, activeAllScopes],
    });

    expect(plan).toEqual({
      reason: "complete-watermark",
      requiresHmuxArtifact: true,
      requiresHmuxSmoke: true,
      scopes: ["desktop", "frontend"],
      verifiedBase: FULL_BASE,
      verifiedHead: FRONTEND,
    });
    expect(changedPaths).toHaveBeenCalledWith(FULL_BASE, FRONTEND);
  });

  test("keeps a genuinely frontend-only unverified range on the fast gate", async () => {
    const loadReceipt = vi.fn(async (record) =>
      receipt(
        record.databaseId,
        ALL_VERIFICATION_SCOPES,
        FULL_BASE,
        record.headSha,
      ),
    );
    const plan = await determineVerificationPlan({
      changedPaths: async () => ["src/App.tsx", "docs/architecture/ui.md"],
      fallbackBase: BACKEND,
      head: FRONTEND,
      isAncestor: ancestry,
      loadReceipt,
      records: [
        runRecord(3, BACKEND),
        runRecord(2, FULL_BASE),
        runRecord(1, FULL_BASE),
      ],
    });

    expect(plan.scopes).toEqual(["frontend"]);
    expect(plan.verifiedBase).toBe(BACKEND);
    expect(loadReceipt).toHaveBeenCalledTimes(1);
    expect(loadReceipt).toHaveBeenCalledWith(runRecord(3, BACKEND));
  });

  test("filters listed artifacts by ancestry before downloading old receipts", async () => {
    const newest = {
      ...runRecord(2, BACKEND, "failure"),
      artifactId: "102",
    };
    const older = {
      ...runRecord(1, FULL_BASE, "failure"),
      artifactId: "101",
    };
    const loadReceipt = vi.fn(async (record) => {
      if (record.databaseId !== 2) {
        throw new Error("older receipt should be covered by the new anchor");
      }
      return receipt(2, ALL_VERIFICATION_SCOPES, FULL_BASE, BACKEND);
    });

    const plan = await determineVerificationPlan({
      changedPaths: async () => ["src/App.tsx"],
      fallbackBase: BACKEND,
      head: FRONTEND,
      isAncestor: ancestry,
      loadReceipt,
      records: [newest, older],
    });

    expect(plan.scopes).toEqual(["frontend"]);
    expect(plan.verifiedBase).toBe(BACKEND);
    expect(loadReceipt).toHaveBeenCalledTimes(1);
    expect(loadReceipt).toHaveBeenCalledWith(newest);
  });

  test("loads listed receipts in bounded batches after probing the newest record", async () => {
    const records = [6, 5, 4, 3, 2, 1].map((databaseId) => ({
      ...runRecord(databaseId, BACKEND),
      artifactId: String(100 + databaseId),
    }));
    const active = new Set();
    const releases = new Map();
    const started = [];
    let maxActive = 0;
    const loadReceipt = vi.fn(
      (record) =>
        new Promise((resolve) => {
          const id = String(record.databaseId);
          started.push(id);
          active.add(id);
          maxActive = Math.max(maxActive, active.size);
          releases.set(id, () => {
            active.delete(id);
            resolve(
              receipt(
                record.databaseId,
                ["frontend"],
                FULL_BASE,
                BACKEND,
              ),
            );
          });
        }),
    );

    const planPromise = determineVerificationPlan({
      changedPaths: async () => ["src/App.tsx"],
      fallbackBase: FULL_BASE,
      head: FRONTEND,
      isAncestor: ancestry,
      loadReceipt,
      records,
    });

    expect(started).toEqual(["6"]);
    releases.get("6")();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(["6", "5", "4", "3", "2"]);
    expect(active.size).toBe(4);
    for (const id of ["5", "4", "3", "2"]) releases.get(id)();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(["6", "5", "4", "3", "2", "1"]);
    releases.get("1")();

    await planPromise;
    expect(maxActive).toBe(4);
  });

  test("keeps batch failures isolated and bounds work past a new anchor", async () => {
    const records = [
      { ...runRecord(6, NEXT), artifactId: "106" },
      { ...runRecord(5, FRONTEND), artifactId: "105" },
      { ...runRecord(4, BACKEND), artifactId: "104" },
      { ...runRecord(3, FULL_BASE), artifactId: "103" },
      { ...runRecord(2, FULL_BASE), artifactId: "102" },
      { ...runRecord(1, FULL_BASE), artifactId: "101" },
    ];
    const loadReceipt = vi.fn(async (record) => {
      if (record.databaseId === 4) throw new Error("artifact unavailable");
      if (record.databaseId === 6) {
        return receipt(6, ["frontend"], FRONTEND, NEXT);
      }
      return receipt(
        record.databaseId,
        ALL_VERIFICATION_SCOPES,
        FULL_BASE,
        record.headSha,
      );
    });

    const plan = await determineVerificationPlan({
      changedPaths: async () => ["src/App.tsx"],
      fallbackBase: FULL_BASE,
      head: NEXT,
      isAncestor: ancestry,
      loadReceipt,
      records,
    });

    expect(loadReceipt.mock.calls.map(([record]) => record.databaseId)).toEqual([
      6, 5, 4, 3, 2,
    ]);
    expect(plan).toMatchObject({
      reason: "complete-watermark",
      verifiedBase: NEXT,
    });
  });

  test("keeps mobile-only changes on their exact consumer gates", async () => {
    const cases = [
      {
        paths: ["mobile/src/App.tsx"],
        scopes: ["mobile-web"],
      },
      {
        paths: ["mobile/src-tauri/src/lib.rs"],
        scopes: ["mobile-rust"],
      },
      {
        paths: ["mobile/src/App.tsx", "mobile/src-tauri/src/lib.rs"],
        scopes: ["mobile-rust", "mobile-web"],
      },
    ];

    for (const { paths, scopes } of cases) {
      const plan = await determineVerificationPlan({
        changedPaths: async () => paths,
        fallbackBase: FULL_BASE,
        head: BACKEND,
        isAncestor: ancestry,
        loadReceipt: async () =>
          receipt(1, ALL_VERIFICATION_SCOPES, FULL_BASE, FULL_BASE),
        records: [runRecord(1, FULL_BASE)],
      });

      expect(plan).toEqual({
        reason: "complete-watermark",
        requiresHmuxArtifact: false,
        requiresHmuxSmoke: false,
        scopes,
        verifiedBase: FULL_BASE,
        verifiedHead: BACKEND,
      });
    }
  });

  test("chains a newest-first desktop receipt and does not repeat it", async () => {
    const changedPaths = vi.fn(async (base, head) => {
      if (base === FULL_BASE && head === BACKEND) {
        return ["src-tauri/src/lib.rs"];
      }
      if (base === BACKEND && head === FRONTEND) {
        return ["src/App.tsx"];
      }
      throw new Error(`unexpected range ${base}..${head}`);
    });
    const loadReceipt = vi.fn(async (record) =>
      record.databaseId === 2
        ? receipt(2, ["desktop"], FULL_BASE, BACKEND)
        : receipt(1, ALL_VERIFICATION_SCOPES, FULL_BASE, FULL_BASE),
    );

    const plan = await determineVerificationPlan({
      changedPaths,
      fallbackBase: BACKEND,
      head: FRONTEND,
      isAncestor: ancestry,
      loadReceipt,
      records: [
        runRecord(2, BACKEND),
        runRecord(1, FULL_BASE),
        runRecord(0, FULL_BASE),
      ],
    });

    expect(plan).toEqual({
      reason: "complete-watermark",
      requiresHmuxArtifact: false,
      requiresHmuxSmoke: false,
      scopes: ["frontend"],
      verifiedBase: BACKEND,
      verifiedHead: FRONTEND,
    });
    expect(changedPaths).toHaveBeenCalledWith(FULL_BASE, BACKEND);
    expect(changedPaths).toHaveBeenCalledWith(BACKEND, FRONTEND);
    expect(loadReceipt).toHaveBeenCalledTimes(2);
  });

  test("does not repeat a completed mobile scope on an unrelated push", async () => {
    const changedPaths = vi.fn(async (base, head) => {
      if (base === FULL_BASE && head === BACKEND) {
        return ["mobile/src/App.tsx"];
      }
      if (base === BACKEND && head === FRONTEND) {
        return ["src/App.tsx"];
      }
      throw new Error(`unexpected range ${base}..${head}`);
    });
    const loadReceipt = vi.fn(async (record) =>
      record.databaseId === 2
        ? receipt(2, ["mobile-web"], FULL_BASE, BACKEND)
        : receipt(1, ALL_VERIFICATION_SCOPES, FULL_BASE, FULL_BASE),
    );

    const plan = await determineVerificationPlan({
      changedPaths,
      fallbackBase: BACKEND,
      head: FRONTEND,
      isAncestor: ancestry,
      loadReceipt,
      records: [runRecord(2, BACKEND), runRecord(1, FULL_BASE)],
    });

    expect(plan).toEqual({
      reason: "complete-watermark",
      requiresHmuxArtifact: false,
      requiresHmuxSmoke: false,
      scopes: ["frontend"],
      verifiedBase: BACKEND,
      verifiedHead: FRONTEND,
    });
  });

  test("resolves multiple newest-first partial receipts to a fixed point", async () => {
    const changedPaths = vi.fn(async (base, head) => {
      const range = `${base}..${head}`;
      if (range === `${FULL_BASE}..${BACKEND}`) {
        return ["src-tauri/src/lib.rs"];
      }
      if (range === `${BACKEND}..${FRONTEND}`) {
        return ["src/App.tsx"];
      }
      if (range === `${FRONTEND}..${NEXT}`) {
        return ["docs/operations/ci.md"];
      }
      throw new Error(`unexpected range ${range}`);
    });
    const loadReceipt = vi.fn(async (record) => {
      if (record.databaseId === 3) {
        return receipt(3, ["frontend"], BACKEND, FRONTEND);
      }
      if (record.databaseId === 2) {
        return receipt(2, ["desktop"], FULL_BASE, BACKEND);
      }
      return receipt(1, ALL_VERIFICATION_SCOPES, FULL_BASE, FULL_BASE);
    });

    const plan = await determineVerificationPlan({
      changedPaths,
      fallbackBase: FRONTEND,
      head: NEXT,
      isAncestor: ancestry,
      loadReceipt,
      records: [
        runRecord(3, FRONTEND),
        runRecord(2, BACKEND),
        runRecord(1, FULL_BASE),
      ],
    });

    expect(plan).toEqual({
      reason: "complete-watermark",
      requiresHmuxArtifact: false,
      requiresHmuxSmoke: false,
      scopes: [],
      verifiedBase: FRONTEND,
      verifiedHead: NEXT,
    });
    expect(changedPaths).toHaveBeenCalledWith(BACKEND, FRONTEND);
  });

  test("does not use a v1 full receipt as the all-scopes watermark", async () => {
    const changedPaths = vi.fn();
    const plan = await determineVerificationPlan({
      changedPaths,
      fallbackBase: BACKEND,
      head: FRONTEND,
      isAncestor: ancestry,
      loadReceipt: async () =>
        legacyReceipt(1, "full", FULL_BASE, FULL_BASE),
      records: [runRecord(1, FULL_BASE)],
    });

    expect(plan.reason).toBe("no-all-scopes-watermark");
    expect(plan.scopes).toEqual(ALL_VERIFICATION_SCOPES);
    expect(changedPaths).not.toHaveBeenCalled();
  });

  test("fails closed to all scopes when no durable watermark exists", async () => {
    const changedPaths = vi.fn();
    const plan = await determineVerificationPlan({
      changedPaths,
      fallbackBase: BACKEND,
      head: FRONTEND,
      isAncestor: ancestry,
      loadReceipt: async () => null,
      records: [runRecord(1, FULL_BASE)],
    });

    expect(plan).toEqual({
      reason: "no-all-scopes-watermark",
      requiresHmuxArtifact: true,
      requiresHmuxSmoke: true,
      scopes: ALL_VERIFICATION_SCOPES,
      verifiedBase: BACKEND,
      verifiedHead: FRONTEND,
    });
    expect(changedPaths).not.toHaveBeenCalled();
  });

  test("fails closed to all scopes when the changed-path read fails", async () => {
    const plan = await determineVerificationPlan({
      changedPaths: async () => {
        throw new Error("diff unavailable");
      },
      fallbackBase: BACKEND,
      head: FRONTEND,
      isAncestor: ancestry,
      loadReceipt: async () =>
        receipt(1, ALL_VERIFICATION_SCOPES, FULL_BASE, FULL_BASE),
      records: [runRecord(1, FULL_BASE)],
    });

    expect(plan).toEqual({
      reason: "diff-unavailable",
      requiresHmuxArtifact: true,
      requiresHmuxSmoke: true,
      scopes: ALL_VERIFICATION_SCOPES,
      verifiedBase: FULL_BASE,
      verifiedHead: FRONTEND,
    });
  });
});

describe("hmux smoke reuse decision (capability fingerprint)", () => {
  const FP = { schemaVersion: 1, fingerprint: "a".repeat(64) };
  const receiptWith = (fingerprint, runId = "100") =>
    createBehaviorReceipt({
      capabilities: ["hmux-background-smoke"],
      ...(fingerprint ? { capabilityFingerprint: fingerprint } : {}),
      runId,
      verifiedHead: "d".repeat(40),
    });

  test("동일 fingerprint의 영수증만 재사용 근거가 된다 — 최신 runId 우선", () => {
    const decision = hmuxSmokeReuseDecision({
      currentFingerprint: FP,
      candidateReceipts: [
        receiptWith(FP, "100"),
        receiptWith(FP, "250"),
        receiptWith({ schemaVersion: 1, fingerprint: "b".repeat(64) }, "300"),
      ],
    });
    expect(decision.reuse).toBe(true);
    expect(decision.source.runId).toBe("250");
  });

  test("fail-closed: 현재 fingerprint 부재·구 영수증(무필드)·schema 불일치·깨진 JSON은 전부 재사용 불가", () => {
    expect(
      hmuxSmokeReuseDecision({ currentFingerprint: null, candidateReceipts: [receiptWith(FP)] }).reuse,
    ).toBe(false);
    expect(
      hmuxSmokeReuseDecision({ currentFingerprint: FP, candidateReceipts: [receiptWith(undefined)] }).reuse,
    ).toBe(false);
    expect(
      hmuxSmokeReuseDecision({
        currentFingerprint: FP,
        candidateReceipts: [receiptWith({ schemaVersion: 2, fingerprint: "a".repeat(64) })],
      }).reuse,
    ).toBe(false);
    expect(
      hmuxSmokeReuseDecision({ currentFingerprint: FP, candidateReceipts: ["not json"] }).reuse,
    ).toBe(false);
  });

  test("fingerprint 필드는 형태가 강제되고 round-trip에서 보존된다", () => {
    const receipt = receiptWith(FP);
    expect(parseBehaviorReceipt(JSON.stringify(receipt)).capabilityFingerprint).toEqual(FP);
    expect(() =>
      createBehaviorReceipt({
        capabilities: ["hmux-background-smoke"],
        capabilityFingerprint: { schemaVersion: 1, fingerprint: "short" },
        runId: "1",
        verifiedHead: "d".repeat(40),
      }),
    ).toThrow(/malformed/);
  });
});

describe("smoke reuse activation (capability fingerprint 2b)", () => {
  const fingerprint = { schemaVersion: 1, fingerprint: "a".repeat(64) };
  const head = "b".repeat(40);
  const genuine = (runId) =>
    createBehaviorReceipt({
      capabilityFingerprint: fingerprint,
      runId,
      verifiedHead: head,
    });

  test("reusedFromRunId: round-trip 보존, 빈 문자열은 부재, 형태 강제", () => {
    const receipt = createBehaviorReceipt({
      capabilityFingerprint: fingerprint,
      reusedFromRunId: "77",
      runId: "78",
      verifiedHead: head,
    });
    expect(receipt.reusedFromRunId).toBe("77");
    expect(parseBehaviorReceipt(JSON.stringify(receipt))).toEqual(receipt);
    // ci.yml 표현식은 재사용이 아닐 때 ''를 전달한다 — 부재와 동일해야 한다.
    expect(
      createBehaviorReceipt({
        capabilityFingerprint: fingerprint,
        reusedFromRunId: "",
        runId: "78",
        verifiedHead: head,
      }).reusedFromRunId,
    ).toBeUndefined();
    expect(() =>
      createBehaviorReceipt({
        capabilityFingerprint: fingerprint,
        reusedFromRunId: "x9",
        runId: "78",
        verifiedHead: head,
      }),
    ).toThrow(/runId/);
  });

  test("재사용 영수증은 미래 재사용의 근거가 아니다 — 실제 실행 1홉 앵커", () => {
    const reused = createBehaviorReceipt({
      capabilityFingerprint: fingerprint,
      reusedFromRunId: "70",
      runId: "90",
      verifiedHead: head,
    });
    expect(
      hmuxSmokeReuseDecision({
        currentFingerprint: fingerprint,
        candidateReceipts: [reused],
      }),
    ).toEqual({ reuse: false, reason: "no_matching_receipt" });
    const withGenuine = hmuxSmokeReuseDecision({
      currentFingerprint: fingerprint,
      candidateReceipts: [reused, genuine("80")],
    });
    expect(withGenuine.reuse).toBe(true);
    expect(withGenuine.source.runId).toBe("80");
  });

  test("runId는 숫자로 비교한다 — 자릿수가 달라도 최신 실행이 이긴다", () => {
    const decision = hmuxSmokeReuseDecision({
      currentFingerprint: fingerprint,
      candidateReceipts: [genuine("999"), genuine("10000")],
    });
    expect(decision.source.runId).toBe("10000");
  });

  test("behavior 아티팩트 목록은 smoke 영수증 이름으로 조회한다", () => {
    const runHead = "c".repeat(40);
    const request = (args) => {
      expect(args[1]).toContain("name=ci-hmux-background-smoke-receipt-v1");
      return JSON.stringify({
        artifacts: [
          { expired: false, id: 7, workflow_run: { head_sha: runHead, id: 5 } },
        ],
      });
    };
    expect(behaviorReceiptRecords("HebbianAI/dure-internal", request)).toEqual([
      {
        artifactId: "7",
        conclusion: null,
        databaseId: "5",
        headSha: runHead,
        status: "artifact-published",
      },
    ]);
  });

  test("downloadBehaviorReceipt: 성공 경로, 모든 실패는 null 강등", async () => {
    const receipt = genuine("55");
    const run = async (command) => {
      if (command === "gh") return { status: 0, stdout: Buffer.from("zip") };
      return { status: 0, stdout: JSON.stringify(receipt) };
    };
    expect(await downloadBehaviorReceipt(run, "o/r", { artifactId: "9" })).toEqual(
      receipt,
    );
    expect(
      await downloadBehaviorReceipt(
        async () => ({ status: 1, stdout: Buffer.alloc(0) }),
        "o/r",
        { artifactId: "9" },
      ),
    ).toBeNull();
    expect(await downloadBehaviorReceipt(run, "o/r", { artifactId: "abc" })).toBeNull();
    const broken = async (command) =>
      command === "gh"
        ? { status: 0, stdout: Buffer.from("zip") }
        : { status: 0, stdout: "not json" };
    expect(await downloadBehaviorReceipt(broken, "o/r", { artifactId: "9" })).toBeNull();
  });
});

describe("fingerprint component breakdown (진단 전용)", () => {
  const hex = (char) => char.repeat(64);
  const components = {
    entrypoints: hex("1"),
    sources: hex("2"),
    adapterSources: hex("6"),
    runtimeSources: hex("3"),
    harness: hex("7"),
    toolchain: hex("4"),
    os: hex("5"),
  };
  const head = "b".repeat(40);
  const withComponents = (runId, overrides = {}, extra = {}) =>
    createBehaviorReceipt({
      capabilityFingerprint: {
        schemaVersion: 1,
        fingerprint: hex("a"),
        components: { ...components, ...overrides },
      },
      runId,
      verifiedHead: head,
      ...extra,
    });

  test("components: round-trip 보존, 부분 breakdown은 거부", () => {
    const receipt = withComponents("60");
    expect(receipt.capabilityFingerprint.components).toEqual(components);
    expect(parseBehaviorReceipt(JSON.stringify(receipt))).toEqual(receipt);
    // 부분/오염 breakdown은 없는 것보다 나쁘다 — 형태 강제.
    expect(() =>
      createBehaviorReceipt({
        capabilityFingerprint: {
          schemaVersion: 1,
          fingerprint: hex("a"),
          components: { sources: hex("2") },
        },
        runId: "60",
        verifiedHead: head,
      }),
    ).toThrow(/components are malformed/);
    // components 없는 구 영수증은 여전히 유효.
    expect(
      createBehaviorReceipt({
        capabilityFingerprint: { schemaVersion: 1, fingerprint: hex("a") },
        runId: "60",
        verifiedHead: head,
      }).capabilityFingerprint.components,
    ).toBeUndefined();
  });

  test("불일치 진단: 갈라진 컴포넌트를 최신 genuine 기준으로 서술한다", () => {
    const current = { ...components, runtimeSources: hex("f") };
    const candidates = [
      withComponents("50"),
      withComponents("70", { sources: hex("e") }),
      // 재사용 영수증과 breakdown 없는 영수증은 진단 기준에서도 제외.
      withComponents("90", {}, { reusedFromRunId: "40" }),
    ];
    expect(
      describeFingerprintMismatch(
        { schemaVersion: 1, components: current },
        candidates,
      ),
    ).toBe("diverged from run 70 in: sources, runtimeSources");
    expect(
      describeFingerprintMismatch({ schemaVersion: 1, components: current }, []),
    ).toBe("no same-schema genuine candidate carries a component breakdown");
    expect(
      describeFingerprintMismatch(
        { schemaVersion: 1, components },
        [withComponents("70")],
      ),
    ).toBe(
      "components identical to run 70 yet fingerprints differ — schema drift suspected",
    );
    // schemaVersion이 다른 후보의 컴포넌트 해시는 계산 자체가 달라 비교
    // 불능 — 기준에서 제외돼야 오진(잘못된 입력군 지목)이 안 생긴다.
    expect(
      describeFingerprintMismatch(
        { schemaVersion: 2, components: current },
        candidates,
      ),
    ).toBe("no same-schema genuine candidate carries a component breakdown");
  });

  test("미지 컴포넌트 키는 조용히 버리지 않고 거부한다", () => {
    // 새 컴포넌트 추가가 한쪽에만 반영되면 진단이 소리 없이 눈멀게 된다 —
    // 초과 키도 형태 위반이다.
    expect(() =>
      createBehaviorReceipt({
        capabilityFingerprint: {
          schemaVersion: 1,
          fingerprint: hex("a"),
          components: { ...components, futureKey: hex("9") },
        },
        runId: "60",
        verifiedHead: head,
      }),
    ).toThrow(/components are malformed/);
  });
});
