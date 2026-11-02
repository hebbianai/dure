// `dure run --lead` is one line in cmdRun — the prompt becomes
// leadRunPrompt(goal) — so the contract worth pinning is the brief itself: it
// carries the goal verbatim, it sends the agent to the bundled guide under
// the name the CLI serves it as, it names the worker gate the lead must check
// for, and it leaves an ordinary goal room inside the 16 KiB prompt the
// backend accepts. The CLI-level checks here never reach a backend: help, and
// the refusals that happen before one is selected. The end-to-end check that
// the backend sees the composed prompt (and never the bare goal) sits beside
// the other run receipts in scripts/dure-cli-agent-spawn.test.mjs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LEAD_SKILL_NAME, leadRunPrompt } from "../cli/lib/lead-run-prompt.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "cli", "dure.mjs");
const skillPath = join(repoRoot, "cli", "skills", LEAD_SKILL_NAME, "SKILL.md");
// validPromptHint in cli/lib/agent-spawn-query.mjs.
const RUN_PROMPT_LIMIT_BYTES = 16 * 1024;

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Runs the CLI with a disposable home and no backend profiles, so any
 *  command that gets past argument validation fails loudly instead of
 *  touching the developer's real state. */
function isolatedCli(args) {
  const root = mkdtempSync(join(tmpdir(), "dure-lead-run-"));
  roots.push(root);
  const env = scriptTestEnvironment({
    HOME: root,
    DURE_HOME: join(root, "dure-home"),
    HMUX_DISCOVERY_ROOT: join(root, "discovery"),
    DURE_APP_CHANNEL: "stable",
  });
  return { ...spawnSync(process.execPath, [cliPath, ...args], { cwd: root, encoding: "utf8", env }), env };
}

describe("leadRunPrompt", () => {
  it("carries the goal verbatim after the brief", () => {
    const goal = "Close the three open onboarding issues.\nCap: 2 workers.";
    const prompt = leadRunPrompt(goal);
    expect(prompt.endsWith(`Goal:\n${goal}`)).toBe(true);
    expect(prompt.indexOf(goal)).toBeGreaterThan(0);
  });

  it("trims only the goal's surrounding whitespace", () => {
    expect(leadRunPrompt("  ship it \n")).toBe(leadRunPrompt("ship it"));
    expect(leadRunPrompt("a  b")).toContain("a  b");
  });

  it("sends the agent to a guide the CLI actually ships, by its served name", () => {
    expect(leadRunPrompt("goal")).toContain(`dure skills get ${LEAD_SKILL_NAME}`);
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toMatch(new RegExp(`^name:\\s*${LEAD_SKILL_NAME}\\s*$`, "m"));
  });

  it("names the not-started gate and the escalation label the guide relies on", () => {
    const prompt = leadRunPrompt("goal");
    for (const marker of ["prompt_delivery_uncertain", "startup_gate", "input_required", "needs:founder"]) {
      expect(prompt).toContain(marker);
    }
    expect(prompt).toContain("do not implement work items yourself");
  });

  it("ends the Run on the tracking issue, not with a summary in the session", () => {
    const prompt = leadRunPrompt("goal");
    for (const marker of ["tracking comment", "tracking issue", "gh issue comment", "same turn"]) {
      expect(prompt).toContain(marker);
    }
  });

  it("leaves an ordinary goal room inside the run prompt limit", () => {
    const briefBytes = Buffer.byteLength(leadRunPrompt("x"), "utf8") - 1;
    expect(briefBytes).toBeLessThan(2048);
    expect(Buffer.byteLength(leadRunPrompt("g".repeat(8 * 1024)), "utf8")).toBeLessThanOrEqual(RUN_PROMPT_LIMIT_BYTES);
  });

  it.each(["", "   ", "\n\t", undefined, 42])("refuses a blank or non-string goal %j", (goal) => {
    expect(() => leadRunPrompt(goal)).toThrow(/goal/);
  });
});

/** The text of one numbered section of the lead guide, from its `## <n>.`
 *  heading up to the next numbered one (fenced examples inside a section,
 *  such as the report template, carry their own `## ` lines). */
function guideSection(number) {
  const guide = readFileSync(skillPath, "utf8");
  const start = guide.indexOf(`\n## ${number}. `);
  expect(start, `section ${number} of the lead guide`).toBeGreaterThan(-1);
  const end = guide.indexOf(`\n## ${number + 1}. `, start);
  return guide.slice(start, end === -1 ? undefined : end);
}

describe("the lead guide closes out on the tracking issue", () => {
  it("keeps the tracking comment's id so it can be edited in place", () => {
    const split = guideSection(2);
    expect(split).toContain("gh issue comment TRACKING --repo OWNER/REPO --body-file plan.md");
    expect(split).toContain("gh api -X PATCH repos/OWNER/REPO/issues/comments/COMMENT_ID -F body=@plan.md");
  });

  it("hands the end of the loop straight to the closing steps", () => {
    const loop = guideSection(4);
    expect(loop).toContain("closing steps in §6");
    expect(loop).toContain("same turn");
  });

  it("re-checks GitHub, edits the tracking comment, then posts the report, in that order", () => {
    const close = guideSection(6);
    const order = [
      "gh pr list --repo OWNER/REPO --head agent/work-",
      "gh api -X PATCH repos/OWNER/REPO/issues/comments/COMMENT_ID -F body=@plan.md",
      "gh issue comment TRACKING --repo OWNER/REPO --body-file report.md",
    ].map((step) => close.indexOf(step));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("dure run --lead", () => {
  it("documents --lead in run help without selecting a backend", () => {
    const result = isolatedCli(["run", "--help"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("[--lead]");
    expect(result.stdout).toContain(`dure skills get ${LEAD_SKILL_NAME}`);
    expect(existsSync(result.env.DURE_HOME)).toBe(false);
  });

  it("refuses --lead without a goal before selecting a backend", () => {
    const result = isolatedCli(["run", "--lead", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("dure run");
    expect(result.stderr).toContain("--lead");
    expect(existsSync(join(result.env.DURE_HOME, "backend-profiles.json"))).toBe(false);
  });

  it.each([
    ["spawn", "--lead", "close the open issues"],
    ["spawn", "--lead", "--prompt", "close the open issues"],
  ])("refuses --lead on the legacy spawn entry point: %s %s %s", (...args) => {
    const result = isolatedCli(args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("dure run");
    expect(existsSync(join(result.env.DURE_HOME, "backend-profiles.json"))).toBe(false);
  });
});
