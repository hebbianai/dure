import { setTimeout as delay } from "node:timers/promises";

const QUERY_METHODS = new Set(["conversations.history", "conversations.replies", "files.info", "files.getUploadURLExternal"]);

export class SlackApi {
  constructor({ botToken, appToken, signal, fetchApi = fetch, onFilePermissions }) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.signal = signal;
    this.fetch = fetchApi;
    this.onFilePermissions = onFilePermissions;
    this.nextPost = new Map();
    this.cooldowns = new Map();
  }

  async call(method, body = {}) {
    // Slack scopes Retry-After to a method in this workspace. The failed call
    // stays failed; only subsequent calls wait, without stopping other methods.
    while ((this.cooldowns.get(method) ?? 0) > Date.now()) {
      await delay(this.cooldowns.get(method) - Date.now(), undefined, { signal: this.signal });
    }
    this.signal?.throwIfAborted();
    const url = new URL(`https://slack.com/api/${method}`);
    const query = QUERY_METHODS.has(method);
    if (query) url.search = new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])).toString();
    const response = await this.fetch(url.href, {
      method: query ? "GET" : "POST", redirect: "error", signal: AbortSignal.any([...(this.signal ? [this.signal] : []), AbortSignal.timeout(30_000)]),
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${method === "apps.connections.open" ? this.appToken : this.botToken}` },
      ...(query ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      const error = new Error("Slack rate limit; delivery failed.");
      error.code = "slack_rate_limited";
      error.retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000;
      this.cooldowns.set(method, Math.max(this.cooldowns.get(method) ?? 0, Date.now() + error.retryAfterMs));
      throw error;
    }
    if (!response.ok) throw Object.assign(new Error(`Slack API HTTP ${response.status}; delivery failed.`), { code: "slack_http_failed" });
    const result = await response.json();
    if (!result.ok) {
      const code = /^[a-z_]+$/.test(result.error ?? "") ? result.error : "request_failed";
      throw Object.assign(new Error(`Slack API: ${code}`), { code: `slack_${code}` });
    }
    const scopes = response.headers.get("x-oauth-scopes");
    if (method !== "apps.connections.open" && scopes !== null) {
      const granted = new Set(scopes.split(",").map((scope) => scope.trim()));
      this.onFilePermissions?.({ read: granted.has("files:read"), write: granted.has("files:write") });
    }
    return result;
  }

  async write(thread, text, deliveryKey, ts, blocks) {
    const previous = this.nextPost.get(thread.channelId);
    const entry = { finishedAt: 0 };
    entry.result = Promise.resolve().then(async () => {
      if (previous) {
        // A failed delivery stays failed; a later operation can still proceed.
        await previous.result.catch(() => {});
        const wait = previous.finishedAt + 1100 - Date.now();
        if (wait > 0) await delay(wait, undefined, { signal: this.signal });
      }
      const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const common = { channel: thread.channelId, text: escaped, parse: "none",
        // Markdown blocks own Markdown parsing, including tables and code.
        // Escape only Slack control tokens here; HTML-escaping code would
        // display the entities literally inside the Markdown code spans.
        blocks: blocks ?? [{ type: "markdown", text: text.replace(/<([@#!][^>\n]*)>/g, "&lt;$1&gt;") }],
        metadata: { event_type: "dure_delivery", event_payload: { key: deliveryKey } } };
      try {
        return await this.call(ts ? "chat.update" : "chat.postMessage", ts ? { ...common, ts } : {
          ...common, mrkdwn: true, unfurl_links: false, unfurl_media: false, thread_ts: thread.threadTs,
        });
      } finally {
        // A method cooldown may delay actual dispatch. Measure channel spacing
        // after the call, so time spent waiting cannot consume that spacing.
        entry.finishedAt = Date.now();
      }
    });
    this.nextPost.set(thread.channelId, entry);
    return entry.result;
  }

  async downloadFile(id, maxBytes) {
    const { file } = await this.call("files.info", { file: id });
    const url = new URL(file?.url_private_download ?? file?.url_private ?? "about:blank");
    if (file?.id !== id || file.mode !== "hosted" || file.is_external ||
        url.protocol !== "https:" || url.hostname !== "files.slack.com" || url.username || url.password ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > maxBytes) {
      throw Object.assign(new Error("Slack attachment is unavailable or too large."), { code: "slack_file_unavailable" });
    }
    const response = await this.fetch(url.href, { redirect: "error", signal: this.fileSignal(),
      headers: { Authorization: `Bearer ${this.botToken}` } });
    if (!response.ok || !response.body || response.headers.get("content-type")?.startsWith("text/html")) {
      throw Object.assign(new Error("Slack attachment download failed."), { code: "slack_file_unavailable" });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes || size > file.size) throw Object.assign(new Error("Slack attachment is too large."), { code: "slack_file_unavailable" });
      chunks.push(chunk);
    }
    if (size !== file.size) throw Object.assign(new Error("Slack attachment download was incomplete."), { code: "slack_file_unavailable" });
    return { bytes: Buffer.concat(chunks), mimetype: file.mimetype };
  }

  fileSignal() {
    return AbortSignal.any([...(this.signal ? [this.signal] : []), AbortSignal.timeout(120_000)]);
  }

  async uploadFile(thread, { name, bytes }, allocated) {
    const { file_id: id, upload_url: uploadUrl } = await this.call("files.getUploadURLExternal", { filename: name, length: bytes.length });
    const url = new URL(uploadUrl ?? "about:blank");
    if (!/^F[A-Z0-9]+$/.test(id ?? "") || url.protocol !== "https:" || url.hostname !== "files.slack.com" ||
        url.username || url.password || !url.pathname.startsWith("/upload/")) {
      throw Object.assign(new Error("Slack returned an invalid upload target."), { code: "slack_file_unavailable" });
    }
    allocated(id);
    const response = await this.fetch(url.href, { method: "POST", redirect: "error", signal: this.fileSignal(),
      headers: { "Content-Type": "application/octet-stream" }, body: bytes });
    if (!response.ok) throw Object.assign(new Error("Slack file upload failed."), { code: "slack_file_unavailable" });
    await response.body?.cancel();
    await this.call("files.completeUploadExternal", { files: [{ id, title: name }], channel_id: thread.channelId, thread_ts: thread.threadTs });
    const { file } = await this.call("files.info", { file: id });
    const permalink = new URL(file?.permalink ?? "about:blank");
    if (file?.id !== id || permalink.protocol !== "https:" || !permalink.hostname.endsWith(".slack.com") || permalink.username || permalink.password) {
      throw Object.assign(new Error("Slack did not confirm the file link."), { code: "slack_file_unavailable" });
    }
    return { id, permalink: permalink.href };
  }

  async findDelivery(thread, key) {
    let cursor;
    do {
      const page = await this.call(thread.threadTs ? "conversations.replies" : "conversations.history", {
        channel: thread.channelId, ...(thread.threadTs ? { ts: thread.threadTs } : {}),
        limit: 100, include_all_metadata: true, ...(cursor ? { cursor } : {}),
      });
      const message = page.messages?.find((entry) => entry.user === this.botUserId && entry.metadata?.event_type === "dure_delivery" && entry.metadata.event_payload?.key === key);
      if (message) return message.ts;
      cursor = page.response_metadata?.next_cursor;
    } while (cursor);
    return null;
  }
}
