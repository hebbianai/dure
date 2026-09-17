import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(".");
const selector = path.join(
  repositoryRoot,
  "scripts/qa/select-hmux-release-artifact.sh",
);
const sourceCommit = "a".repeat(40);
const runId = 30520450804;
const runAttempt = 1;
const candidateName = `hmux-linux-musl-${runId}-${runAttempt}-${sourceCommit}`;
const evidenceName = `hmux-linux-native-evidence-${runId}-${runAttempt}-${sourceCommit}`;
const temporaryDirectories = [];

function artifact(name, overrides = {}) {
  return {
    id: name === candidateName ? 8750559857 : 8750554519,
    name,
    size_in_bytes: name === candidateName ? 7_132_161 : 4_835,
    digest: `sha256:${name === candidateName ? "b" : "c"}`.padEnd(71, "0"),
    expired: false,
    workflow_run: {
      id: runId,
      head_sha: sourceCommit,
    },
    ...overrides,
  };
}

function select(artifacts, totalCount = artifacts.length) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hmux-release-artifact-selection-"),
  );
  temporaryDirectories.push(directory);
  const input = path.join(directory, "artifacts.json");
  fs.writeFileSync(
    input,
    `${JSON.stringify({ total_count: totalCount, artifacts })}\n`,
  );
  return spawnSync(
    "sh",
    [selector, input, sourceCommit, String(runId), String(runAttempt)],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 5_000,
    },
  );
}

function selectWithIdentity(source, run, attempt) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hmux-release-artifact-identity-"),
  );
  temporaryDirectories.push(directory);
  const input = path.join(directory, "artifacts.json");
  fs.writeFileSync(input, '{"total_count":0,"artifacts":[]}\n');
  return spawnSync("sh", [selector, input, source, run, attempt], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 5_000,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Hmux release artifact selection", () => {
  test("selects the exact candidate beside native evidence", () => {
    const result = select([artifact(candidateName), artifact(evidenceName)]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: 8750559857,
      name: candidateName,
      workflow_run: {
        id: runId,
        head_sha: sourceCommit,
      },
    });
  });

  test("accepts an exact historical candidate without native evidence", () => {
    const result = select([artifact(candidateName)]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).name).toBe(candidateName);
  });

  test.each([
    ["duplicate candidate", [artifact(candidateName), artifact(candidateName)]],
    [
      "unexpected artifact",
      [artifact(candidateName), artifact("hmux-linux-release-surprise")],
    ],
    [
      "wrong candidate run",
      [
        artifact(candidateName, {
          workflow_run: { id: runId + 1, head_sha: sourceCommit },
        }),
      ],
    ],
    [
      "wrong evidence source",
      [
        artifact(candidateName),
        artifact(evidenceName, {
          workflow_run: { id: runId, head_sha: "d".repeat(40) },
        }),
      ],
    ],
    [
      "expired candidate",
      [artifact(candidateName, { expired: true })],
    ],
    [
      "oversize candidate",
      [artifact(candidateName, { size_in_bytes: 268_435_457 })],
    ],
    [
      "fractional candidate id",
      [artifact(candidateName, { id: 8_750_559_857.5 })],
    ],
    [
      "fractional candidate size",
      [artifact(candidateName, { size_in_bytes: 7_132_161.5 })],
    ],
    [
      "fractional evidence id",
      [
        artifact(candidateName),
        artifact(evidenceName, { id: 8_750_554_519.5 }),
      ],
    ],
    [
      "fractional evidence size",
      [
        artifact(candidateName),
        artifact(evidenceName, { size_in_bytes: 4_835.5 }),
      ],
    ],
    [
      "missing digest",
      [artifact(candidateName, { digest: null })],
    ],
  ])("rejects %s", (_label, artifacts) => {
    const result = select(artifacts);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  test("rejects a truncated or paginated artifact response", () => {
    const result = select([artifact(candidateName)], 2);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  test.each([
    ["short source", "abc", String(runId), String(runAttempt)],
    ["uppercase source", "A".repeat(40), String(runId), String(runAttempt)],
    ["zero run", sourceCommit, "0", String(runAttempt)],
    ["leading-zero run", sourceCommit, "01", String(runAttempt)],
    ["non-numeric attempt", sourceCommit, String(runId), "1x"],
  ])("rejects %s before selection", (_label, source, run, attempt) => {
    const result = selectWithIdentity(source, run, attempt);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
  });
});
