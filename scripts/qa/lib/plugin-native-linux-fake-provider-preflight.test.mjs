import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  LINUX_NATIVE_PROVIDER_FAKE_FIXTURE_ID,
  LINUX_NATIVE_PROVIDER_FAKE_PROBE_CASES,
  LINUX_NATIVE_PROVIDER_FAKE_PROBE_PLAN_SCHEMA,
  LINUX_NATIVE_PROVIDER_LIVE_EVIDENCE_GAP_SCHEMA,
  LinuxNativeProviderFakePreflightError,
  assertLinuxNativeProviderFakeProbeInvocationAuthorityV1,
  assertLinuxNativeProviderFakeProbeQualificationAuthorityV1,
  createLinuxNativeProviderFakeProbePlanV1,
  createLinuxNativeProviderLiveEvidenceGapV1,
  linuxNativeProviderFakeProbePlanSha256V1,
  normalizeLinuxNativeProviderFakeProbePlanV1,
  normalizeLinuxNativeProviderLiveEvidenceGapV1,
  parseLinuxNativeProviderFakeProbePlanV1,
  parseLinuxNativeProviderLiveEvidenceGapV1,
  serializeLinuxNativeProviderFakeProbePlanV1,
  serializeLinuxNativeProviderLiveEvidenceGapV1,
} from "./plugin-native-linux-fake-provider-preflight.mjs";
import {
  LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID,
  LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256,
  LinuxNativeProviderContainmentAuthorityError,
} from "../../lib/plugin-native-linux-containment-capability.mjs";

const TARGET = Object.freeze({ os: "linux", arch: "x86_64" });
const EXPECTED_CASES = Object.freeze([
  "stale_boot_replay",
  "stale_process_generation_replay",
  "replaced_launcher_fd",
  "namespace_tuple_splice",
  "cgroup_generation_reuse",
  "argv_share_net_override",
  "argv_try_fallback",
  "argv_hidden_args_fd",
  "environment_inheritance",
  "writable_nested_mount",
  "fd_number_reuse",
  "self_reported_probe_forgery",
]);

function plan(overrides = {}) {
  return {
    schema: LINUX_NATIVE_PROVIDER_FAKE_PROBE_PLAN_SCHEMA,
    policy_id: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID,
    policy_sha256: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256,
    target: TARGET,
    authority: "none",
    scope: "fake_fixture_only",
    disposition: "non_qualifying",
    reusable: false,
    fixture_id: LINUX_NATIVE_PROVIDER_FAKE_FIXTURE_ID,
    cases: [...LINUX_NATIVE_PROVIDER_FAKE_PROBE_CASES],
    ...overrides,
  };
}

function gap(expectedPlan, overrides = {}) {
  return {
    schema: LINUX_NATIVE_PROVIDER_LIVE_EVIDENCE_GAP_SCHEMA,
    policy_id: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_ID,
    policy_sha256: LINUX_NATIVE_PROVIDER_CONTAINMENT_POLICY_SHA256,
    plan_sha256: linuxNativeProviderFakeProbePlanSha256V1(expectedPlan),
    target: expectedPlan.target,
    authority: "none",
    scope: "fake_fixture_only",
    disposition: "non_qualifying",
    reusable: false,
    state: "not_observed",
    reason_code: "live_observer_not_implemented",
    ...overrides,
  };
}

describe("Linux fake-provider preflight remains non-qualifying", () => {
  it("pins the v1 inert adversarial case order", () => {
    expect(LINUX_NATIVE_PROVIDER_FAKE_PROBE_CASES).toEqual(EXPECTED_CASES);
    const created = createLinuxNativeProviderFakeProbePlanV1(TARGET);
    expect(created.cases).toBe(LINUX_NATIVE_PROVIDER_FAKE_PROBE_CASES);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.target)).toBe(true);
    expect(Object.isFrozen(created.cases)).toBe(true);
    expect(created.authority).toBe("none");
    expect(created.disposition).toBe("non_qualifying");
    expect(created.reusable).toBe(false);
  });

  it("rejects omitted, duplicated, reordered, and unknown attack cases", () => {
    const omitted = EXPECTED_CASES.slice(1);
    const duplicated = [...EXPECTED_CASES, EXPECTED_CASES.at(-1)];
    const reordered = [...EXPECTED_CASES];
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    const trailingHoles = [...EXPECTED_CASES];
    trailingHoles.length = 100;
    for (const cases of [
      omitted,
      duplicated,
      reordered,
      [...EXPECTED_CASES, "future_case"],
      trailingHoles,
    ]) {
      expect(() =>
        normalizeLinuxNativeProviderFakeProbePlanV1(plan({ cases })),
      ).toThrow(LinuxNativeProviderFakePreflightError);
    }
  });

  it("snapshots stateful proxy values before validation and serialization", () => {
    let targetReads = 0;
    const target = new Proxy(
      { os: "linux", arch: "x86_64" },
      {
        get(object, property, receiver) {
          if (property === "arch") {
            targetReads += 1;
            return targetReads === 1 ? "x86_64" : "riscv64";
          }
          return Reflect.get(object, property, receiver);
        },
      },
    );
    const normalizedPlan = normalizeLinuxNativeProviderFakeProbePlanV1(
      plan({ target }),
    );
    expect(normalizedPlan.target.arch).toBe("x86_64");
    expect(targetReads).toBe(0);

    const rawGap = gap(normalizedPlan);
    let digestReads = 0;
    const gapProxy = new Proxy(rawGap, {
      get(object, property, receiver) {
        if (property === "plan_sha256") {
          digestReads += 1;
          return digestReads === 1 ? object.plan_sha256 : `sha256:${"0".repeat(64)}`;
        }
        return Reflect.get(object, property, receiver);
      },
    });
    expect(
      normalizeLinuxNativeProviderLiveEvidenceGapV1(gapProxy, normalizedPlan)
        .plan_sha256,
    ).toBe(rawGap.plan_sha256);
    expect(digestReads).toBe(0);
  });

  it("rejects raw execution and qualification-shaped fields", () => {
    for (const field of [
      "status",
      "passed",
      "supported",
      "qualified",
      "receipt",
      "provider",
      "observations",
      "boot_id",
      "pid",
      "namespace",
      "cgroup",
      "executable",
      "argv",
      "args",
      "command",
      "env",
      "environment",
      "mounts",
      "fds",
      "expires_at",
    ]) {
      expect(() =>
        normalizeLinuxNativeProviderFakeProbePlanV1(
          plan({ [field]: field === "passed" ? true : "forged" }),
        ),
      ).toThrow(LinuxNativeProviderFakePreflightError);
    }
  });

  it("rejects every attempt to widen the fake-only authority boundary", () => {
    for (const forged of [
      plan({ authority: "granted" }),
      plan({ scope: "real_provider" }),
      plan({ disposition: "qualifying" }),
      plan({ reusable: true }),
      plan({ fixture_id: "codex" }),
      plan({ policy_id: "linux-bwrap-networkless-v0" }),
      plan({ policy_sha256: `sha256:${"0".repeat(64)}` }),
      plan({ target: { os: "darwin", arch: "arm64" } }),
      plan({ target: { os: "linux", arch: "riscv64" } }),
    ]) {
      expect(() => normalizeLinuxNativeProviderFakeProbePlanV1(forged)).toThrow(
        LinuxNativeProviderFakePreflightError,
      );
    }
  });

  it("emits only a not-observed evidence gap bound to one exact plan", () => {
    const firstPlan = createLinuxNativeProviderFakeProbePlanV1(TARGET);
    const otherPlan = createLinuxNativeProviderFakeProbePlanV1({
      os: "linux",
      arch: "aarch64",
    });
    const evidenceGap = createLinuxNativeProviderLiveEvidenceGapV1(firstPlan);
    expect(evidenceGap).toMatchObject({
      authority: "none",
      disposition: "non_qualifying",
      reusable: false,
      state: "not_observed",
      reason_code: "live_observer_not_implemented",
    });
    expect(() =>
      normalizeLinuxNativeProviderLiveEvidenceGapV1(evidenceGap, otherPlan),
    ).toThrow(/target|plan/);
    expect(() =>
      normalizeLinuxNativeProviderLiveEvidenceGapV1(
        { ...evidenceGap, plan_sha256: linuxNativeProviderFakeProbePlanSha256V1(otherPlan) },
        firstPlan,
      ),
    ).toThrow(/plan/);
  });

  it("rejects observed, success, replay, and raw fact injection in the gap", () => {
    const expectedPlan = createLinuxNativeProviderFakeProbePlanV1(TARGET);
    for (const forged of [
      gap(expectedPlan, { state: "observed" }),
      gap(expectedPlan, { state: "passed" }),
      gap(expectedPlan, { reason_code: "probe_completed" }),
      gap(expectedPlan, { authority: "granted" }),
      gap(expectedPlan, { scope: "real_provider" }),
      gap(expectedPlan, { disposition: "qualifying" }),
      gap(expectedPlan, { reusable: true }),
      gap(expectedPlan, { boot_id: "forged" }),
      gap(expectedPlan, { observations: [] }),
      gap(expectedPlan, { receipt: { status: "passed" } }),
    ]) {
      expect(() =>
        normalizeLinuxNativeProviderLiveEvidenceGapV1(forged, expectedPlan),
      ).toThrow(LinuxNativeProviderFakePreflightError);
    }
  });

  it("rejects accessor, symbol, non-enumerable, and prototype-shaped input", () => {
    const accessorPlan = plan();
    Object.defineProperty(accessorPlan, "scope", {
      enumerable: true,
      get: () => "fake_fixture_only",
    });
    const symbolPlan = plan();
    symbolPlan[Symbol("extra")] = true;
    const hiddenPlan = plan();
    Object.defineProperty(hiddenPlan, "extra", { value: true });
    for (const forged of [
      accessorPlan,
      symbolPlan,
      hiddenPlan,
      Object.assign(Object.create({ injected: true }), plan()),
    ]) {
      expect(() => normalizeLinuxNativeProviderFakeProbePlanV1(forged)).toThrow(
        LinuxNativeProviderFakePreflightError,
      );
    }
  });

  it("uses pinned canonical bytes for the plan and evidence gap", () => {
    const createdPlan = createLinuxNativeProviderFakeProbePlanV1(TARGET);
    const createdGap = createLinuxNativeProviderLiveEvidenceGapV1(createdPlan);
    const planSource = serializeLinuxNativeProviderFakeProbePlanV1(createdPlan);
    const gapSource = serializeLinuxNativeProviderLiveEvidenceGapV1(
      createdGap,
      createdPlan,
    );
    expect(planSource).toBe(
      '{"schema":"dure-linux-native-provider-containment-fake-probe-plan/v1","policy_id":"linux-bwrap-networkless-v1","policy_sha256":"sha256:5b0861b7914f8c017ca239f1bac0f89c9df92c08a8cd123bee0ce3937a91c3d0","target":{"os":"linux","arch":"x86_64"},"authority":"none","scope":"fake_fixture_only","disposition":"non_qualifying","reusable":false,"fixture_id":"dure-linux-containment-adversary-v1","cases":["stale_boot_replay","stale_process_generation_replay","replaced_launcher_fd","namespace_tuple_splice","cgroup_generation_reuse","argv_share_net_override","argv_try_fallback","argv_hidden_args_fd","environment_inheritance","writable_nested_mount","fd_number_reuse","self_reported_probe_forgery"]}',
    );
    expect(linuxNativeProviderFakeProbePlanSha256V1(createdPlan)).toBe(
      "sha256:822d157d39307796eb5780290d87cb161473cc93c2700cf95d0235dc48ffff3f",
    );
    expect(gapSource).toBe(
      '{"schema":"dure-linux-native-provider-containment-live-evidence-gap/v1","policy_id":"linux-bwrap-networkless-v1","policy_sha256":"sha256:5b0861b7914f8c017ca239f1bac0f89c9df92c08a8cd123bee0ce3937a91c3d0","plan_sha256":"sha256:822d157d39307796eb5780290d87cb161473cc93c2700cf95d0235dc48ffff3f","target":{"os":"linux","arch":"x86_64"},"authority":"none","scope":"fake_fixture_only","disposition":"non_qualifying","reusable":false,"state":"not_observed","reason_code":"live_observer_not_implemented"}',
    );
    expect(parseLinuxNativeProviderFakeProbePlanV1(planSource)).toEqual(
      createdPlan,
    );
    expect(
      parseLinuxNativeProviderLiveEvidenceGapV1(gapSource, createdPlan),
    ).toEqual(createdGap);
    expect(() => parseLinuxNativeProviderFakeProbePlanV1(` ${planSource}`)).toThrow(
      /canonical/,
    );
    expect(() =>
      parseLinuxNativeProviderLiveEvidenceGapV1(`${gapSource}\n`, createdPlan),
    ).toThrow(/canonical/);
  });

  it("always denies fake invocation and qualification before spawn", () => {
    const expectedPlan = createLinuxNativeProviderFakeProbePlanV1(TARGET);
    const evidenceGap = createLinuxNativeProviderLiveEvidenceGapV1(expectedPlan);
    expect(() =>
      assertLinuxNativeProviderFakeProbeInvocationAuthorityV1(expectedPlan),
    ).toThrow(LinuxNativeProviderContainmentAuthorityError);
    expect(() =>
      assertLinuxNativeProviderFakeProbeQualificationAuthorityV1(
        expectedPlan,
        evidenceGap,
      ),
    ).toThrow(LinuxNativeProviderContainmentAuthorityError);
  });

  it("imports only crypto and the authority-none capability contract", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("./plugin-native-linux-fake-provider-preflight.mjs", import.meta.url),
      ),
      "utf8",
    );
    const parsed = ts.createSourceFile(
      "plugin-native-linux-fake-provider-preflight.mjs",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const dependencies = [];
    const dynamicLoaders = [];
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        dependencies.push(node.moduleSpecifier.text);
      }
      if (
        node.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node) &&
          [
            "Bun",
            "Deno",
            "EventSource",
            "Function",
            "WebSocket",
            "XMLHttpRequest",
            "eval",
            "fetch",
            "globalThis",
            "module",
            "navigator",
            "process",
            "require",
          ].includes(node.text))
      ) {
        dynamicLoaders.push(node.getText(parsed));
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(parsed.parseDiagnostics).toEqual([]);
    expect(dependencies).toEqual([
      "node:crypto",
      "../../lib/plugin-native-linux-containment-capability.mjs",
    ]);
    expect(dynamicLoaders).toEqual([]);
  });
});
