import { setTimeout as delay } from "node:timers/promises";

export class SlackApi {
  constructor({ botToken, appToken, signal, fetchApi = fetch }) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.signal = signal;
    this.fetch = fetchApi;
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
    const response = await this.fetch(`https://slack.com/api/${method}`, {
      method: "POST", redirect: "error", signal: AbortSignal.any([...(this.signal ? [this.signal] : []), AbortSignal.timeout(30_000)]),
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${method === "apps.connections.open" ? this.appToken : this.botToken}` },
      body: JSON.stringify(body),
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
