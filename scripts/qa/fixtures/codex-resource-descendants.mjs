import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export async function observeActiveDescendant(call, threadId) {
  const deadline = Date.now() + 5000;
  let parent;
  do {
    parent = await call("thread/read", { threadId, includeTurns: true });
    if (parent.thread.turns.at(-1)?.status === "completed") break;
    await delay(50);
  } while (Date.now() < deadline);
  assert.equal(parent.thread.id, threadId);
  assert.equal(parent.thread.turns.length, 1);
  assert.equal(parent.thread.turns[0].status, "completed");
  const children = await call("thread/list", {
    parentThreadId: threadId,
    sourceKinds: ["subAgentThreadSpawn"],
    limit: 10,
  });
  assert.equal(children.nextCursor, null);
  assert.equal(children.data.length, 1, JSON.stringify({ parent, children }));
  const child = children.data[0];
  assert.equal(child.parentThreadId, threadId);
  assert.equal(child.status.type, "active");
  const spawned = parent.thread.turns[0].items.filter((item) =>
    item.type === "subAgentActivity" && item.kind === "started");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].agentThreadId, child.id);
  assert.equal(spawned[0].agentPath, "/root/resource_child");
  return { parentThreadId: threadId, parentTurn: parent.thread.turns[0], child };
}
