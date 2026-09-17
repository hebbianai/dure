// Real-repo scans: the denominator must reflect the live tree.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCssColor } from "./color.ts";
import { scanSurfaces } from "./surface-scanner.ts";
import { scanDocumentedTokens, scanRuntimeTokenNames, scanTokens } from "./token-scanner.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("surface scanner", () => {
  const scan = scanSurfaces(repoRoot);

  it("enumerates the component tree", () => {
    expect(scan.candidates.length).toBeGreaterThan(100);
    const ids = scan.candidates.map((c) => c.id);
    expect(ids).toContain("surface:spaces/SpacesPane");
    expect(ids).toContain("surface:sidebar/Sidebar");
  });

  it("classifies clusters from the folder layout", () => {
    const spaces = scan.candidates.find((c) => c.id === "surface:spaces/SpacesPane");
    expect(spaces?.cluster).toBe("spaces");
    expect(spaces?.file.startsWith("src/components/spaces/")).toBe(true);
  });

  it("matches the dialog-primitive anchor", () => {
    expect(scan.anchorMatches["dialog-primitive"]).toBeGreaterThan(5);
  });

  it("inventories exported class components (error boundaries)", () => {
    expect(scan.candidates.map((c) => c.id)).toContain("surface:root/AppErrorBoundary");
  });

  it("tags settings pages via the SettingsDialog registry anchor", () => {
    expect(scan.anchorMatches["settings-page-registry"]).toBeGreaterThan(5);
  });

  it("reports no unresolved id collisions", () => {
    expect(scan.errors.filter((e) => e.code === "id-collision")).toEqual([]);
  });
});

describe("token scanner", () => {
  it("attributes scopes across duplicate blocks", async () => {
    const tokens = await scanTokens(repoRoot);
    expect(tokens.declarations.length).toBeGreaterThan(200);
    expect(tokens.names.length).toBeGreaterThan(150);
    const statusError = tokens.declarations.filter((d) => d.name === "--status-error");
    expect(statusError.some((d) => d.scope === "root")).toBe(true);
    const themeInline = tokens.declarations.filter((d) => d.scope === "theme-inline");
    expect(themeInline.length).toBeGreaterThan(50);
  });

  it("enumerates runtime token names from the theme module as data", () => {
    const names = scanRuntimeTokenNames(repoRoot);
    expect(Array.isArray(names)).toBe(true);
  });

  it("reads the DESIGN.md token table rows as name + light + dark spans", () => {
    const documented = scanDocumentedTokens(repoRoot);
    expect(documented.length).toBeGreaterThan(10);
    const foreground = documented.find((d) => d.name === "--foreground");
    // Shape only — the concrete values live in DESIGN.md and drift is the
    // judge's business, not this reader's.
    expect(typeof foreground?.light).toBe("string");
    expect(parseCssColor(foreground?.light ?? "")).not.toBeNull();
  });
});
