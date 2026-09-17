import { describe, expect, test, vi } from "vitest";
import {
  ALL_VERIFICATION_SCOPES,
  createVerificationReceipt,
  LEGACY_CI_VERIFICATION_SCHEMA,
} from "./lib/ci-verification-receipt.mjs";
import {
  waitForExactGreenCiProductProof,
  waitForGreenCi,
} from "./lib/wait-ci-green.mjs";

const BASE = "d".repeat(40);
const TARGET = "a".repeat(40);
const DESCENDANT = "b".repeat(40);
const UNRELATED = "c".repeat(40);

function commandResult(status, stdout = "", stderr = "") {
  return { status, stderr, stdout };
}

function fakeCommands(
  runSnapshots,
  {
    artifactRecords = [],
    candidatesOnMain = true,
    directReceipt,
    diffTreeFails = false,
    targetOnMain = true,
    targetPaths = ["src-tauri/src/lib.rs"],
  } = {},
) {
  let listCalls = 0;
  const ancestryChecks = [];
  const run = vi.fn((command, args) => {
    if (command === "git" && args[0] === "rev-parse") {
      return commandResult(
        0,
        `${args[2] === "origin/main^{commit}" ? DESCENDANT : TARGET}\n`,
      );
    }
    if (command === "git" && args[0] === "diff-tree") {
      if (diffTreeFails) {
        return commandResult(1, "", "diff failed");
      }
      const output =
        targetPaths.length === 0 ? "" : `${targetPaths.join("\0")}\0`;
      return commandResult(0, output);
    }
    if (command === "git" && args[0] === "diff") {
      const output =
        targetPaths.length === 0 ? "" : `${targetPaths.join("\0")}\0`;
      return commandResult(0, output);
    }
    if (command === "git" && args[0] === "fetch") {
      return commandResult(0);
    }
    if (
      command === "git" &&
      args[0] === "merge-base" &&
      args[3] === "origin/main"
    ) {
      return commandResult(
        (args[2] === TARGET ? targetOnMain : candidatesOnMain) ? 0 : 1,
      );
    }
    if (command === "gh" && args[0] === "run" && args[1] === "list") {
      const snapshot =
        runSnapshots[Math.min(listCalls, runSnapshots.length - 1)];
      listCalls += 1;
      return commandResult(0, JSON.stringify(snapshot));
    }
    if (command === "gh" && args[0] === "api") {
      if (args[1].includes("/actions/artifacts?")) {
        return commandResult(0, JSON.stringify({ artifacts: artifactRecords }));
      }
      if (/\/actions\/artifacts\/[1-9][0-9]*\/zip$/.test(args[1])) {
        return commandResult(0, Buffer.from("receipt archive"));
      }
    }
    if (command === "unzip" && directReceipt) {
      return commandResult(0, JSON.stringify(directReceipt));
    }
    if (command === "git" && args[0] === "cat-file") {
      return commandResult(0);
    }
    if (command === "git" && args[0] === "merge-base") {
      const ancestor = args[2];
      const candidate = args[3];
      if (ancestor === TARGET) {
        ancestryChecks.push(candidate);
      }
      return commandResult(
        ancestor === candidate ||
          (ancestor === TARGET && candidate === DESCENDANT) ||
          (ancestor === BASE &&
            (candidate === TARGET || candidate === DESCENDANT))
          ? 0
          : 1,
      );
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  });
  return { ancestryChecks, run };
}

function ciRun(headSha, conclusion, databaseId) {
  return {
    conclusion,
    databaseId,
    headSha,
    status: "completed",
    url: `https://example.test/runs/${databaseId}`,
  };
}

function pendingCiRun(headSha, databaseId) {
  return {
    conclusion: null,
    databaseId,
    headSha,
    status: "in_progress",
    url: `https://example.test/runs/${databaseId}`,
  };
}

function receiptLoader(scopes = {}) {
  return vi.fn(async (record) => {
    if (record.conclusion !== "success") {
      return null;
    }
    return createVerificationReceipt({
      runId: record.databaseId,
      scopes: scopes[record.databaseId] ?? ALL_VERIFICATION_SCOPES,
      verifiedBase: BASE,
      verifiedHead: record.headSha,
    });
  });
}

function legacyFullReceipt(record) {
  return {
    runId: String(record.databaseId),
    schema: LEGACY_CI_VERIFICATION_SCHEMA,
    scope: "full",
    verifiedBase: BASE,
    verifiedHead: record.headSha,
  };
}

describe("main CI green descendant waiter", () => {
  test("accepts an exact successful run without a descendant proof", async () => {
    const fixture = fakeCommands([[ciRun(TARGET, "success", 7)]]);

    const result = await waitForGreenCi(TARGET, {
      delay: vi.fn(),
      loadReceipt: receiptLoader(),
      maxPolls: 1,
      pollIntervalMs: 0,
      run: fixture.run,
    });

    expect(result).toMatchObject({
      databaseId: 7,
      headSha: TARGET,
      requiredScopes: ["desktop"],
      verificationScopes: ALL_VERIFICATION_SCOPES,
    });
    expect(fixture.ancestryChecks).toEqual([DESCENDANT]);
  });

  test("accepts a green descendant only after git proves ancestry", async () => {
    const fixture = fakeCommands([
      [
        ciRun(TARGET, "cancelled", 8),
        ciRun(UNRELATED, "success", 9),
        ciRun(DESCENDANT, "success", 10),
      ],
    ]);

    const result = await waitForGreenCi(TARGET, {
      delay: vi.fn(),
      loadReceipt: receiptLoader(),
      maxPolls: 1,
      pollIntervalMs: 0,
      run: fixture.run,
    });

    expect(result).toMatchObject({ databaseId: 10, headSha: DESCENDANT });
    expect(fixture.ancestryChecks).toEqual([DESCENDANT]);
  });

  test("release proof refuses a green descendant for an untested artifact tree", async () => {
    const fixture = fakeCommands([[ciRun(DESCENDANT, "success", 10)]]);

    await expect(
      waitForExactGreenCiProductProof(TARGET, {
        delay: vi.fn(),
        loadReceipt: receiptLoader(),
        maxPolls: 1,
        pollIntervalMs: 0,
        run: fixture.run,
      }),
    ).rejects.toThrow(/no CI run covering \["desktop"\] containing/);
    expect(fixture.ancestryChecks).toEqual([]);
  });

  test("release proof accepts only a valid green exact-SHA receipt", async () => {
    const fixture = fakeCommands([[ciRun(TARGET, "success", 7)]]);

    const result = await waitForExactGreenCiProductProof(TARGET, {
      delay: vi.fn(),
      loadReceipt: receiptLoader(),
      maxPolls: 1,
      pollIntervalMs: 0,
      run: fixture.run,
    });

    expect(result).toMatchObject({
      databaseId: 7,
      headSha: TARGET,
      relationship: "exact",
      targetSha: TARGET,
    });
    const listArgs = fixture.run.mock.calls.find(
      ([command, args]) =>
        command === "gh" && args[0] === "run" && args[1] === "list",
    )[1];
    expect(listArgs).toEqual(expect.arrayContaining(["--event", "push"]));
    expect(
      fixture.run.mock.calls.some(
        ([command, args]) => command === "git" && args[0] === "fetch",
      ),
    ).toBe(false);
  });

  test("release proof downloads only the exact run's listed artifact", async () => {
    const expected = createVerificationReceipt({
      runId: 7,
      scopes: ALL_VERIFICATION_SCOPES,
      verifiedBase: BASE,
      verifiedHead: TARGET,
    });
    const fixture = fakeCommands([[ciRun(TARGET, "success", 7)]], {
      artifactRecords: [
        {
          expired: false,
          id: 99,
          workflow_run: { head_sha: TARGET, id: 7 },
        },
      ],
      directReceipt: expected,
    });

    const result = await waitForExactGreenCiProductProof(TARGET, {
      delay: vi.fn(),
      maxPolls: 1,
      pollIntervalMs: 0,
      run: fixture.run,
    });

    expect(result).toMatchObject({ artifactId: "99", databaseId: 7 });
    expect(
      fixture.run.mock.calls.filter(
        ([command, args]) => command === "gh" && args[0] === "api",
      ),
    ).toEqual([
      [
        "gh",
        [
          "api",
          "repos/hebbianai/HebbianIDE/actions/artifacts?name=ci-product-verification-receipt-v3&per_page=100",
        ],
      ],
      [
        "gh",
        [
          "api",
          "repos/hebbianai/HebbianIDE/actions/artifacts/99/zip",
        ],
        { encoding: "buffer", maxBuffer: 1024 * 1024 },
      ],
    ]);
    expect(
      fixture.run.mock.calls.some(
        ([command, args]) =>
          command === "gh" && args[0] === "run" && args[1] === "download",
      ),
    ).toBe(false);
  });

  test("release proof does not probe artifacts while exact CI is running", async () => {
    const fixture = fakeCommands([
      [pendingCiRun(TARGET, 7), { ...pendingCiRun(UNRELATED, 8), status: null }],
      [pendingCiRun(TARGET, 7), { ...pendingCiRun(UNRELATED, 8), status: null }],
    ]);
    const delay = vi.fn();

    await expect(
      waitForExactGreenCiProductProof(TARGET, {
        delay,
        maxPolls: 2,
        pollIntervalMs: 25,
        run: fixture.run,
      }),
    ).rejects.toThrow(/no CI run covering/);

    expect(delay).toHaveBeenCalledTimes(1);
    expect(
      fixture.run.mock.calls.some(
        ([command, args]) =>
          command === "gh" &&
          (args[0] === "api" ||
            (args[0] === "run" && args[1] === "download")),
      ),
    ).toBe(false);
  });

  test.each([
    ["missing", []],
    [
      "expired",
      [
        {
          expired: true,
          id: 99,
          workflow_run: { head_sha: TARGET, id: 7 },
        },
      ],
    ],
    [
      "malformed",
      [
        {
          expired: false,
          id: "not-an-artifact-id",
          workflow_run: { head_sha: TARGET, id: 7 },
        },
      ],
    ],
    [
      "wrong run",
      [
        {
          expired: false,
          id: 99,
          workflow_run: { head_sha: TARGET, id: 8 },
        },
      ],
    ],
    [
      "wrong head",
      [
        {
          expired: false,
          id: 99,
          workflow_run: { head_sha: UNRELATED, id: 7 },
        },
      ],
    ],
  ])("release proof blocks %s artifact metadata", async (_label, artifacts) => {
    const fixture = fakeCommands([[ciRun(TARGET, "success", 7)]], {
      artifactRecords: artifacts,
    });

    await expect(
      waitForExactGreenCiProductProof(TARGET, {
        delay: vi.fn(),
        maxPolls: 1,
        pollIntervalMs: 0,
        run: fixture.run,
      }),
    ).rejects.toThrow(
      /completed exact CI did not publish valid green product proof/,
    );
    expect(
      fixture.run.mock.calls.some(
        ([command, args]) =>
          command === "gh" &&
          (args[1]?.endsWith("/zip") ||
            (args[0] === "run" && args[1] === "download")),
      ),
    ).toBe(false);
  });

  test("release proof fails immediately when exact CI completed red", async () => {
    const fixture = fakeCommands([[ciRun(TARGET, "failure", 7)]]);
    const delay = vi.fn();

    await expect(
      waitForExactGreenCiProductProof(TARGET, {
        delay,
        loadReceipt: receiptLoader(),
        maxPolls: 4,
        pollIntervalMs: 25,
        run: fixture.run,
      }),
    ).rejects.toThrow(/completed exact CI did not publish valid green product proof/);
    expect(delay).not.toHaveBeenCalled();
  });

  test("release proof fails immediately when green exact CI has malformed evidence", async () => {
    const fixture = fakeCommands([[ciRun(TARGET, "success", 7)]]);
    const delay = vi.fn();

    await expect(
      waitForExactGreenCiProductProof(TARGET, {
        delay,
        loadReceipt: async () => null,
        maxPolls: 4,
        pollIntervalMs: 25,
        run: fixture.run,
      }),
    ).rejects.toThrow(
      /completed exact CI did not publish valid green product proof/,
    );
    expect(delay).not.toHaveBeenCalled();
  });

  test("never substitutes an unrelated green run", async () => {
    const fixture = fakeCommands([
      [ciRun(TARGET, "cancelled", 8), ciRun(UNRELATED, "success", 9)],
    ]);

    await expect(
      waitForGreenCi(TARGET, {
        delay: vi.fn(),
        loadReceipt: receiptLoader(),
        maxPolls: 1,
        pollIntervalMs: 0,
        run: fixture.run,
      }),
    ).rejects.toThrow(/no CI run covering \["desktop"\] containing/);
    expect(fixture.ancestryChecks).toEqual([]);
  });

  test("never accepts a descendant that is absent from current main", async () => {
    const fixture = fakeCommands([[ciRun(DESCENDANT, "success", 10)]], {
      candidatesOnMain: false,
    });

    await expect(
      waitForGreenCi(TARGET, {
        delay: vi.fn(),
        loadReceipt: receiptLoader(),
        maxPolls: 1,
        pollIntervalMs: 0,
        run: fixture.run,
      }),
    ).rejects.toThrow(/no CI run covering \["desktop"\] containing/);
    expect(fixture.ancestryChecks).toEqual([DESCENDANT]);
  });

  test("refuses a target that is no longer on main", async () => {
    const fixture = fakeCommands([[ciRun(TARGET, "success", 7)]], {
      targetOnMain: false,
    });

    await expect(
      waitForGreenCi(TARGET, {
        delay: vi.fn(),
        loadReceipt: receiptLoader(),
        maxPolls: 1,
        pollIntervalMs: 0,
        run: fixture.run,
      }),
    ).rejects.toThrow(/is not an ancestor of origin\/main/);
  });

  test("polls through a cancelled exact run until a descendant is green", async () => {
    const delay = vi.fn();
    const fixture = fakeCommands([
      [ciRun(TARGET, "cancelled", 8)],
      [ciRun(TARGET, "cancelled", 8), ciRun(DESCENDANT, "success", 10)],
    ]);

    const result = await waitForGreenCi(TARGET, {
      delay,
      loadReceipt: receiptLoader(),
      maxPolls: 2,
      pollIntervalMs: 25,
      run: fixture.run,
    });

    expect(result.headSha).toBe(DESCENDANT);
    expect(delay).toHaveBeenCalledWith(25);
  });

  test("rejects a frontend-only descendant for a desktop target", async () => {
    const fixture = fakeCommands([
      [
        ciRun(TARGET, "cancelled", 8),
        ciRun(DESCENDANT, "success", 10),
        ciRun(BASE, "success", 1),
      ],
    ]);

    await expect(
      waitForGreenCi(TARGET, {
        delay: vi.fn(),
        loadReceipt: receiptLoader({ 10: ["frontend"] }),
        maxPolls: 1,
        pollIntervalMs: 0,
        run: fixture.run,
      }),
    ).rejects.toThrow(/no CI run covering \["desktop"\] containing/);
  });

  test("accepts a frontend descendant for a frontend-safe target", async () => {
    const fixture = fakeCommands(
      [
        [
          ciRun(TARGET, "cancelled", 8),
          ciRun(DESCENDANT, "success", 10),
          ciRun(BASE, "success", 1),
        ],
      ],
      { targetPaths: ["src/App.tsx", "docs/architecture/ui.md"] },
    );

    const result = await waitForGreenCi(TARGET, {
      delay: vi.fn(),
      loadReceipt: receiptLoader({ 10: ["frontend"] }),
      maxPolls: 1,
      pollIntervalMs: 0,
      run: fixture.run,
    });

    expect(result).toMatchObject({
      databaseId: 10,
      requiredScopes: ["frontend"],
      verificationScopes: ["frontend"],
    });
  });

  test("rejects a partial receipt whose declared range starts after the target", async () => {
    const fixture = fakeCommands([[ciRun(DESCENDANT, "success", 10)]], {
      targetPaths: ["src/App.tsx"],
    });

    await expect(
      waitForGreenCi(TARGET, {
        delay: vi.fn(),
        loadReceipt: async (record) =>
          createVerificationReceipt({
            runId: record.databaseId,
            scopes: ["frontend"],
            verifiedBase: DESCENDANT,
            verifiedHead: DESCENDANT,
          }),
        maxPolls: 1,
        pollIntervalMs: 0,
        run: fixture.run,
      }),
    ).rejects.toThrow(/no CI run covering \["frontend"\] containing/);
  });

  test("does not accept v1 full evidence for a mobile target", async () => {
    const fixture = fakeCommands([[ciRun(TARGET, "success", 7)]], {
      targetPaths: ["mobile/src/App.tsx"],
    });

    await expect(
      waitForGreenCi(TARGET, {
        delay: vi.fn(),
        loadReceipt: async (record) => legacyFullReceipt(record),
        maxPolls: 1,
        pollIntervalMs: 0,
        run: fixture.run,
      }),
    ).rejects.toThrow(/no CI run covering \["mobile-web"\] containing/);
  });


  test("changed-path errors require an all-scopes receipt", async () => {
    const fixture = fakeCommands([[ciRun(TARGET, "success", 7)]], {
      diffTreeFails: true,
    });

    await expect(
      waitForGreenCi(TARGET, {
        delay: vi.fn(),
        loadReceipt: receiptLoader({ 7: ["desktop"] }),
        maxPolls: 1,
        pollIntervalMs: 0,
        run: fixture.run,
      }),
    ).rejects.toThrow(
      `no CI run covering ${JSON.stringify(ALL_VERIFICATION_SCOPES)} containing`,
    );
  });

  test("receipt load errors are skipped as untrusted evidence", async () => {
    const fixture = fakeCommands([[ciRun(TARGET, "success", 7)]]);

    await expect(
      waitForGreenCi(TARGET, {
        delay: vi.fn(),
        loadReceipt: async () => {
          throw new Error("corrupt artifact");
        },
        maxPolls: 1,
        pollIntervalMs: 0,
        run: fixture.run,
      }),
    ).rejects.toThrow(/no CI run covering \["desktop"\] containing/);
  });
});
