import { describe, expect, it } from "vitest";
import { buildDashboardHtml } from "./dashboard.ts";
import { check } from "./envelope.ts";
import { BASELINE_SCHEMA_VERSION, ENVELOPE_SCHEMA_VERSION, type Envelope } from "./types.ts";

const envelope: Envelope = {
  schemaVersion: ENVELOPE_SCHEMA_VERSION,
  generatedAt: "2026-08-06T00:00:00.000Z",
  sourceCommit: "abcdef1234567890",
  dirty: false,
  axes: { token: { items: [{
    id: "token:--x", axis: "token", verdict: "uncovered", evidence: [],
    detail: { drift: "documented light `#111` != defined `#222`" },
  }] } },
  surfaces: [{
    id: "surface:spaces/SpacesPane", cluster: "spaces", name: "SpacesPane",
    file: "src/components/spaces/SpacesPane.tsx", anchors: [], surfaceKind: "pane",
  }],
  mockups: [{
    path: "design/mockups/spaces/SpacesPane/default.html", surfaceLocalId: "spaces/SpacesPane",
    state: "ideal", vars: [],
  }],
  aliases: {},
  anchors: { "dialog-primitive": 3, "dead-anchor": 0 },
  excluded: [{ id: "surface:x/Shim", reason: "loader shim <test>" }],
  errors: [{ code: "orphan-evidence", message: "mockup references a missing source <bad>" }],
  tokensDtcg: {},
  rawColors: { total: 5, files: {}, stale: [{ file: "a.tsx", allowed: 3, actual: 1 }] },
};
const baseline = { schemaVersion: BASELINE_SCHEMA_VERSION, uncovered: ["token:--gone"] };

describe("buildDashboardHtml", () => {
  const html = buildDashboardHtml(envelope, check(envelope, baseline, []), [
    { path: envelope.mockups[0].path, mtimeMs: 1754400000000 },
  ]);

  it("reports actual source paths and optional mockup timestamps", () => {
    expect(html).toContain("surface:spaces/SpacesPane");
    expect(html).toContain("src/components/spaces/SpacesPane.tsx");
    expect(html).toContain(envelope.mockups[0].path);
    expect(html).toContain("2025-08-05");
  });

  it("reports token drift, raw colors, exclusions and stale baseline entries", () => {
    expect(html).toContain("token:--x");
    expect(html).toContain("documented light `#111` != defined `#222`");
    expect(html).toContain("raw color 5");
    expect(html).toContain("surface:x/Shim");
    expect(html).toContain("dead-anchor");
    expect(html).toContain("베이스라인 축소 가능 (1)");
  });

  it("escapes diagnostics and includes baseline errors from the actual check", () => {
    const errors = [{ code: "invalid-baseline" as const, message: "unsupported baseline <version>" }];
    const report = buildDashboardHtml(envelope, check(envelope, baseline, errors), []);
    expect(report).not.toContain("<bad>");
    expect(report).toContain("&lt;bad&gt;");
    expect(report).not.toContain("<test>");
    expect(report).toContain("unsupported baseline &lt;version&gt;");
  });
});
