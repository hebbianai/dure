import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseBackendProfiles } from "../../cli/lib/backend-profiles.mjs";
import { DureSlackBackend } from "../../cli/lib/slack/backend.mjs";
import { SlackBridge } from "../../cli/lib/slack/bridge.mjs";
import { slackKey } from "../../cli/lib/slack/event.mjs";
import { SlackJournal } from "../../cli/lib/slack/journal.mjs";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";

const options = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const guardian = fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
const root = fs.realpathSync(options.root);
const repository = fs.realpathSync(options.repository);
assert.ok(root.startsWith(`${guardian}${path.sep}`));
assert.ok(repository.startsWith(`${root}${path.sep}`));
const config = { schemaVersion: 1, teamId: "TQA", channels: [{
  channelId: "CQA", projectId: "slack-spawn-project", providerId: "codex",
}] };
const threadKey = slackKey("TQA", "CQA", "100.001");
if (process.argv[3] === "--prepare") {
  fs.writeFileSync(path.join(repository, "AGENTS.md"), "This is a disposable QA repository. Work only on the requested local files. Do not inspect credentials, use external services, or contact other agents. The installed dure-orchestration goal tools connect only to this test's local Dure backend.\n");
  fs.writeFileSync(path.join(repository, "counts.txt"), "First delivery: 17 parcels. Second delivery: 26 parcels.\n");
  const files = ["AGENTS.md", "counts.txt"];
  if (options.goal) {
    fs.writeFileSync(path.join(repository, "issues.md"), "Open issue: result.txt is missing. Create it for downstream import, containing only the total parcel count as decimal digits and a newline. Treat counts.txt as the source of truth.\n");
    fs.writeFileSync(path.join(repository, "report.txt"), "Total parcels: 40\n");
    files.push("issues.md", "report.txt");
  }
  for (const args of [["init", "--quiet"], ["add", ...files],
    ["-c", "user.name=QA", "-c", "user.email=qa@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "QA source"]]) {
    execFileSync("git", args, { cwd: repository, env: withoutLocalGitOverrides(), stdio: "pipe" });
  }
  if (options.goal) {
    const installed = JSON.parse(execFileSync(process.execPath, [
      fileURLToPath(new URL("./goal-installed-provider.mjs", import.meta.url)), process.argv[2],
    ], { encoding: "utf8" }));
    process.stdout.write(`${JSON.stringify({ idempotencyKey: `slack-${threadKey}`, ...installed })}\n`);
    process.exit(0);
  }
  // Scope tooling to this repository-only QA invocation while retaining the
  // actual provider-default account and normal permission behavior.
  const executable = path.join(root, "codex-spawn-qa");
  const codex = fs.realpathSync(process.env.DURE_CODEX_BIN);
  const quoted = `'${codex.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(executable, `#!/bin/sh\nexec ${quoted} -c 'mcp_servers={}' "$@"\n`, { mode: 0o700, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ idempotencyKey: `slack-${threadKey}`, executable, backendHome: root })}\n`);
  process.exit(0);
}

console.log(`slack-spawn-owned-root: ${root}`);
const profile = parseBackendProfiles(JSON.stringify({ schemaVersion: 1, kind: "dure.backend_profiles", profiles: [{ id: "qa", expected: options.expected,
  transport: { kind: "local", endpoint: { kind: "unix_socket", path: options.endpoint } },
  auth: { kind: "peer" }, trust: { kind: "local_peer" } }] })).profiles[0];
const backend = new DureSlackBackend(async () => ({ profile }));
const file = path.join(root, "slack-deliveries.json");
let journal = new SlackJournal(file, config);
await journal.acquire();
const messages = new Map();
let writes = 0;
const slack = {
  async write(thread, text, key, previous, blocks) {
    writes++;
    const ts = previous ?? `200.${writes}`;
    messages.set(key, { text, blocks, ts, channelId: thread.channelId });
    return { ts };
  },
  async findDelivery(_thread, key) { return messages.get(key)?.ts ?? null; },
};
let bridge = new SlackBridge({ config, botUserId: "UBOT", journal, backend, slack });
const task = options.goal
  ? "Pursue an ongoing Dure Pro goal: make this repository's parcel data consistent and ready for downstream use. Use the installed dure-orchestration MCP goal tools to register and maintain that goal; do not use shell clients for goal control. In the first work segment, inspect the local files and issues, report the existing work and any newly discovered problem with QA_SLACK_GOAL_REVIEW, and end the turn with the goal active without changing files. In subsequent automatic work, choose the next useful action, address the recorded issue and discovered inconsistencies, preserve the source counts, verify the outcome, and complete the goal using the installed tools. Finish with QA_SLACK_GOAL_DONE and the verified total. Use apply_patch for file edits. Work only on this disposable repository and its local Dure goal tools; do not use external services or inspect credentials."
  : "Read counts.txt in the current checkout. Add the two observed parcel counts and use apply_patch to create result.txt containing only their decimal total followed by a newline. Reply QA_SLACK_STARTED with the verified total. Work only on these local files; do not use network services or inspect credentials.";
const payload = { type: "event_callback", team_id: "TQA", event: {
  type: "app_mention", channel: "CQA", user: "UQA1", ts: "100.001",
  text: `<@UBOT> ${task}`,
} };
const shown = new Set();
const fileApprovals = new Set();
let redirectedGoal;
let staleCompletionKey;
try {
  assert.equal(bridge.accept(payload), true);
  await bridge.tick((error) => { throw error; });
  const thread = journal.data.threads[threadKey];
  assert.ok(thread.agentId, "the mention must create the actual task");
  console.log(`slack-spawn-created: ${JSON.stringify({ agentId: thread.agentId, backend: thread.backend })}`);
  const deadline = Date.now() + (options.goal ? 540_000 : 300_000);
  let final;
  while (Date.now() < deadline) {
    await bridge.tick((error) => { throw error; });
    const { read } = await backend.call(thread, "agent_conversation.read", {
      schemaVersion: 1, interactionSessionId: thread.interactionSessionId, direction: "tail", limit: 100,
    });
    const page = read.page;
    // Inspect the same snapshot as the pending projection; new provider requests
    // may have arrived after the preceding tick's read.
    await bridge.pending.sync(thread, page);
    if (options.goal) assert.ok(!["failed", "paused"].includes(page.goal?.status), `Actual goal stopped: ${JSON.stringify(page.goal)}`);
    const failed = page.rows.find(({ item }) => item.body.type === "lifecycle" && ["turn_failed", "turn_canceled"].includes(item.body.state));
    assert.ok(!failed, `Actual provider turn failed: ${JSON.stringify(failed?.item.body)}`);
    for (const pending of page.pendingRequests) {
      const entry = Object.values(journal.data.pending).find((value) => !value.resolved && value.target.requestId === pending.request.requestId);
      assert.equal(entry?.presentation.kind, "permission", "unexpected questions require their own QA scenario");
      const providerRequest = pending.request.payload.providerRequest;
      if (providerRequest?.method === "mcpServer/elicitation/request") {
        const body = providerRequest.params._meta.tool_params_display.find(({ name }) => name === "body").value;
        assert.deepEqual(entry.presentation.input, { body }, "the permission card must show the actual MCP arguments");
        assert.equal(body.agentId, thread.agentId);
        assert.ok(messages.get(entry.key)?.text.includes(JSON.stringify({ body }, null, 2)));
        if (options.goal && body.status === "complete" && !redirectedGoal) {
          assert.equal(body.expectedRevision, page.goal.revision);
          const { goal } = await backend.call(thread, "agent_goal.put", {
            schemaVersion: 1, agentId: thread.agentId, expectedRevision: page.goal.revision,
            idempotencyKey: "qa-dure-goal-expansion", status: "active",
            objective: "Make this repository's parcel data consistent and ready for downstream use, including a verified breakdown.txt handoff.",
            detail: "A teammate added a downstream handoff requirement while the earlier completion was pending. Preserve the completed fixes and source counts. Before completing, use apply_patch to create breakdown.txt containing exactly 17 + 26 = 43 followed by a newline, verify every output, and preserve this expanded objective.",
          });
          redirectedGoal = goal;
          staleCompletionKey = body.idempotencyKey;
          assert.equal(goal.revision, page.goal.revision + 1);
          await bridge.tick((error) => { throw error; });
          assert.ok([...messages.values()].some(({ text }) => text.startsWith("Goal active.") && text.includes(goal.objective)));
          console.log(`slack-spawn-direction: ${JSON.stringify({ goal, staleCompletionKey })}`);
        }
      }
      if (pending.request.payload.providerRequest?.method === "item/fileChange/requestApproval") {
        const changes = entry.presentation.input?.changes;
        assert.ok(changes?.length > 0, "the pending permission must show the proposed file change");
        for (const change of changes) {
          assert.ok(change.path.startsWith(`${repository}${path.sep}.worktrees${path.sep}`));
          if (!options.goal) assert.equal(path.basename(change.path), "result.txt");
          assert.ok(messages.get(entry.key)?.text.includes(JSON.stringify(change.path)));
          assert.ok(messages.get(entry.key)?.text.includes(JSON.stringify(change.diff)));
        }
        if (!options.goal) {
          assert.equal(changes.length, 1);
          assert.equal(changes[0].kind.type, "add");
          assert.equal(changes[0].diff, "43\n");
        }
        fileApprovals.add(entry.key);
      }
      const answerFile = path.join(root, "permission-answer.json");
      if (!shown.has(entry.key)) {
        shown.add(entry.key);
        console.log(`slack-spawn-permission: ${JSON.stringify({ key: entry.key, presentation: entry.presentation, answerFile })}`);
      }
      if (!fs.existsSync(answerFile)) continue;
      const answer = JSON.parse(fs.readFileSync(answerFile, "utf8"));
      assert.equal(answer.key, entry.key);
      assert.ok(["allow", "deny"].includes(answer.decision));
      fs.unlinkSync(answerFile);
      bridge.interact({ type: "block_actions", team: { id: "TQA" }, user: { id: "UQA2", name: "QA teammate" },
        container: { channel_id: "CQA", message_ts: journal.data.outbound[entry.key].ts }, message: { user: "UBOT" },
        actions: [{ action_id: `dure.pending.${answer.decision}`, value: entry.key, action_ts: `300.${shown.size}` }] });
    }
    const complete = options.goal ? page.goal?.status === "complete" : page.rows.some(({ item }) => item.body.type === "message" && item.body.role === "assistant" && item.body.markdown.includes("QA_SLACK_STARTED"));
    if (!page.activeTurn && complete) {
      if (!options.goal) assert.equal(page.rows.filter(({ item }) => item.body.type === "lifecycle" && item.body.state === "turn_completed").length, 1);
      assert.ok(page.binding.providerConversationRef);
      final = page;
      break;
    }
    await delay(250);
  }
  assert.ok(final, "the actual provider did not complete the Slack request");
  assert.ok(fileApprovals.size > 0, "the actual provider must exercise file-change approval");
  await bridge.tick((error) => { throw error; });
  const marker = options.goal ? "QA_SLACK_GOAL_DONE" : "QA_SLACK_STARTED";
  assert.ok([...messages.values()].some(({ text }) => text.includes(marker) && text.includes("43")));
  if (options.goal) {
    const reviewIndex = final.rows.findIndex(({ item }) => item.body.type === "message" && item.body.role === "assistant" && item.body.markdown.includes("QA_SLACK_GOAL_REVIEW"));
    const review = final.rows[reviewIndex];
    assert.ok(review?.item.body.markdown.includes("report.txt"), "the first segment must report the discovered stale file");
    const continuation = final.rows.findIndex(({ item }) => item.body.type === "goal_continuation");
    const firstCompletion = final.rows.findIndex(({ item }) => item.body.type === "lifecycle" && item.body.state === "turn_completed");
    assert.ok(reviewIndex >= 0 && reviewIndex < firstCompletion && continuation > firstCompletion);
    assert.ok(final.rows.every(({ item }, index) => item.body.type !== "tool" || item.body.name !== "fileChange" || index > continuation), "file changes belong to the automatic follow-up segment");
    assert.ok(final.rows.filter(({ item }) => item.body.type === "lifecycle" && item.body.state === "turn_completed").length >= 2);
    assert.equal(final.goal.agentId, thread.agentId);
    assert.ok(redirectedGoal, "the actual completion must overlap a Dure-side direction change");
    assert.equal(final.goal.objective, redirectedGoal.objective);
    assert.ok(final.goal.revision > redirectedGoal.revision);
    const conflictIndex = final.rows.findIndex(({ item }) => item.body.type === "tool" &&
      item.body.input?.arguments?.body?.idempotencyKey === staleCompletionKey &&
      JSON.stringify(item.body.output)?.includes("agent_goal_conflict"));
    assert.ok(conflictIndex > continuation, "the old completion must fail against the newer direction");
    assert.ok(final.rows.some(({ item }, index) => index > conflictIndex && item.body.type === "tool" &&
      item.body.input?.tool === "agent_goal_get" &&
      item.body.output?.result?.structuredContent?.receipt?.goal?.revision === redirectedGoal.revision),
    "the actual provider must reread the changed goal after its stale update fails");
    assert.ok([...messages.values()].some(({ text }) => text.startsWith("Goal active.")));
    assert.ok([...messages.values()].some(({ text }) => text.startsWith("Goal marked complete.")));
    assert.ok(![...messages.values()].some(({ text }) => text.includes("Dure is continuing the explicit goal")));
    console.log(`slack-spawn-goal: ${JSON.stringify({ goal: final.goal, automaticTurns: final.rows.filter(({ item }) => item.body.type === "goal_continuation").length, firstReview: review.item.body.markdown })}`);
  }
  const previousWrites = writes;
  journal.close();
  journal = new SlackJournal(file, config);
  await journal.acquire();
  bridge = new SlackBridge({ config, botUserId: "UBOT", journal, backend, slack });
  assert.equal(bridge.accept(payload), false);
  await bridge.tick((error) => { throw error; });
  assert.equal(writes, previousWrites);
  assert.equal(journal.data.threads[threadKey].agentId, thread.agentId);
  console.log(`slack-spawn-result: ${JSON.stringify({ realProvider: true, realSlack: false,
    binding: final.binding, replayDuplicated: false, permissionRequests: shown.size, fileApprovals: fileApprovals.size })}`);
} finally { journal.close(); }
