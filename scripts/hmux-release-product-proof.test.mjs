import { describe, expect, test } from "vitest";
import {
  createHmuxReleaseProductProof,
  exactHmuxReleaseCiProofWaitOptions,
  HMUX_RELEASE_PRODUCT_PROOF_SCHEMA,
} from "./hmux-release-product-proof.mjs";

const BASE = "a".repeat(40);
const SOURCE = "b".repeat(40);

function commandResult(status, stdout = "", stderr = "") {
  return { error: undefined, status, stderr, stdout };
}

function globalCiRunListArgs(repository = "hebbianai/dure-internal") {
  return [
    "run",
    "list",
    "--repo",
    repository,
    "--workflow",
    "CI",
    "--event",
    "push",
    "--branch",
    "main",
    "--limit",
    "100",
    "--json",
    "databaseId,headSha,status,conclusion,url",
  ];
}

function exactRecord(overrides = {}) {
  return {
    databaseId: 42,
    headSha: SOURCE,
    relationship: "exact",
    requiredScopes: ["hmux-core"],
    targetSha: SOURCE,
    verificationScopes: ["hmux-core"],
    verifiedBase: BASE,
    ...overrides,
  };
}

describe("Hmux release CI product proof", () => {
  test("seals an exact green CI result into a bounded release proof", () => {
    expect(createHmuxReleaseProductProof(exactRecord())).toEqual({
      ciRunId: "42",
      requiredScopes: ["hmux-core"],
      schema: HMUX_RELEASE_PRODUCT_PROOF_SCHEMA,
      sourceCommit: SOURCE,
      verificationScopes: ["hmux-core"],
      verifiedBase: BASE,
      verifiedHead: SOURCE,
    });
  });

  test("rejects a stale descendant result", () => {
    expect(() =>
      createHmuxReleaseProductProof(
        exactRecord({
          headSha: "c".repeat(40),
          relationship: "descendant",
        }),
      ),
    ).toThrow("exact-SHA CI run");
  });

  test("rejects incomplete, malformed, and non-canonical scope evidence", () => {
    expect(() =>
      createHmuxReleaseProductProof(
        exactRecord({ verificationScopes: ["frontend"] }),
      ),
    ).toThrow("does not cover");
    expect(() =>
      createHmuxReleaseProductProof(exactRecord({ databaseId: "0" })),
    ).toThrow("positive CI run id");
    expect(() =>
      createHmuxReleaseProductProof(
        exactRecord({ verificationScopes: ["hmux-core", "frontend"] }),
      ),
    ).toThrow("must be canonical");
  });

  test("queries exact push CI beyond the global recent window", () => {
    const calls = [];
    const exactRuns = [
      {
        conclusion: "success",
        databaseId: 30853593016,
        headSha: SOURCE,
        status: "completed",
        url: "https://example.invalid/exact",
      },
    ];
    const run = (command, args) => {
      calls.push([command, args]);
      if (command === "gh" && args[0] === "run") {
        return commandResult(0, JSON.stringify(exactRuns));
      }
      if (command === "gh" && args[0] === "api") {
        return commandResult(
          0,
          JSON.stringify({
            artifacts: [
              {
                expired: false,
                id: 8955865348,
                workflow_run: { head_sha: SOURCE, id: 30853593016 },
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const options = exactHmuxReleaseCiProofWaitOptions(
      SOURCE,
      "hebbianai/dure-internal",
      run,
    );

    expect(options.run("gh", globalCiRunListArgs())).toEqual(
      commandResult(0, JSON.stringify(exactRuns)),
    );
    expect(calls[0][1]).toEqual(
      expect.arrayContaining(["--commit", SOURCE, "--limit", "20"]),
    );
    expect(options.listProductReceipts()).toEqual([
      expect.objectContaining({
        artifactId: "8955865348",
        databaseId: "30853593016",
        headSha: SOURCE,
      }),
    ]);
    expect(calls[1][1][1]).toContain(
      "/actions/runs/30853593016/artifacts?",
    );
  });

  test("bounds exact receipt lookups and ignores descendant runs", () => {
    const calls = [];
    const exactRuns = Array.from({ length: 10 }, (_, index) => ({
      conclusion: "success",
      databaseId: index + 1,
      headSha: SOURCE,
      status: "completed",
    }));
    exactRuns.unshift({
      conclusion: "success",
      databaseId: 99,
      headSha: "c".repeat(40),
      status: "completed",
    });
    const run = (command, args) => {
      calls.push([command, args]);
      if (command === "gh" && args[0] === "run") {
        return commandResult(0, JSON.stringify(exactRuns));
      }
      if (command === "gh" && args[0] === "api") {
        return commandResult(0, JSON.stringify({ artifacts: [] }));
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const options = exactHmuxReleaseCiProofWaitOptions(
      SOURCE,
      "hebbianai/dure-internal",
      run,
    );

    options.run("gh", globalCiRunListArgs());
    expect(options.listProductReceipts()).toEqual([]);
    const artifactCalls = calls.filter(
      ([command, args]) => command === "gh" && args[0] === "api",
    );
    expect(artifactCalls).toHaveLength(8);
    expect(
      artifactCalls.some(([, args]) => args[1].includes("/runs/99/")),
    ).toBe(false);
  });

  test("fails closed if the shared waiter changes its run-list contract", () => {
    const run = () => {
      throw new Error("unexpected delegated command");
    };
    const options = exactHmuxReleaseCiProofWaitOptions(
      SOURCE,
      "hebbianai/dure-internal",
      run,
    );
    const incompatibleArgs = globalCiRunListArgs();
    incompatibleArgs[incompatibleArgs.indexOf("100")] = "50";

    expect(options.run("gh", incompatibleArgs)).toEqual(
      expect.objectContaining({
        status: 1,
        stderr: expect.stringContaining("unexpected CI run-list command"),
      }),
    );
  });
});
