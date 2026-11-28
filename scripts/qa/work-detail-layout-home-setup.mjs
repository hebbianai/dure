import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

// The Work detail QA's agents and their provider records, written into the
// disposable HOME before the app starts. The app reads each worker's last
// prompt from its Claude transcript through its own metadata reader, so the
// rows' "Asked" lines are the product's, not the probe's, and an ended
// agent's conversation through its own transcript reader.

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const home = realpathSync(required("HOME"));
if (home !== realpathSync(path.join(required("DURE_QA_STATE_ROOT"), "home"))) {
  throw new Error("Work detail HOME escaped its isolated root");
}

/** Leads with a few, five and many managed agents, and one that manages
 * nobody: the states the Work detail must read well in. */
const LEADS = [
  { id: "qa-lead-few", title: "Ship the onboarding copy", workers: 2 },
  { id: "qa-lead-five", title: "Lead: release 0.3 checks", workers: 5 },
  { id: "qa-lead-many", title: "Migrate every service to the new queue", workers: 12 },
];
const SOLO = { id: "qa-solo", title: "Update the changelog" };
const WORKERS = [
  ["Fix the auth token refresh", "Read the failing checks on the open pull request, reproduce each failure locally, fix the cause rather than the symptom and report which tests you ran"],
  ["Billing: reconcile invoices with the ledger export and flag every mismatch", "Compare the two exports"],
  ["Search index rebuild", "Rebuild the index from the snapshot and measure how long it takes"],
  ["Mobile push registration", "Register the device token again after a reinstall"],
  ["Docs for the CLI", "Document every flag of dure runs"],
  ["Queue consumer for orders", "Move the orders consumer to the new queue"],
  ["Queue consumer for emails", "Move the emails consumer to the new queue"],
  ["Payments webhook retries", "Retry failed webhooks with backoff"],
  ["Inventory sync", "Sync inventory every five minutes"],
  ["Analytics events", "Send the checkout events to the new pipeline"],
  ["Admin dashboard", "Add the queue depth chart"],
  ["Rate limiter", "Limit each account to 100 requests a minute"],
];

/** Claude keeps a project's transcripts under its working directory, with
 * every slash and dot spelled as a dash. */
const claudeProject = (cwd) => cwd.replace(/[/.]/gu, "-");

function agent(id, title, provider, patch = {}) {
  return {
    id,
    name: id,
    displayName: title,
    provider,
    projectId: "qa-project",
    worktreePath: path.join(home, "work", id),
    branch: id,
    sessionId: `qa-session-${id}`,
    sessionKind: "pty",
    conversationId: `qa-conversation-${id}`,
    ...patch,
  };
}

const agents = [];
for (const lead of LEADS) {
  agents.push(agent(lead.id, lead.title, "codex"));
  for (let index = 0; index < lead.workers; index += 1) {
    const [title, asked] = WORKERS[index];
    const worker = agent(`${lead.id}-${index}`, title, "claude", {
      runParent: { agentId: lead.id },
    });
    agents.push(worker);
    const project = path.join(home, ".claude", "projects", claudeProject(worker.worktreePath));
    mkdirSync(project, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(project, `${worker.conversationId}.jsonl`),
      `${JSON.stringify({
        type: "user",
        timestamp: "2026-11-28T09:00:00Z",
        message: { role: "user", content: asked },
      })}\n`,
      { mode: 0o600 },
    );
  }
}
// The solo agent recorded a conversation whose history is gone: an ended
// agent with nothing left to read.
agents.push(agent(SOLO.id, SOLO.title, "codex"));

// Ended agents whose provider still keeps their last conversation: a short
// Claude one, and a long Codex one Codex has since compressed.
const ENDED_FEW = agent("qa-ended-few", "Rename the billing flags", "claude");
const ENDED_MANY = agent("qa-ended-many", "Speed up the test suite", "codex", {
  conversationId: "019f0000-0000-7000-8000-000000000820",
});
agents.push(ENDED_FEW, ENDED_MANY);

const claudeRecord = (type, content, extra = {}) =>
  JSON.stringify({
    type,
    sessionId: ENDED_FEW.conversationId,
    timestamp: "2026-11-27T16:00:00Z",
    message: { role: type, content, ...extra },
  });
const fewProject = path.join(home, ".claude", "projects", claudeProject(ENDED_FEW.worktreePath));
mkdirSync(fewProject, { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(fewProject, `${ENDED_FEW.conversationId}.jsonl`),
  [
    claudeRecord("user", "Rename the billing feature flags to the billing.* namespace and keep the old names working for one release."),
    claudeRecord("assistant", [
      { type: "text", text: "I'll find every flag first." },
      { type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "BILLING_", path: "src" } },
    ]),
    claudeRecord("user", [{ type: "tool_result", tool_use_id: "toolu_grep", content: "src/flags.ts\nsrc/billing/invoice.ts" }]),
    claudeRecord("assistant", [{
      type: "text",
      text: "Renamed the three billing flags to `billing.invoices`, `billing.refunds` and `billing.trials`. The old names still resolve through an alias that logs once, and `flags.test.ts` covers both spellings.",
    }], { stop_reason: "end_turn" }),
    claudeRecord("user", "Good. When can the aliases go?"),
    claudeRecord("assistant", [{
      type: "text",
      text: "After 0.4 ships: nothing outside this repository reads the old names, and the alias logs tell us if that changes.",
    }], { stop_reason: "end_turn" }),
  ].join("\n") + "\n",
  { mode: 0o600 },
);

const MANY_TURNS = [
  ["Find out why the test suite takes eleven minutes.", "Most of it is three integration suites that each start their own database. Together they take eight of the eleven minutes."],
  ["Can they share one database?", "Yes: each suite only needs its own schema. I moved them onto one container with a schema per suite."],
  ["How long does it take now?", "Six minutes on this machine, down from eleven. The integration suites take three minutes together."],
  ["What else is slow?", "The snapshot tests rebuild the fixtures for every file. Building them once per run saves another ninety seconds."],
  ["Do that.", "Done. The fixtures build once, in a global setup, and every file reads them."],
  ["Run the whole suite twice to check nothing is flaky.", "Both runs passed: 1,284 tests each, four minutes thirty and four minutes twenty-two."],
  ["Is CI faster too?", "CI went from fourteen minutes to seven. The cache now keeps the fixture build between jobs."],
  ["Write up what changed for the team.", "The note is in docs/testing.md: one database with a schema per suite, fixtures built once, and how to run a single suite on its own."],
];
const rollout = [{ type: "session_meta", payload: { id: ENDED_MANY.conversationId, cwd: ENDED_MANY.worktreePath } }];
MANY_TURNS.forEach(([prompt, answer], index) => {
  const turn = `turn-${index}`;
  rollout.push(
    { type: "event_msg", payload: { type: "task_started", turn_id: turn } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
    { type: "event_msg", payload: { type: "item_completed", turn_id: turn, item: { type: "CommandExecution", id: `command-${index}`, command: "pnpm test --reporter=summary", status: "completed" } } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: answer } },
  );
});
const day = path.join(home, ".codex", "sessions", "2026", "11", "20");
mkdirSync(day, { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(day, `rollout-2026-11-20T09-00-00-${ENDED_MANY.conversationId}.jsonl.zst`),
  zstdCompressSync(rollout.map((record) => `${JSON.stringify(record)}\n`).join("")),
  { mode: 0o600 },
);

writeFileSync(
  path.join(home, "work-detail-fixture.json"),
  JSON.stringify({
    agents,
    leads: LEADS.map(({ id }) => id),
    solo: SOLO.id,
    ended: [ENDED_FEW.id, ENDED_MANY.id],
  }),
  { mode: 0o600 },
);
