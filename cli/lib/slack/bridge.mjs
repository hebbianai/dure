import { incomingSlackMessage, slackInput, slackKey } from "./event.mjs";
import { SlackPendingRequests } from "./pending.mjs";

// The conversation owns the failure reason. Only its known tokens become
// explanations; arbitrary provider details stay out of the shared thread.
const turnFailures = new Map([
  ["usage_limit", "This turn failed because the provider usage limit was reached."],
  ["rate_limit", "This turn failed because the provider rate limit was reached."],
  ["authentication_failed", "This turn failed because provider authentication failed."],
  ["context_window_exceeded", "This turn failed because the conversation exceeded the provider context limit."],
  ["provider_error", "This turn failed because the provider reported an error."],
  ["runtime_replaced", "This turn failed because its runtime was replaced."],
]);

function lifecycleMessage({ state, detail }) {
  if (state === "turn_failed") return turnFailures.get(detail) ?? "This turn failed.";
  if (state === "turn_canceled") return "This turn was canceled.";
  if (state === "session_failed") return "The agent session failed.";
  return null;
}

/** Socket Mode and Dure both feed this one conversation. No task selection,
 * runtime status, provider output or decision is invented by the transport. */
export class SlackBridge {
  constructor({ config, botUserId, journal, backend, slack, files }) {
    Object.assign(this, { config, botUserId, journal, backend, slack, files });
    this.pending = new SlackPendingRequests({ config, botUserId, journal, slack, publish: this.send.bind(this) });
  }

  accept(payload) {
    return this.journal.accept(incomingSlackMessage(payload, this.config, this.botUserId, this.journal.data.threads));
  }

  interact(payload) {
    return this.pending.accept(payload);
  }

  async conversation(thread) {
    const page = await this.backend.read(thread);
    if (!page.native && !thread.interactionSessionId) {
      thread.interactionSessionId = page.binding.interactionSessionId;
      thread.cursor ??= { epoch: page.binding.timelineEpoch, sequence: 0 };
      this.journal.save();
    }
    return page;
  }

  async receive(entry) {
    const { message } = entry;
    const thread = this.journal.data.threads[message.threadKey];
    if (message.files?.length && message.attachmentText === undefined && this.files) {
      if (!thread.backend) {
        thread.backend = await this.backend.bind(thread.route);
        this.journal.save();
      }
      message.attachmentText = await this.files.prepareInput(message, thread);
      this.journal.save();
    }
    if (!thread.agentId) {
      if (!thread.backend) {
        thread.backend = await this.backend.bind(thread.route);
        this.journal.save();
      }
      thread.agentId = await this.backend.start({ ...message, route: thread.route }, thread);
      entry.state = "delivered";
      this.journal.save();
      return;
    }
    if (!entry.intent) {
      const page = await this.conversation(thread);
      if (page.native) {
        entry.operation = "agent_runtime.native.input";
        entry.intent = { ...page.native.target, text: slackInput(message) };
      } else {
        entry.operation = page.activeTurn ? "agent_conversation.steer_turn" : "agent_conversation.start_turn";
        entry.intent = {
          schemaVersion: 1, interactionSessionId: page.binding.interactionSessionId,
          runtime: page.binding.runtime, turnId: page.activeTurn?.turnId ?? `slack-${message.key}`,
          clientMessageId: `slack-${message.key}`, input: slackInput(message), requestedAtMs: message.receivedAtMs,
        };
      }
      // A retry replays the exact intent even if the runtime or active turn
      // changed in the meantime. The conversation authority decides its fate.
      this.journal.save();
    }
    if (entry.operation === "agent_runtime.native.input") {
      // PTY writes have no replay contract. Persist uncertainty before writing;
      // reconnect may report this delivery but must never send it again.
      entry.state = "sending";
      this.journal.save();
    }
    if (await this.backend.deliver(thread, entry.intent, entry.operation) === "steer_unsupported") {
      // Only the common API's definitive refusal authorizes queueing. Persist
      // the next exact delivery before admission so reconnect cannot steer it
      // again or retarget it to a replacement conversation/runtime.
      const queuedId = `slack-queued-${message.key}`;
      entry.operation = "agent_conversation.enqueue_turn";
      entry.intent = { ...entry.intent, turnId: queuedId, clientMessageId: queuedId };
      this.journal.save();
      await this.backend.deliver(thread, entry.intent, entry.operation);
    }
    entry.state = "delivered";
    this.journal.save();
  }

  async publish(thread, item) {
    let content;
    if (item.body.type === "lifecycle") content = lifecycleMessage(item.body);
    else if (item.body.type === "message") {
      const { role, markdown } = item.body;
      if (!["user", "assistant"].includes(role) || !markdown?.trim()) return;
      if (role === "user" && Object.values(this.journal.data.inbox).some(({ message }) =>
        !message.pendingKey && message.threadKey === slackKey(thread.teamId, thread.channelId, thread.threadTs) &&
        [slackInput(message), slackInput(message, { initial: true })].includes(markdown))) return;
      content = role === "user" ? `Dure:\n${markdown}` : this.files ? await this.files.publish(thread, item.itemId, markdown) : markdown;
    }
    if (!content) return;
    await this.sendText(thread, [item.itemId], content);
  }

  async publishGoal(thread, goal) {
    // Older links have no goal sharing boundary. Begin at the current snapshot
    // without backfilling a goal that may predate the shared conversation.
    if (thread.goalRevision === undefined) {
      thread.goalRevision = goal?.revision ?? 0;
      return;
    }
    if (!goal || goal.revision <= thread.goalRevision) return;
    const status = {
      active: "Goal active.",
      paused: "Goal paused. Work already in progress may continue.",
      complete: "Goal marked complete.",
      failed: "Goal failed.",
    }[goal.status];
    await this.sendText(thread, ["goal", goal.revision], [status, goal.objective, goal.detail].filter(Boolean).join("\n\n"));
    thread.goalRevision = goal.revision;
  }

  async sendText(thread, identity, content) {
    const characters = Array.from(content);
    for (let offset = 0; offset < characters.length; offset += 3500) {
      const text = characters.slice(offset, offset + 3500).join("");
      const key = slackKey(thread.teamId, thread.channelId, thread.threadTs, ...identity, offset);
      await this.send(thread, key, text);
    }
  }

  async send(thread, key, text, blocks) {
    const previous = this.journal.data.outbound[key];
    if (previous?.failed) return;
    if (previous?.text === text && JSON.stringify(previous.blocks) === JSON.stringify(blocks) && previous.ts) return;
    let ts = previous?.ts;
    if (previous && !ts) ts = await this.slack.findDelivery(thread, key);
    this.journal.data.outbound[key] = { text, blocks, ts: ts ?? null };
    this.journal.save();
    try {
      const result = await this.slack.write(thread, text, key, ts, blocks);
      if (typeof result.ts !== "string") throw new Error("Slack did not confirm the message timestamp.");
      this.journal.data.outbound[key].ts = result.ts;
      this.journal.save();
    } catch (error) {
      this.journal.data.outbound[key].failed = true;
      this.journal.save();
      throw error;
    }
  }

  polls() {
    const inbox = new Map();
    for (const entry of Object.values(this.journal.data.inbox)) {
      const key = entry.message.threadKey;
      if (!inbox.has(key)) inbox.set(key, []);
      inbox.get(key).push(entry);
    }
    return Object.entries(this.journal.data.threads).map(([key, thread]) =>
      [`thread:${key}`, (onError) => this.advance(thread, inbox.get(key) ?? [], onError)]);
  }

  async tick(onError = () => {}) {
    await Promise.all(this.polls().map(([, poll]) => poll(onError)));
  }

  async advance(thread, entries, onError) {
    // Only this thread waits for its previous input. Other threads have their
    // own poll, while the connector bounds and owns all in-flight work.
    for (const entry of entries) {
      if (entry.state !== "queued") continue;
      try { await this.receive(entry); }
      catch (error) {
        entry.state = "failed";
        entry.errorCode = error.code ?? "slack_delivery_failed";
        this.journal.save();
        onError(error, entry.message.key);
        break;
      }
    }
    // Failed input is already a durable result. Project it with the same
    // outbound journal so reconnect cannot retry the request or its notice.
    for (const { state, message } of entries) {
      if (!["failed", "sending"].includes(state) || message.pendingKey) continue;
      try {
        await this.send(thread, slackKey(message.key, "delivery_failed"),
          "Dure could not confirm this request was applied. It has not been retried automatically.");
      } catch (error) { onError(error, message.key); }
    }
    if (!thread.agentId) return;
    try {
      const page = await this.conversation(thread);
      if (!page.native) await this.pending.sync(thread, page);
      for (const row of page.rows) await this.publish(thread, row.item);
      await this.publishGoal(thread, page.goal);
      if (page.native) {
        if (page.native.publishable) thread.nativeCursor = page.native.cursor;
      } else thread.cursor = page.finalCursor;
      this.journal.save();
    } catch (error) { onError(error); }
  }
}
