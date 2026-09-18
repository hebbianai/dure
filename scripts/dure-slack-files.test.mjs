import assert from "node:assert/strict";
import { test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SlackJournal } from "../cli/lib/slack/journal.mjs";
import { SlackFiles, localFileLinks } from "../cli/lib/slack/files.mjs";
import { SlackBridge } from "../cli/lib/slack/bridge.mjs";
import { SlackApi } from "../cli/lib/slack/api.mjs";
import { DureSlackBackend } from "../cli/lib/slack/backend.mjs";
import { slackKey } from "../cli/lib/slack/event.mjs";
import { splitPromptAttachments } from "../cli/lib/contracts/prompt-attachments.mjs";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-slack-files-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const config = { schemaVersion: 1, teamId: "T1", channels: [{ channelId: "C1", projectId: "project", providerId: "codex" }] };
  const journal = new SlackJournal(path.join(root, "deliveries.json"), config);
  await journal.acquire();
  t.onTestFinished(() => { journal.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const thread = { teamId: "T1", channelId: "C1", threadTs: "100.1", agentId: "agent", backend: { profileId: "local", backendId: "backend", scopeId: "scope" } };
  journal.data.threads[slackKey("T1", "C1", "100.1")] = thread;
  const uploads = [], deliveries = [];
  const backend = {
    localFiles: async () => ({ root: workspace }),
    read: async () => ({ binding: { interactionSessionId: "conversation", runtime: {} }, activeTurn: { turnId: "active" }, rows: [], finalCursor: {} }),
    deliver: async (_thread, intent, operation) => { deliveries.push({ intent, operation }); },
  };
  const slack = {
    downloadFile: async () => ({ bytes: Buffer.from("image-content"), mimetype: "image/png" }),
    uploadFile: async (target, file, allocated) => {
      const id = `F${uploads.length + 1}`;
      allocated(id);
      uploads.push({ target, ...file });
      return { id, permalink: `https://fixture.slack.com/files/${id}` };
    },
    write: async () => ({ ts: "200.1" }),
  };
  const files = new SlackFiles({ journal, backend, slack });
  const bridge = new SlackBridge({ config, journal, backend, slack, files, botUserId: "UBOT" });
  return { root, workspace, journal, thread, backend, slack, files, bridge, uploads, deliveries };
}

test("file-share captions and images enter the current turn once using the shared attachment contract", async (t) => {
  const f = await fixture(t);
  const payload = { type: "event_callback", team_id: "T1", event: { type: "message", subtype: "file_share", channel: "C1",
    ts: "101.1", thread_ts: "100.1", user: "U1", text: "Look at this state", files: [{ id: "FIMAGE", name: "image.png", mimetype: "image/png" }] } };
  assert.equal(f.bridge.accept(payload), true);
  await f.bridge.tick(error => { throw error; });
  assert.equal(f.deliveries[0].operation, "agent_conversation.steer_turn");
  assert.equal(f.deliveries[0].intent.turnId, "active");
  const parsed = splitPromptAttachments(f.deliveries[0].intent.input);
  assert.match(parsed.body, /Look at this state/);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(fs.readFileSync(parsed.attachments[0].path, "utf8"), "image-content");
  assert.equal(f.bridge.accept(payload), false);
  await f.bridge.tick();
  assert.equal(f.deliveries.length, 1);
});

test("missing file permission preserves the caption and makes unavailable image content explicit", async (t) => {
  const f = await fixture(t);
  f.slack.downloadFile = async () => { throw Object.assign(new Error("missing scope"), { code: "slack_missing_scope" }); };
  f.bridge.accept({ type: "event_callback", team_id: "T1", event: { type: "message", subtype: "file_share", channel: "C1",
    ts: "101.1", thread_ts: "100.1", user: "U1", text: "The screenshot shows the problem", files: [{ id: "F1", name: "image.png" }] } });
  await f.bridge.tick(error => { throw error; });
  const text = f.deliveries[0].intent.input;
  assert.match(text, /The screenshot shows the problem/);
  assert.match(text, /image\.png/);
  assert.match(text, /files:read and files:write/);
  assert.equal(splitPromptAttachments(text).attachments.length, 0);
});

test("file access resolves the exact task workspace and refuses a foreign projection or SSH route", async () => {
  const thread = { agentId: "agent", backend: { profileId: "local", backendId: "backend", scopeId: "saved-scope" } };
  const profile = { id: "local", transport: { kind: "local" }, expected: { backendId: "backend", scopeId: "saved-scope" } };
  let agentId = "agent";
  const requests = [];
  const backend = new DureSlackBackend(async () => ({ profile }), { requestBackend: async (_profile, request) => {
    requests.push(request);
    return { result: { projectionContext: { agent: { agentId, workspaceId: "workspace" }, workspace: { workspaceId: "workspace", rootPath: "/task" } } } };
  } });
  assert.deepEqual(await backend.localFiles(thread), { root: "/task" });
  assert.equal(requests[0].scopeId, "saved-scope");
  assert.equal(requests[0].operation, "agent_runtime.projection.inspect");
  agentId = "another-agent";
  await assert.rejects(backend.localFiles(thread), { code: "slack_file_workspace_unavailable" });
  profile.transport.kind = "ssh";
  assert.equal(await backend.localFiles(thread), null);
  assert.equal(requests.length, 2);
});

test("remote input never hands a connector-local file path to a remote agent", async (t) => {
  const f = await fixture(t);
  f.backend.localFiles = async () => null;
  f.slack.downloadFile = async () => { throw new Error("must not download"); };
  const text = await f.files.prepareInput({ key: "message", files: [{ id: "F1", name: "image.png" }] }, f.thread);
  assert.match(text, /unavailable/);
  assert.equal(splitPromptAttachments(text).attachments.length, 0);
});

test("local video links upload into the exact Slack thread and reuse their confirmed file after reconnect", async (t) => {
  const f = await fixture(t);
  const video = path.join(f.workspace, "video.mp4");
  fs.writeFileSync(video, "video-bytes");
  const markdown = `[Video](${video}) and [Website](https://example.test/)`;
  const result = await f.files.publish(f.thread, "assistant-1", markdown);
  assert.equal(result, "[Video](https://fixture.slack.com/files/F1) and [Website](https://example.test/)");
  assert.deepEqual(f.uploads[0].target, f.thread);
  assert.equal(f.uploads[0].bytes.toString(), "video-bytes");
  const reopened = new SlackFiles({ journal: f.journal, backend: f.backend, slack: f.slack });
  assert.equal(await reopened.publish(f.thread, "assistant-1", markdown), result);
  assert.equal(f.uploads.length, 1);
});

test("workspace escapes and symlinks cannot upload a file outside the task", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "private.txt");
  fs.writeFileSync(outside, "outside workspace");
  fs.symlinkSync(outside, path.join(f.workspace, "linked.txt"));
  for (const filename of [outside, "../private.txt", "linked.txt"]) {
    const result = await f.files.publish(f.thread, filename, `[Download](${filename})`);
    assert.match(result, /file unavailable in Slack/);
    assert.ok(!result.includes(filename));
  }
  assert.equal(f.uploads.length, 0);
});

test("uncertain file completion is never uploaded again and is not rendered as a broken path link", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.workspace, "video.mp4"), "video");
  let attempts = 0;
  f.slack.uploadFile = async (_thread, _file, allocated) => {
    attempts++;
    allocated("F1");
    throw new Error("connection lost after completion");
  };
  const result = await f.files.publish(f.thread, "result", "[Video](video.mp4)");
  assert.match(result, /file unavailable in Slack/);
  assert.ok(!result.includes("](video.mp4)"));
  assert.equal(await f.files.publish(f.thread, "result", "[Video](video.mp4)"), result);
  assert.equal(attempts, 1);
});

test("missing upload permission leaves a readable label and an actionable scope notice", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.workspace, "video.mp4"), "video");
  f.slack.uploadFile = async () => { throw Object.assign(new Error("scope"), { code: "slack_missing_scope" }); };
  const result = await f.files.publish(f.thread, "result", "[Video](video.mp4)");
  assert.match(result, /Video \(file unavailable in Slack\)/);
  assert.match(result, /files:read and files:write/);
  assert.ok(!result.includes("](video.mp4)"));
});

test("code samples, anchors and web links do not become local uploads", () => {
  assert.deepEqual(localFileLinks('`[Example](/tmp/a)`\n```md\n[Example](/tmp/b)\n```\n[Web](https://example.test/) [Here](#section)'), []);
  assert.equal(localFileLinks("[Video](<./with spaces/video.mp4>)")[0].filename, "./with spaces/video.mp4");
});

test("Slack's upload sequence sends raw bytes without the bot token and returns the confirmed file link", async () => {
  const calls = [];
  const api = new SlackApi({ botToken: "fixture-token", fetchApi: async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith("https://slack.com/api/files.getUploadURLExternal?")) return Response.json({ ok: true, file_id: "F1", upload_url: "https://files.slack.com/upload/v1/fixture" });
    if (url.startsWith("https://files.slack.com/upload/")) return new Response("OK");
    if (url.endsWith("files.completeUploadExternal")) return Response.json({ ok: true, files: [{ id: "F1" }] });
    if (url.startsWith("https://slack.com/api/files.info?")) return Response.json({ ok: true, file: { id: "F1", permalink: "https://fixture.slack.com/files/F1" } });
    throw new Error("unexpected request");
  } });
  let allocated;
  const result = await api.uploadFile({ channelId: "C1", threadTs: "100.1" }, { name: "video.mp4", bytes: Buffer.from("video") }, id => { allocated = id; });
  assert.equal(allocated, "F1");
  assert.equal(result.permalink, "https://fixture.slack.com/files/F1");
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.body.toString(), "video");
  assert.deepEqual(JSON.parse(calls[2].options.body), { files: [{ id: "F1", title: "video.mp4" }], channel_id: "C1", thread_ts: "100.1" });
});

test("attachment downloads validate Slack metadata and bound the received bytes", async () => {
  for (const change of [{ url_private: "https://other.test/private" }, { size: 100 }, { mode: "external" }]) {
    let calls = 0;
    const api = new SlackApi({ fetchApi: async () => {
      calls++;
      return Response.json({ ok: true, file: { id: "F1", mode: "hosted", size: 4, url_private: "https://files.slack.com/files-pri/F1", ...change } });
    } });
    await assert.rejects(api.downloadFile("F1", 10), { code: "slack_file_unavailable" });
    assert.equal(calls, 1);
  }
  const api = new SlackApi({ fetchApi: async (url) => url.startsWith("https://slack.com/api/")
    ? Response.json({ ok: true, file: { id: "F1", mode: "hosted", size: 3, url_private: "https://files.slack.com/files-pri/F1" } })
    : new Response("too many bytes") });
  await assert.rejects(api.downloadFile("F1", 10), { code: "slack_file_unavailable" });
});

test("attachment download authenticates only the validated Slack file URL and retains the original bytes", async () => {
  const bytes = Buffer.from([0, 255, 10, 2]);
  const api = new SlackApi({ botToken: "fixture-token", fetchApi: async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    assert.equal(options.redirect, "error");
    if (url.startsWith("https://slack.com/api/")) return Response.json({ ok: true,
      file: { id: "F1", mode: "hosted", size: bytes.length, mimetype: "image/png", url_private: "https://files.slack.com/files-pri/F1" } });
    assert.equal(url, "https://files.slack.com/files-pri/F1");
    return new Response(bytes, { headers: { "Content-Type": "image/png" } });
  } });
  assert.deepEqual(await api.downloadFile("F1", 10), { bytes, mimetype: "image/png" });
});
