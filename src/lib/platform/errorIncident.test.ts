import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildErrorReportBundle,
  createErrorIncident,
  currentErrorReportAppMetadata,
  redactErrorReportText,
  serializeErrorReportBundle,
} from "@/lib/platform/errorIncident";

const app = {
  frontendBuildId: "0.1.4+abc123",
  channel: "dev-error-report",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("error report app channel", () => {
  it("prefers the canonical Vite channel over the legacy compatibility input", () => {
    vi.stubEnv("VITE_DURE_APP_CHANNEL", "dev-canonical-a1b2c3d4");
    vi.stubEnv("VITE_HEBBIAN_APP_CHANNEL", "dev-legacy-decoy-a1b2c3d4");

    expect(currentErrorReportAppMetadata().channel).toBe(
      "dev-canonical-a1b2c3d4",
    );
  });
});

describe("error report redaction", () => {
  it("removes full paths while retaining the source basename and position", () => {
    const source = [
      "at render (/Users/jay/private/HebbianIDE/src/App.tsx:41:9)",
      "at win (C:\\Users\\jay\\secret\\Window.tsx:12:4)",
      "at home (~/projects/private/main.ts:7:2)",
    ].join("\n");

    const redacted = redactErrorReportText(source);

    expect(redacted).toContain("[path]/App.tsx:41:9");
    expect(redacted).toContain("[path]\\Window.tsx:12:4");
    expect(redacted).toContain("[path]/main.ts:7:2");
    expect(redacted).not.toContain("/Users/jay");
    expect(redacted).not.toContain("C:\\Users\\jay");
    expect(redacted).not.toContain("~/projects");
  });

  it("removes credentials, environment values, email, and URL authority/query", () => {
    const source =
      'token="secret-value" Authorization=Bearer_abc PATH=/private/bin ' +
      "Bearer abc.def.ghi user@example.com " +
      "https://errors.example.test/project?access_token=secret " +
      "http://localhost:1420/src/App.tsx?token=secret";

    const redacted = redactErrorReportText(source);

    expect(redacted).toContain('token="[redacted]"');
    expect(redacted).toContain('Authorization="[redacted]"');
    expect(redacted).toContain("PATH=[redacted]");
    expect(redacted).toContain("[email]");
    expect(redacted).toContain("[url]");
    expect(redacted).toContain("app://src/App.tsx");
    expect(redacted).not.toContain("secret-value");
    expect(redacted).not.toContain("errors.example.test");
    expect(redacted).not.toContain("access_token");
  });

  it("bounds attacker-controlled exception text after redaction", () => {
    expect(redactErrorReportText("x".repeat(100), 24)).toBe(
      `${"x".repeat(24)}\n…[truncated]`,
    );
  });
});

describe("error report bundle", () => {
  it("creates a deterministic fingerprint across line-number changes", () => {
    const first = buildErrorReportBundle(
      createErrorIncident({
        boundary: "diff-window",
        surface: "diff-window",
        error: Object.assign(new Error("render failed"), {
          stack: "Error: render failed\n at Diff (/Users/a/Diff.tsx:10:2)",
        }),
        occurredAt: "2026-07-29T10:00:00Z",
      }),
      { app, createdAt: "2026-07-29T10:01:00Z" },
    );
    const second = buildErrorReportBundle(
      createErrorIncident({
        boundary: "diff-window",
        surface: "diff-window",
        error: Object.assign(new Error("render failed"), {
          stack: "Error: render failed\n at Diff (/Users/b/Diff.tsx:99:17)",
        }),
        occurredAt: "2026-07-29T10:05:00Z",
      }),
      { app, createdAt: "2026-07-29T10:06:00Z" },
    );

    expect(first.incident.fingerprint).toBe(second.incident.fingerprint);
    expect(first.incident.surface).toBe("diff-window");
  });

  it("serializes only the redacted, reviewable v1 contract", () => {
    const report = buildErrorReportBundle(
      createErrorIncident({
        boundary: "app",
        surface: "main",
        error: new Error("failed in /Users/jay/secret/project.ts"),
        componentStack: "\n at Project (/Users/jay/secret/Project.tsx:5:1)",
        diagnostics: [
          {
            kind: "hmux_connection",
            code: "stale_transport",
            reference: "receipt-123",
          },
        ],
        occurredAt: "2026-07-29T10:00:00Z",
      }),
      {
        app,
        createdAt: "2026-07-29T10:01:00Z",
        notes: "재현 경로 /Users/jay/repo/private.md token=hidden",
      },
    );
    const serialized = serializeErrorReportBundle(report);

    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: "dure.error-report",
      app,
      incident: {
        boundary: "app",
        surface: "main",
      },
      diagnostics: [
        {
          kind: "hmux_connection",
          code: "stale_transport",
          reference: "receipt-123",
        },
      ],
      privacy: {
        redactionVersion: 1,
      },
    });
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized).toContain("[path]/project.ts");
    expect(serialized).toContain('token=\\"[redacted]\\"');
    expect(serialized).not.toContain("/Users/jay");
    expect(serialized).not.toContain("hidden");
  });
});
