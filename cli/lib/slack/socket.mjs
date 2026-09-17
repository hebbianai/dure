export async function consumeSlackSocket({ url, bridge, signal, onConnected = () => {}, onDisconnected = () => {}, onError = () => {}, WebSocketImpl = globalThis.WebSocket }) {
  if (signal.aborted) return;
  const parsed = new URL(url);
  if (parsed.protocol !== "wss:" || !parsed.hostname.endsWith(".slack.com") || parsed.username || parsed.password) {
    throw new Error("Slack returned an invalid Socket Mode URL.");
  }
  if (!WebSocketImpl) throw new Error("The Slack connector requires Node.js 22 or newer.");
  const interactions = new Set();
  try { await new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", close);
      socket.removeEventListener("message", receive);
      onDisconnected();
      if (error) reject(error); else resolve();
      socket.close();
    };
    const close = () => finish();
    signal.addEventListener("abort", close, { once: true });
    socket.addEventListener("close", () => finish(signal.aborted ? undefined : new Error("Slack Socket Mode disconnected.")), { once: true });
    socket.addEventListener("error", () => finish(new Error("Slack Socket Mode disconnected.")), { once: true });
    const receive = (message) => {
      try {
        const envelope = JSON.parse(message.data);
        if (envelope.type === "hello") return onConnected();
        if (envelope.type === "disconnect") return close();
        if (!envelope.envelope_id) return;
        if (envelope.type === "events_api") bridge.accept(envelope.payload);
        const interaction = envelope.type === "interactive" ? bridge.interact(envelope.payload) : undefined;
        // Persist before acknowledgement. Provider launch never delays Slack's
        // envelope acknowledgement and duplicate events remain harmless.
        socket.send(JSON.stringify({ envelope_id: envelope.envelope_id,
          ...(envelope.accepts_response_payload && interaction?.response ? { payload: interaction.response } : {}) }));
        if (interaction?.run) {
          const work = interaction.run().catch(onError);
          interactions.add(work);
          void work.finally(() => interactions.delete(work)).catch(() => {});
        }
      } catch {
        finish(new Error("Slack event could not be recorded; its envelope was not acknowledged."));
      }
    };
    socket.addEventListener("message", receive);
    if (signal.aborted) close();
  }); } finally { await Promise.allSettled([...interactions]); }
}

export async function runSlackSocket({ slack, bridge, signal, onConnecting = () => {}, onConnected, onDisconnected, onError, WebSocketImpl }) {
  while (!signal.aborted) {
    onConnecting();
    const { url } = await slack.call("apps.connections.open");
    // Only Slack's explicit disconnect/refresh resumes here. Transport and
    // API failures propagate to the connector owner without a retry ladder.
    await consumeSlackSocket({ url, bridge, signal, onConnected, onDisconnected, onError, WebSocketImpl });
  }
}
