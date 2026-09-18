import { slackKey } from "./event.mjs";

const failure = (code) => Object.assign(new Error("Dure could not share this task in Slack."), { code });

function requireConversation(request, interactionSessionId) {
  if (request.interactionSessionId !== undefined && request.interactionSessionId !== interactionSessionId) {
    throw failure("slack_share_conversation_changed");
  }
}

/** Sharing creates a delivery link to an existing conversation. It never
 * launches an agent or copies the conversation's earlier messages. */
export class SlackShares {
  constructor({ config, journal, backend, slack }) {
    Object.assign(this, { config, journal, backend, slack });
    this.inFlight = new Map();
    this.requests = new Map();
    this.journal.data.shares ??= {};
  }

  async share(request) {
    if (request?.schemaVersion !== 1 || request.teamId !== this.config.teamId ||
        ![request.requestId, request.agentId, request.channelId].every((value) => typeof value === "string" && value.length > 0) ||
        (request.interactionSessionId !== undefined && (typeof request.interactionSessionId !== "string" || !request.interactionSessionId))) {
      throw failure("slack_share_request_invalid");
    }
    const route = this.config.channels.find((entry) => entry.channelId === request.channelId);
    if (!route) throw failure("slack_channel_not_connected");
    const key = slackKey(request.teamId, request.requestId);
    const fingerprint = slackKey(request.channelId, request.agentId, request.backend ?? null,
      ...(request.interactionSessionId === undefined ? [] : [request.interactionSessionId]));
    const previous = this.journal.data.shares[key];
    const running = this.requests.get(key);
    if ((previous && previous.fingerprint !== fingerprint) || (running && running.fingerprint !== fingerprint)) throw failure("slack_share_request_conflict");
    if (running) return running.work;
    const work = this.resolve({ key, fingerprint, route, request, previous });
    this.requests.set(key, { fingerprint, work });
    void work.finally(() => this.requests.delete(key)).catch(() => {});
    return work;
  }

  async resolve({ key, fingerprint, route, request, previous }) {
    if (previous && previous.state !== "posting") return this.resume(previous);
    const backend = previous?.thread.backend ?? await this.backend.bind({ ...route, backend: request.backend ?? route.backend });
    const targetKey = slackKey(request.channelId, request.agentId, backend.scopeId);
    if (!this.inFlight.has(targetKey)) {
      const work = this.run({ key, fingerprint, route, backend, request, previous });
      this.inFlight.set(targetKey, work);
      void work.finally(() => this.inFlight.delete(targetKey)).catch(() => {});
    }
    const result = await this.inFlight.get(targetKey);
    requireConversation(request, result.interactionSessionId);
    if (!this.journal.data.shares[key]) {
      const thread = this.journal.data.threads[slackKey(result.teamId, result.channelId, result.threadTs)];
      this.journal.data.shares[key] = { key, fingerprint, request, thread, state: "succeeded" };
      this.journal.save();
    }
    return result;
  }

  async run({ key, fingerprint, route, backend, request, previous }) {
    if (previous) return this.resume(previous);
    const sameTask = (thread) => thread.channelId === request.channelId && thread.agentId === request.agentId && thread.backend?.scopeId === backend.scopeId;
    const linked = Object.values(this.journal.data.threads).find(sameTask);
    if (linked) return this.receipt(linked);
    const interrupted = Object.values(this.journal.data.shares).find((entry) => entry.state === "posting" && sameTask(entry.thread));
    if (interrupted) return this.resume(interrupted);
    const thread = { teamId: request.teamId, channelId: request.channelId, agentId: request.agentId, backend, route };
    const page = await this.backend.tail(thread);
    if (page.native) {
      requireConversation(request, undefined);
      thread.nativeCursor = page.native.cursor;
    } else {
      requireConversation(request, page.binding.interactionSessionId);
      thread.interactionSessionId = page.binding.interactionSessionId;
      thread.cursor = page.finalCursor;
    }
    thread.goalRevision = page.goal?.revision ?? 0;
    const entry = { key, fingerprint, request, thread, state: "posting" };
    this.journal.data.shares[key] = entry;
    this.journal.save();
    try {
      const result = await this.slack.write(thread, "This Dure task is now shared here. Mention @Dure in this thread to continue the work together. Untagged messages are saved as context for your next mention without starting or steering work.", key);
      return this.complete(entry, result.ts);
    } catch (error) { return this.failed(entry, error); }
  }

  receipt(thread) {
    return { state: "succeeded", teamId: thread.teamId, channelId: thread.channelId, threadTs: thread.threadTs,
      agentId: thread.agentId, backend: thread.backend, interactionSessionId: thread.interactionSessionId };
  }

  complete(entry, ts) {
    if (typeof ts !== "string" || !/^\d+\.\d+$/.test(ts)) throw failure("slack_share_unconfirmed");
    entry.thread.threadTs = ts;
    this.journal.data.threads[slackKey(entry.thread.teamId, entry.thread.channelId, ts)] = entry.thread;
    entry.state = "succeeded";
    this.journal.save();
    return this.receipt(entry.thread);
  }

  failed(entry, error) {
    entry.state = "failed";
    entry.errorCode = error.code ?? "slack_share_failed";
    this.journal.save();
    throw failure(entry.errorCode);
  }

  async resume(entry) {
    if (entry.state === "succeeded") return this.receipt(entry.thread);
    if (entry.state === "failed") throw failure(entry.errorCode);
    try {
      const ts = await this.slack.findDelivery(entry.thread, entry.key);
      if (!ts) throw failure("slack_share_unconfirmed");
      return this.complete(entry, ts);
    } catch (error) { return this.failed(entry, error); }
  }

  polls() {
    return Object.values(this.journal.data.shares)
      .filter((entry) => entry.state === "posting")
      .map((entry) => [`share:${entry.key}`, async (onError) => {
        try { await this.share(entry.request); }
        catch (error) { onError(error, entry.key); }
      }]);
  }

  async reconcile(onError) {
    await Promise.all(this.polls().map(([, poll]) => poll(onError)));
  }
}
