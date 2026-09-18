import assert from "node:assert/strict";
import { test } from "vitest";
import { SlackApi } from "../cli/lib/slack/api.mjs";

test("file permission observations come only from successful bot-token scope headers", async () => {
  const observed = [];
  let scopes = "chat:write, files:read";
  let ok = true;
  const api = new SlackApi({ botToken: "fixture-bot", appToken: "fixture-app",
    onFilePermissions: (permissions) => observed.push(permissions),
    fetchApi: async () => Response.json({ ok, error: "invalid_auth" }, {
      headers: scopes === null ? {} : { "x-oauth-scopes": scopes },
    }),
  });
  await api.call("auth.test");
  assert.deepEqual(observed, [{ read: true, write: false }]);
  scopes = "connections:write";
  await api.call("apps.connections.open");
  scopes = null;
  await api.call("auth.test");
  assert.equal(observed.length, 1, "missing headers and app tokens do not overwrite a bot observation");
  scopes = "files:read,files:write";
  ok = false;
  await assert.rejects(api.call("auth.test"));
  assert.equal(observed.length, 1);
  ok = true;
  await api.call("auth.test");
  assert.deepEqual(observed.at(-1), { read: true, write: true });
});

test("Slack history reads send their parameters in the GET query", async () => {
  const api = new SlackApi({ botToken: "fixture-only", fetchApi: async (url, options) => {
    const request = new URL(url);
    assert.equal(request.pathname, "/api/conversations.replies");
    assert.equal(request.searchParams.get("channel"), "C1");
    assert.equal(request.searchParams.get("ts"), "100.001");
    assert.equal(request.searchParams.get("include_all_metadata"), "true");
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, "Bearer fixture-only");
    return Response.json({ ok: true, messages: [] });
  } });
  await api.call("conversations.replies", { channel: "C1", ts: "100.001", include_all_metadata: true });
});

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
