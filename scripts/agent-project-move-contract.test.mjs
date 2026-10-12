import { test } from "vitest";
import assert from "node:assert/strict";
import { isAgentProjectMovePlan, isAgentProjectMoveReceipt } from "../cli/lib/contracts/agent-project-move.mjs";
import { collectAgentProjectMove } from "../cli/lib/agent-project-move-command.mjs";

const plan = () => ({ schemaVersion: 1, operationId: "move-1", idempotencyKey: "request-1",
  source: { agentId: "agent-1", providerId: "codex", interactionProfile: "native_cli", revision: 7 }, targetInteractionProfile: "native_cli",
  providerConversationRef: "conversation-1", sourceStopPolicy: { preserve_observed: { runtimeRevision: 3, observedThroughOutputSeq: 9 } },
  workspaceMove: { sourceAgent: { agentId: "agent-1" }, sourceWorkspace: { workspaceId: "workspace-1", projectId: "old", rootPath: "/old" },
    targetProject: { projectId: "new" }, targetWorkspace: { projectId: "new", workspaceId: "new-workspace", rootPath: "/new" } } });
const receipt = () => ({ schemaVersion: 1, receipt: { agentId: "agent-1", providerId: "codex", selectionRevision: 8,
  providerConversationRef: "conversation-1", authority: { interactionProfile: "native_cli", authority: { runtimeWorkspaceId: "new-workspace" } } } });

test("shared clients refuse destructive or malformed idle stop plans", () => {
  assert(isAgentProjectMovePlan(plan(), "agent-1", "new"));
  for (const sourceStopPolicy of ["discard", {}, { preserve_observed: { runtimeRevision: 0, observedThroughOutputSeq: 9 } },
    { preserve_observed: { runtimeRevision: 3, observedThroughOutputSeq: -1 } }]) {
    assert.equal(isAgentProjectMovePlan({ ...plan(), sourceStopPolicy }, "agent-1", "new"), false);
  }
});
test("receipt must bind the conversation, provider, next revision and workspace", () => {
  assert(isAgentProjectMoveReceipt(receipt(), plan()));
  for (const replacement of [{ providerId: "claude" }, { selectionRevision: 7 }, { providerConversationRef: "other" },
    { authority: { authority: { runtimeWorkspaceId: "old-workspace" } } }]) {
    const value = receipt(); Object.assign(value.receipt, replacement);
    assert.equal(isAgentProjectMoveReceipt(value, plan()), false);
  }
});
test("lost apply response retains the exact preview and idle observation for retry", async () => {
  const reviewed = plan(); const calls = [];
  const input = { agentId: "agent-1", projectId: "new", backend: { profile: { id: "local" } },
    requestBackend: async (_, request) => { calls.push(request); return { result: {
      schemaVersion: 1, plan: reviewed, requiresRestartConfirmation: true,
    } }; } };
  const preview = await collectAgentProjectMove(input);
  assert.equal(preview.state, "preview"); assert.equal(calls.length, 1);
  const movePlan = preview.continuation.apply[preview.continuation.apply.indexOf("--move-plan") + 1];
  const lost = await collectAgentProjectMove({ ...input, movePlan, confirmRestart: true,
    requestBackend: async (_, request) => { calls.push(request); throw new Error("response lost"); } });
  assert.equal(lost.execution, "unconfirmed");
  assert.deepEqual(lost.continuation.retry, preview.continuation.apply);
  assert.deepEqual(calls[1].body.plan, reviewed);
  const retried = await collectAgentProjectMove({ ...input, movePlan, confirmRestart: true,
    requestBackend: async (_, request) => { calls.push(request); return { result: receipt() }; } });
  assert.equal(retried.state, "completed");
  assert.deepEqual(calls[2], calls[1]);
});

for (const providerId of ["codex", "claude"]) {
  test(`${providerId} structured move keeps its mode and requires committed destination evidence`, () => {
    const reviewed = plan();
    Object.assign(reviewed.source, { providerId, interactionProfile: "structured_protocol" });
    reviewed.targetInteractionProfile = "structured_protocol";
    reviewed.sourceAuthority = { interactionProfile: "structured_protocol", binding: { agentId: "agent-1", providerId, providerConversationRef: "conversation-1", interactionSessionId: "interaction-1" } };
    assert(isAgentProjectMovePlan(reviewed, "agent-1", "new"));
    const committed = { schemaVersion: 1, workspace: { ...reviewed.workspaceMove.targetWorkspace },
      receipt: { ...receipt().receipt, providerId, authority: { interactionProfile: "structured_protocol", binding: { agentId: "agent-1", providerId, providerConversationRef: "conversation-1", interactionSessionId: "interaction-1" } },
        transitionLineage: { operationId: reviewed.operationId } } };
    assert(isAgentProjectMoveReceipt(committed, reviewed));
    for (const workspace of [undefined, {}, { ...committed.workspace, workspaceId: "wrong" },
      { ...committed.workspace, projectId: "old" }, { ...committed.workspace, rootPath: "/old" }]) {
      assert.equal(isAgentProjectMoveReceipt({ ...committed, workspace }, reviewed), false);
    }
    for (const replacement of [{ transitionLineage: undefined }, { transitionLineage: { operationId: "another-move" } },
      { authority: { interactionProfile: "native_cli", authority: { runtimeWorkspaceId: "new-workspace" } } },
      { authority: { interactionProfile: "structured_protocol", binding: { interactionSessionId: "new-interaction" } } },
      { providerId: "wrong" }, { providerConversationRef: "other" }, { selectionRevision: 7 }]) {
      assert.equal(isAgentProjectMoveReceipt({ ...committed, receipt: { ...committed.receipt, ...replacement } }, reviewed), false);
    }
    for (const interactionProfile of [undefined, "native_cli"]) {
      assert.equal(isAgentProjectMovePlan({ ...reviewed, source: { ...reviewed.source, interactionProfile } }, "agent-1", "new"), false);
    }
  });
}
