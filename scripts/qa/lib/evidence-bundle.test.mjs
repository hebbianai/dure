import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createQaEvidenceBundle } from "./evidence-bundle.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qa-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fixture(root, name, contents) {
  const pathname = path.join(root, name);
  fs.writeFileSync(pathname, contents);
  return pathname;
}

function createFailure(root, overrides = {}) {
  return createQaEvidenceBundle({
    result: "failed",
    qaName: "hmux focus smoke",
    exitCode: 7,
    artifactRoot: path.join(root, "artifacts"),
    runId: "test-run",
    now: new Date("2026-07-28T01:02:03.000Z"),
    commitSha: "a".repeat(40),
    treeSha: "b".repeat(40),
    dirty: true,
    startedAtMs: Date.parse("2026-07-28T01:02:00.000Z"),
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("QA failure evidence bundle", () => {
  test("does not create an artifact root for successful runs", () => {
    const root = temporaryDirectory();
    const artifactRoot = path.join(root, "artifacts");

    const result = createQaEvidenceBundle({
      result: "passed",
      qaName: "passing QA",
      artifactRoot,
    });

    expect(result).toBeUndefined();
    expect(fs.existsSync(artifactRoot)).toBe(false);
  });

  test("uses the artifact root environment override", () => {
    const root = temporaryDirectory();
    const artifactRoot = path.join(root, "overridden-artifacts");
    vi.stubEnv("HEBBIAN_QA_ARTIFACT_ROOT", artifactRoot);

    const bundle = createQaEvidenceBundle({
      result: "failed",
      qaName: "environment override",
      exitCode: 1,
      runId: "override-run",
    });

    expect(bundle.runDirectory).toBe(
      path.join(artifactRoot, "override-run"),
    );
    expect(fs.existsSync(path.join(bundle.runDirectory, "manifest.json"))).toBe(
      true,
    );
  });

  test("copies only allowlisted evidence files", () => {
    const root = temporaryDirectory();
    const sources = {
      "tauri-dev.log": fixture(root, "app-source.log", "app output\n"),
      "client.log": fixture(root, "client-source.log", "client output\n"),
      "last-status.json": fixture(root, "status-source.json", '{"ok":false}'),
      "server.json": fixture(root, "server.json", '{"token":"do-not-copy"}'),
      home: fixture(root, "home.txt", "do-not-copy"),
      discovery: fixture(root, "discovery.txt", "do-not-copy"),
    };

    const bundle = createFailure(root, { sources });

    expect(fs.readdirSync(bundle.runDirectory).sort()).toEqual([
      "client.log",
      "last-status.json",
      "manifest.json",
      "tauri-dev.log",
    ]);
  });

  test("redacts credentials, sensitive fields, and isolated paths", () => {
    const root = temporaryDirectory();
    const stateRoot = "/private/tmp/hebbian-app-e2e.random";
    const developerHome = "/Users/fixture";
    const sources = {
      "tauri-dev.log": fixture(
        root,
        "app.log",
        [
          `state=${stateRoot}/home`,
          `toolchain=${developerHome}/.cargo`,
          "Authorization: Bearer bearer-secret",
          "Authorization: Basic dXNlcjpwYXNzd29yZA==",
          '{"token":"json-secret","password": unquoted password with spaces}',
          "OPENAI_API_KEY=provider-secret",
          "SERVICE_TOKEN=unquoted secret with spaces",
        ].join("\n"),
      ),
      "client.log": fixture(
        root,
        "client.log",
        [
          'GET /status?proof=query-secret&window=a proof=plain-secret access_token="quoted-secret"',
          "--token cli-secret --proof='quoted-cli-secret'",
          '--access-token="equals-cli-secret"',
        ].join("\n"),
      ),
      "last-status.json": fixture(
        root,
        "status.json",
        JSON.stringify({
          token: "status-token",
          nested: {
            proof: "status-proof",
            apiKey: "status-api-key",
            message: `Bearer nested-secret at ${stateRoot}`,
          },
        }),
      ),
    };

    const bundle = createFailure(root, {
      sources,
      redactions: [
        { value: stateRoot, replacement: "<QA_STATE_ROOT>" },
        { value: developerHome, replacement: "<DEVELOPER_HOME>" },
      ],
    });
    const contents = fs
      .readdirSync(bundle.runDirectory)
      .map((name) =>
        fs.readFileSync(path.join(bundle.runDirectory, name), "utf8"),
      )
      .join("\n");

    for (const secret of [
      "bearer-secret",
      "dXNlcjpwYXNzd29yZA==",
      "json-secret",
      "provider-secret",
      "unquoted secret with spaces",
      "unquoted password with spaces",
      "query-secret",
      "plain-secret",
      "quoted-secret",
      "cli-secret",
      "quoted-cli-secret",
      "equals-cli-secret",
      "status-token",
      "status-proof",
      "status-api-key",
      "nested-secret",
      stateRoot,
      developerHome,
    ]) {
      expect(contents).not.toContain(secret);
    }
    expect(contents).toContain("[REDACTED]");
    expect(contents).toContain("<QA_STATE_ROOT>");
    expect(contents).toContain("<DEVELOPER_HOME>");
  });

  test("bounds retained log bytes and records truncation", () => {
    const root = temporaryDirectory();
    const source = fixture(
      root,
      "large.log",
      Array.from(
        { length: 100 },
        (_, index) => `line-${index}-${"x".repeat(40)}`,
      ).join("\n"),
    );

    const bundle = createFailure(root, {
      maxLogBytes: 128,
      sources: {
        "tauri-dev.log": source,
        "client.log": source,
      },
    });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(bundle.runDirectory, "manifest.json"), "utf8"),
    );

    for (const name of ["tauri-dev.log", "client.log"]) {
      expect(
        fs.statSync(path.join(bundle.runDirectory, name)).size,
      ).toBeLessThanOrEqual(128);
      expect(manifest.files.find((file) => file.name === name).truncated).toBe(
        true,
      );
    }
  });

  test("writes a provenance manifest and a safe fallback status", () => {
    const root = temporaryDirectory();

    const bundle = createFailure(root, {
      sources: {
        "tauri-dev.log": fixture(root, "app.log", "failed\n"),
      },
    });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(bundle.runDirectory, "manifest.json"), "utf8"),
    );
    const status = JSON.parse(
      fs.readFileSync(
        path.join(bundle.runDirectory, "last-status.json"),
        "utf8",
      ),
    );

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      runId: "test-run",
      qaName: "hmux focus smoke",
      result: "failed",
      exitCode: 7,
      createdAt: "2026-07-28T01:02:03.000Z",
      durationMs: 3_000,
      revision: {
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        dirty: true,
      },
    });
    expect(manifest.files.map((file) => file.name)).toEqual([
      "tauri-dev.log",
      "last-status.json",
    ]);
    expect(status).toMatchObject({
      available: false,
      result: "failed",
      exitCode: 7,
      reason: "status-not-recorded",
    });
    expect(JSON.stringify(manifest)).not.toContain(root);
  });

  test("copies only bounded execution classification into the manifest", () => {
    const root = temporaryDirectory();
    const statusSource = fixture(
      root,
      "status.json",
      JSON.stringify({
        ok: false,
        qaExecution: {
          schemaVersion: 1,
          layer: "background",
          phaseDurationsMs: {
            connect: 12,
            background_delivery: 45,
          },
          failureClass: "background_streaming",
        },
      }),
    );

    const bundle = createFailure(root, {
      sources: { "last-status.json": statusSource },
      qaLayer: "exclusive_focus",
      failureClass: "app_execution",
    });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(bundle.runDirectory, "manifest.json"), "utf8"),
    );

    expect(manifest.qaExecution).toEqual({
      schemaVersion: 1,
      layer: "background",
      phaseDurationsMs: {
        connect: 12,
        background_delivery: 45,
      },
      failureClass: "background_streaming",
    });
  });
});
