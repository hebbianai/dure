import { presentPendingAnswer } from "../contracts/agent-pending-presentation.mjs";
import { slackKey } from "./event.mjs";
import { canAnswerQuestions, pendingMessage, pendingModal, pendingPresentation, pendingSubmission } from "./pending-view.mjs";

/** Pending entries are display snapshots and exact answer delivery targets.
 * The conversation authority alone accepts answers and resolves requests. */
export class SlackPendingRequests {
  constructor({ config, botUserId, journal, slack, publish }) {
    Object.assign(this, { config, botUserId, journal, slack, publish });
    this.journal.data.pending ??= {};
  }

  async sync(thread, page) {
    const threadKey = slackKey(thread.teamId, thread.channelId, thread.threadTs);
    const active = new Set();
    const remember = (pending) => {
      const { request, runtime, interactionSessionId } = pending;
      const key = slackKey(threadKey, interactionSessionId, runtime, request.requestId);
      this.journal.data.pending[key] ??= { key, threadKey,
        target: { schemaVersion: 1, interactionSessionId, runtime, requestId: request.requestId, clientMessageId: request.clientMessageId },
        presentation: pendingPresentation(request) };
      return this.journal.data.pending[key];
    };
    for (const pending of page.pendingRequests ?? []) active.add(remember(pending).key);
    for (const { item } of page.rows ?? []) {
      if (item.body.type !== "pending_answer") continue;
      const { request, answer, idempotency_key: idempotencyKey } = item.body;
      remember(request).completion = { idempotencyKey, answer: presentPendingAnswer(request.request, answer) };
    }
    for (const entry of Object.values(this.journal.data.pending)) {
      if (entry.threadKey !== threadKey) continue;
      entry.resolved = !active.has(entry.key);
      this.journal.save();
      const attempts = Object.values(this.journal.data.inbox).filter(({ message }) => message.pendingKey === entry.key);
      const { text, blocks } = pendingMessage(entry, attempts);
      await this.publish(thread, entry.key, text, blocks);
    }
  }

  accept(payload) {
    if (payload?.team?.id !== this.config.teamId || !/^[UW][A-Z0-9]+$/.test(payload.user?.id ?? "")) return {};
    const submission = payload.type === "view_submission" && payload.view?.callback_id === "dure.pending.answer";
    const action = payload.type === "block_actions" ? payload.actions?.[0] : undefined;
    if (!submission && !["dure.pending.open", "dure.pending.allow", "dure.pending.deny"].includes(action?.action_id)) return {};
    const entry = this.journal.data.pending[submission ? payload.view.private_metadata : action.value];
    if (!entry) return {};
    const thread = this.journal.data.threads[entry.threadKey];
    if (!thread || !this.config.channels.some((route) => route.channelId === thread.channelId)) return {};
    if (!submission && (payload.container?.channel_id !== thread.channelId ||
        payload.container.message_ts !== this.journal.data.outbound[entry.key]?.ts || payload.message?.user !== this.botUserId)) return {};
    if (action?.action_id === "dure.pending.open") {
      if (!canAnswerQuestions(entry.presentation)) return {};
      return { run: async () => {
        try { await this.slack.call("views.open", { trigger_id: payload.trigger_id, view: pendingModal(entry) }); }
        catch (error) {
          await this.slack.call("chat.postEphemeral", { channel: thread.channelId, user: payload.user.id, text: "Dure could not open this question. Please try opening it again." }).catch(() => {});
          throw error;
        }
      } };
    }
    let answer;
    if (submission) {
      if (!canAnswerQuestions(entry.presentation)) return {};
      const result = pendingSubmission(entry, payload.view.state?.values);
      if (!result.answer) return { response: { response_action: "errors", errors: result.errors } };
      answer = result.answer;
    } else {
      if (action.action_id === "dure.pending.allow" && entry.presentation.kind !== "permission") return {};
      answer = { decision: action.action_id === "dure.pending.allow" ? "allow" : "deny" };
    }
    const sourceId = submission ? payload.view.id : action.action_ts;
    if (typeof sourceId !== "string" || !sourceId) return {};
    const key = slackKey(this.config.teamId, payload.user.id, entry.key, sourceId);
    const receivedAtMs = Date.now();
    const userName = payload.user.name ?? payload.user.username;
    this.journal.accept({ key, threadKey: entry.threadKey, pendingKey: entry.key,
      teamId: thread.teamId, channelId: thread.channelId, threadTs: thread.threadTs,
      userId: payload.user.id, receivedAtMs,
      ...(typeof userName === "string" && userName.trim() ? { userName } : {}),
    }, { operation: "agent_conversation.answer_pending", intent: { ...entry.target,
      idempotencyKey: `slack-${key}`, answer, requestedAtMs: receivedAtMs } });
    return {};
  }
}
