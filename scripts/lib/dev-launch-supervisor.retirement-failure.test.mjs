import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const retirementFailure = vi.hoisted(() => ({
  predecessorPid: null,
  injections: 0,
}));

vi.mock("./process-group-authority.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    async signalOwnedProcessGroup(identity, signal) {
      if (
        retirementFailure.predecessorPid === identity.pid &&
        signal === "SIGTERM"
      ) {
        retirementFailure.predecessorPid = null;
        retirementFailure.injections += 1;
        const error = new Error("fixture exact predecessor retirement failure");
        error.code = "EPERM";
        throw error;
      }
      return actual.signalOwnedProcessGroup(identity, signal);
    },
  };
});

import {
  DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
  RESTART_STATUS_REQUEST_TIMEOUT_MS,
} from "./dev-launch-contract.mjs";
import { requestDevLaunchParentReload } from "./dev-launch-client.mjs";
import { superviseDevLaunch } from "./dev-launch-supervisor.mjs";
import {
  createDevLaunchFixtureRegistry,
  runDevLaunchFixtureCleanup,
  startManagedDevLaunchFixture,
} from "./dev-launch-test-support.mjs";

const fixtureProcesses = createDevLaunchFixtureRegistry();
const fixtures = [];
const temporaryRoots = [];

function startManagedLaunch(options) {
  const fixture = startManagedDevLaunchFixture({
    ...options,
    fixtureProcesses,
    superviseDevLaunch,
  });
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  retirementFailure.predecessorPid = null;
  retirementFailure.injections = 0;
  const activeFixtures = fixtures.splice(0);
  const roots = temporaryRoots.splice(0);
  await runDevLaunchFixtureCleanup([
    ...activeFixtures.map((fixture) => () => fixture.dispose()),
    () => fixtureProcesses.retireAll(),
    ...roots.map((root) => () => rmSync(root, { recursive: true, force: true })),
  ]);
});

it.runIf(process.platform === "darwin" || process.platform === "linux")(
  "does not launch a successor when exact predecessor retirement fails",
  async () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "dure-supervisor-retirement-failure-"),
    );
    temporaryRoots.push(fixtureRoot);
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "managed-child.mjs");
    const launchesFile = join(fixtureRoot, "launches.txt");
    const channel = "dev-supervisor-retirement-failure-1234567890";
    const previousSource = "3".repeat(64);
    const targetSource = "4".repeat(64);
    writeFileSync(
      childScript,
      `import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], String(process.pid) + "\\n");
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
      { mode: 0o600 },
    );
    const reloadParent = vi.fn(() => {
      throw new Error("reload must not run after unproven retirement");
    });
    const fixture = startManagedLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, launchesFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      sourceGeneration: previousSource,
      preflightParent: async () => {},
      reloadParent,
    });
    const predecessor = await fixture.observeDescriptor((descriptor) =>
      descriptor.state === "ready" ? descriptor : null
    );
    await fixture.observeFile(launchesFile, (content) =>
      content.includes(
        `${predecessor.launch.pid}\n`,
      )
    );
    retirementFailure.predecessorPid = predecessor.launch.pid;

    await expect(
      requestDevLaunchParentReload({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration: targetSource,
        timeoutMs: RESTART_STATUS_REQUEST_TIMEOUT_MS,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/retirement was not proven/),
      destructiveBoundaryCrossed: true,
    });
    await expect(fixture.outcome).resolves.toMatchObject({
      code: 1,
      signal: null,
    });

    expect(retirementFailure.injections).toBe(1);
    expect(reloadParent).not.toHaveBeenCalled();
    expect(readFileSync(launchesFile, "utf8").trim().split("\n")).toHaveLength(1);
    expect(fixture.readDescriptor()).toMatchObject({
      state: "handoff",
      launch: null,
      handoff: { previousLaunch: predecessor.launch },
      capabilities: expect.arrayContaining([
        DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
      ]),
      parentReloadFailure: {
        destructiveBoundaryCrossed: true,
        reason: expect.stringMatching(/retirement was not proven/),
      },
    });
  },
);
