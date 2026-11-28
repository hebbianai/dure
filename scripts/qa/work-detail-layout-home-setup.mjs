import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

// The Work detail QA's agents and their provider records, written into the
// disposable HOME before the app starts. The app reads each worker's last
// prompt from its Claude transcript through its own metadata reader, so the
// rows' "Asked" lines are the product's, not the probe's.

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
agents.push(agent(SOLO.id, SOLO.title, "codex"));

writeFileSync(
  path.join(home, "work-detail-fixture.json"),
  JSON.stringify({ agents, leads: LEADS.map(({ id }) => id), solo: SOLO.id }),
  { mode: 0o600 },
);
