import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope, check, loadBaseline, writeBaseline } from "./envelope.ts";
import { extractVars, scanEvidence } from "./evidence.ts";
import { judge, loadOverrides } from "./judge.ts";
import { scanSurfaces } from "./surface-scanner.ts";
import { scanDocumentedTokens, scanTokens } from "./token-scanner.ts";
import { BASELINE_SCHEMA_VERSION, type Overrides, type TokenInventory } from "./types.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const roots: string[] = [];
const fixtureRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "design-check-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const emptyScan = { candidates: [], errors: [], anchorMatches: {} };
const emptyEvidence = { mockups: [], errors: [] };
const emptyOverrides: Overrides = {
  schemaVersion: 1,
  surface: { exclude: {}, merge: {}, renamedFrom: {} },
  token: { exclude: {} },
};
const inventory = (name: string, value: string): TokenInventory => ({
  names: [name], declarations: [{ name, scope: "root", value }], runtimeNames: [], scanErrors: [],
});
const surface = {
  id: "surface:demo/Panel", cluster: "demo", name: "Panel",
  file: "src/components/demo/Panel.tsx", anchors: [], surfaceKind: "unclassified",
};
const surfaceScan = { ...emptyScan, candidates: [surface] };
const emptyBaseline = { schemaVersion: BASELINE_SCHEMA_VERSION, uncovered: [] };

it("accepts source surfaces without a screen specification or mockup", async () => {
  const root = mkdtempSync(join(tmpdir(), "design-source-inventory-"));
  try {
    mkdirSync(join(root, "src/components/demo"), { recursive: true });
    mkdirSync(join(root, "src/lib/theme"), { recursive: true });
    writeFileSync(join(root, "src/components/demo/Panel.tsx"), "export function Panel() { return <section />; }\n");
    writeFileSync(join(root, "src/index.css"), ":root {}\n");
    writeFileSync(join(root, "src/lib/theme/themeStyle.ts"), "export {};\n");
    const surfaces = scanSurfaces(root);
    expect(surfaces.candidates.map((surface) => surface.id)).toEqual(["surface:demo/Panel"]);
    const tokens = await scanTokens(root);
    const { overrides } = loadOverrides(root);
    const judgment = judge(surfaces, tokens, [], scanEvidence(root), overrides);
    const envelope = buildEnvelope(root, judgment, surfaces, tokens, overrides);
    expect(check(envelope, { schemaVersion: BASELINE_SCHEMA_VERSION, uncovered: [] }, [])).toMatchObject({
      ok: true, newUncovered: [], errors: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("token drift judgment (synthetic fixtures — must not depend on live DESIGN.md state)", () => {
  it("flags a stale documented value as uncovered with drift detail", () => {
    const judgment = judge(
      emptyScan,
      inventory("--x", "#15803d"),
      [{ name: "--x", light: "#16a34a", dark: null }],
      emptyEvidence,
      emptyOverrides,
    );
    const item = judgment.tokenItems.find((i) => i.id === "token:--x");
    expect(item?.verdict).toBe("uncovered");
    expect(String(item?.detail.drift ?? "")).toContain("documented");
  });

  it("accepts an equivalent value across hex/oklch notation", () => {
    const judgment = judge(
      emptyScan,
      inventory("--x", "oklch(1 0 0 / 10%)"),
      [{ name: "--x", light: "#ffffff1a", dark: null }],
      emptyEvidence,
      emptyOverrides,
    );
    expect(judgment.tokenItems.find((i) => i.id === "token:--x")?.verdict).toBe("covered");
  });

  it("counts undocumented tokens as uncovered, not errors", () => {
    const judgment = judge(emptyScan, inventory("--x", "#123456"), [], emptyEvidence, emptyOverrides);
    const item = judgment.tokenItems.find((i) => i.id === "token:--x");
    expect(item?.verdict).toBe("uncovered");
    expect(item?.detail.documented).toBe(false);
    expect(judgment.errors).toEqual([]);
  });
});

describe("optional mockup validation", () => {
  const writeMockup = (root: string, path: string, html = "<section />") => {
    const file = join(root, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, html);
  };

  it("checks a valid optional mockup against source identity and real/runtime tokens", () => {
    const root = fixtureRoot();
    const path = "design/mockups/demo/Panel/default.html";
    writeMockup(root, path, '<section style="color:var(--paper);background:var(--runtime)">Ready</section>');
    const tokens = { ...inventory("--paper", "#fff"), runtimeNames: ["--runtime"] };
    const evidence = scanEvidence(root);
    const judgment = judge(surfaceScan, tokens, [{ name: "--paper", light: "#fff", dark: null }], evidence, emptyOverrides);
    const envelope = buildEnvelope(root, judgment, surfaceScan, tokens, emptyOverrides);
    expect(check(envelope, emptyBaseline, [])).toMatchObject({ ok: true, errors: [] });
    expect(envelope.surfaces).toEqual([surface]);
    expect(envelope.mockups).toEqual([{ path, surfaceLocalId: "demo/Panel", state: "ideal", vars: ["--paper", "--runtime"] }]);
  });

  it.each([
    ["design/mockups/demo/Panel.html", "mockups must live"],
    ["design/mockups/demo/Panel/unknown.html", "unknown state filename"],
    ["design/mockups/demo/Panel/constructor.html", "unknown state filename"],
    ["design/mockups/missing/Panel/default.html", "no inventory id"],
  ])("rejects malformed or orphan mockups: %s", (path, message) => {
    const root = fixtureRoot();
    writeMockup(root, path);
    const tokens: TokenInventory = { names: [], declarations: [], runtimeNames: [], scanErrors: [] };
    const judgment = judge(surfaceScan, tokens, [], scanEvidence(root), emptyOverrides);
    const result = check(buildEnvelope(root, judgment, surfaceScan, tokens, emptyOverrides), emptyBaseline, []);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "orphan-evidence", file: path, message: expect.stringContaining(message) }));
  });

  it("rejects an unresolved primary token even when CSS provides a fallback", () => {
    const root = fixtureRoot();
    const path = "design/mockups/demo/Panel/default.html";
    writeMockup(root, path, '<section style="color:var(--missing, #fff)">Ready</section>');
    const tokens = inventory("--paper", "#fff");
    const judgment = judge(surfaceScan, tokens, [], scanEvidence(root), emptyOverrides);
    const result = check(buildEnvelope(root, judgment, surfaceScan, tokens, emptyOverrides), { ...emptyBaseline, uncovered: ["token:--paper"] }, []);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "unresolved-var", file: path, message: expect.stringContaining("--missing") }));
  });

  it("uses curated identities for mockup lookup and keeps excluded sources separate", () => {
    const root = fixtureRoot();
    const scan = { ...emptyScan, candidates: [surface, { ...surface, id: "surface:demo/Child" }, { ...surface, id: "surface:demo/Shim" }] };
    const overrides: Overrides = { ...emptyOverrides, surface: {
      exclude: { "surface:demo/Shim": "Internal compatibility entry" },
      merge: { "surface:demo/Combined": { members: [surface.id, "surface:demo/Child"] } },
      renamedFrom: { "surface:demo/Old": "surface:demo/Combined" },
    } };
    writeMockup(root, "design/mockups/demo/Combined/default.html");
    const tokens: TokenInventory = { names: [], declarations: [], runtimeNames: [], scanErrors: [] };
    const judgment = judge(scan, tokens, [], scanEvidence(root), overrides);
    const envelope = buildEnvelope(root, judgment, scan, tokens, overrides);
    expect(check(envelope, emptyBaseline, []).ok).toBe(true);
    expect(envelope.surfaces.map((item) => item.id)).toEqual(["surface:demo/Combined"]);
    expect(envelope.excluded).toEqual([{ id: "surface:demo/Shim", reason: "Internal compatibility entry" }]);
    expect(envelope.aliases).toEqual(overrides.surface.renamedFrom);
  });

  it("ignores HTML and CSS comments when extracting token references", () => {
    expect(extractVars('<!-- var(--fake) --><style>/*var(--also-fake)*/i{color:var(--real)}</style>')).toEqual(["--real"]);
  });
});

describe("token baseline authority", () => {
  const tokenEnvelope = (root: string, names: string[]) => {
    const tokens: TokenInventory = { names, declarations: [], runtimeNames: [], scanErrors: [] };
    return buildEnvelope(root, judge(emptyScan, tokens, [], emptyEvidence, emptyOverrides), emptyScan, tokens, emptyOverrides);
  };

  it("fails on new undocumented tokens and preserves only explicit existing debt", () => {
    const envelope = tokenEnvelope(fixtureRoot(), ["--a"]);
    expect(check(envelope, emptyBaseline, [])).toMatchObject({ ok: false, newUncovered: ["token:--a"] });
    expect(check(envelope, { ...emptyBaseline, uncovered: ["token:--a"] }, [])).toMatchObject({ ok: true, shrinkable: [] });
  });

  it("fails on drift even when no screen prose is required", () => {
    const root = fixtureRoot();
    const tokens = inventory("--paper", "#fff");
    const judgment = judge(surfaceScan, tokens, [{ name: "--paper", light: "#000", dark: null }], emptyEvidence, emptyOverrides);
    const result = check(buildEnvelope(root, judgment, surfaceScan, tokens, emptyOverrides), emptyBaseline, []);
    expect(result).toMatchObject({ ok: false, newUncovered: ["token:--paper"] });
  });

  it.each([
    { schemaVersion: 1, uncovered: ["token:--a"] },
    { ...emptyBaseline, uncovered: ["surface:demo/Panel"] },
    { ...emptyBaseline, uncovered: ["token:--a#state.empty"] },
    { ...emptyBaseline, uncovered: ["unknown:--a"] },
  ])("rejects incompatible or non-token baseline inputs: %j", (baseline) => {
    const root = fixtureRoot();
    mkdirSync(join(root, "design"));
    writeFileSync(join(root, "design/design-coverage-baseline.json"), JSON.stringify(baseline));
    const loaded = loadBaseline(root);
    expect(loaded.errors).toContainEqual(expect.objectContaining({ code: "invalid-baseline" }));
    expect(check(tokenEnvelope(root, []), loaded.baseline, loaded.errors).ok).toBe(false);
  });

  it("refuses baseline growth and permits pure shrink", () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "design"));
    expect(writeBaseline(root, tokenEnvelope(root, ["--a"]), { allowGrow: true }).refusedAdditions).toEqual([]);
    expect(writeBaseline(root, tokenEnvelope(root, ["--a", "--b"])).refusedAdditions).toEqual(["token:--b"]);
    expect(writeBaseline(root, tokenEnvelope(root, [])).refusedAdditions).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "design/design-coverage-baseline.json"), "utf8"))).toEqual(emptyBaseline);
  });
});

it("retains a token judgment for each non-excluded source token", async () => {
  const surfaces = scanSurfaces(repoRoot);
  const tokens = await scanTokens(repoRoot);
  const { overrides, errors } = loadOverrides(repoRoot);
  const judgment = judge(surfaces, tokens, scanDocumentedTokens(repoRoot), scanEvidence(repoRoot), overrides);
  expect(errors).toEqual([]);
  expect(judgment.tokenItems.map((item) => item.id)).toEqual(tokens.names.filter((name) => overrides.token.exclude[`token:${name}`] === undefined).map((name) => `token:${name}`));
});
