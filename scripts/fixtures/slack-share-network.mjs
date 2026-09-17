// Only the installed connector receives fixture Slack responses. Provider and
// native backend traffic keep their normal transport.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

if (process.argv[2] === "slack" && process.argv[3] === "serve") {
  const home = fs.realpathSync(process.env.HOME);
  assert.equal(path.basename(home), "home");
  assert.ok(path.basename(path.dirname(home)).startsWith("dure-slack-share."));
  const file = path.join(home, "slack-share-posts.jsonl");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  let sequence = 0;
  globalThis.fetch = async (url, options) => {
    const method = String(url).replace("https://slack.com/api/", "");
    if (method === "auth.test") return Response.json({ ok: true, team_id: "T1", bot_id: "B1", user_id: "U0" });
    if (method === "apps.connections.open") return Response.json({ ok: true, url: "wss://wss.slack.com/fixture" });
    if (["chat.postMessage", "chat.update"].includes(method)) {
      const body = JSON.parse(options.body);
      assert.equal(body.channel, "C1");
      const ts = body.ts ?? `200.${String(++sequence).padStart(6, "0")}`;
      fs.appendFileSync(file, `${JSON.stringify({ method, body, ts })}\n`);
      return Response.json({ ok: true, ts, channel: "C1" });
    }
    throw new Error(`Unexpected Slack sharing fixture request: ${method}`);
  };
  globalThis.WebSocket = class extends EventTarget {
    constructor() {
      super();
      const inbox = path.join(home, "slack-share-inbound.json");
      this.inbox = inbox;
      let delivered;
      fs.watchFile(inbox, { interval: 100 }, () => {
        if (!fs.existsSync(inbox)) return;
        const data = fs.readFileSync(inbox, "utf8");
        if (data === delivered) return;
        delivered = data;
        this.dispatchEvent(new MessageEvent("message", { data }));
      });
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: '{"type":"hello"}' })));
    }
    send(value) { assert.ok(JSON.parse(value).envelope_id); }
    close() { fs.unwatchFile(this.inbox); this.dispatchEvent(new Event("close")); }
  };
}
