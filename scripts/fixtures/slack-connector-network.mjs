// Explicit QA preload. Restrict replacement to the connector so native QA can
// pass it through NODE_OPTIONS without changing its launcher or client network.
if (process.argv[2] === "slack" && process.argv[3] === "serve") {
  globalThis.fetch = async (url) => {
    if (url === "https://slack.com/api/auth.test") {
      return Response.json({ ok: true, team_id: "T1", bot_id: "B1", user_id: "U0" });
    }
    if (url === "https://slack.com/api/apps.connections.open") {
      return Response.json({ ok: true, url: "wss://wss.slack.com/fixture" });
    }
    throw new Error("Unexpected network request in Slack lifetime fixture");
  };

  globalThis.WebSocket = class extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: '{"type":"hello"}' })));
    }
    send() { throw new Error("The lifetime fixture does not receive channel events"); }
    close() { this.dispatchEvent(new Event("close")); }
  };
}
