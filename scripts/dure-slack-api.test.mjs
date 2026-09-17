import assert from "node:assert/strict";
import { test } from "vitest";
import { SlackApi } from "../cli/lib/slack/api.mjs";

function rateLimitedApi(controller) {
  const calls = [];
  const api = new SlackApi({ signal: controller.signal, fetchApi: async (url) => {
    const method = url.split("/").at(-1);
    calls.push({ method, at: Date.now() });
    if (calls.length === 1) return new Response(null, { status: 429, headers: { "Retry-After": "1" } });
    return Response.json({ ok: true, ts: "200.001" });
  } });
  return { api, calls };
}

test("Retry-After delays later calls to that method without retrying the failed request or delaying another workspace/method", async () => {
  const controller = new AbortController();
  const { api, calls } = rateLimitedApi(controller);
  await assert.rejects(api.call("conversations.history"), { code: "slack_rate_limited", retryAfterMs: 1000 });
  const later = api.call("conversations.history").catch((error) => error);
  try {
    await api.call("auth.test");
    const other = new SlackApi({ fetchApi: async () => Response.json({ ok: true }) });
    await other.call("conversations.history");
    assert.deepEqual(calls.map(({ method }) => method), ["conversations.history", "auth.test"]);
    assert.equal((await later).ok, true);
    assert.equal(calls.length, 3);
    assert.ok(calls[2].at - calls[0].at >= 1000);
  } finally { controller.abort(); await later; }
});

test("owner cancellation ends a rate-limit wait before another HTTP request starts", async () => {
  const controller = new AbortController();
  const { api, calls } = rateLimitedApi(controller);
  await assert.rejects(api.call("conversations.history"), { code: "slack_rate_limited" });
  const later = api.call("conversations.history").catch((error) => error);
  controller.abort();
  assert.equal((await later).name, "AbortError");
  assert.equal(calls.length, 1);
});

test("channel send spacing survives a method cooldown before the preceding post", async () => {
  const controller = new AbortController();
  const { api, calls } = rateLimitedApi(controller);
  await assert.rejects(api.call("chat.postMessage"), { code: "slack_rate_limited" });
  const thread = { channelId: "C1", threadTs: "100.001" };
  await Promise.all([api.write(thread, "First", "first"), api.write(thread, "Second", "second")]);
  assert.equal(calls.length, 3);
  assert.ok(calls[1].at - calls[0].at >= 1000, "the first post honors the cooldown");
  assert.ok(calls[2].at - calls[1].at >= 1000, "the cooldown cannot consume channel spacing before a post is sent");
});
