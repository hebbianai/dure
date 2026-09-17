import { collectAgentRun, defaultAgentRunName } from "../agent-run.mjs";
import { performBackendProfileRequest } from "../backend-transport.mjs";
import { nativeSlackPage, nativeSlackTarget } from "./native.mjs";
import { slackInput } from "./event.mjs";

export class DureSlackBackend {
  constructor(resolveBackend, { defaultBackend, signal, requestBackend = performBackendProfileRequest, presentRun, onPresentationError } = {}) {
    this.resolveBackend = resolveBackend;
    this.defaultBackend = defaultBackend;
    this.routes = new Map();
    this.presentRun = presentRun;
    this.onPresentationError = onPresentationError;
    this.request = (profile, request, options) => requestBackend(profile, {
      ...request, scopeId: profile.expected.scopeId,
      requiredCapabilities: [...(request.requiredCapabilities ?? []), "plugin.slack", "backend.scope.v1"],
    }, { ...options, signal });
  }

  async select(profileId = this.defaultBackend) {
    if (!this.routes.has(profileId)) {
      this.routes.set(profileId, Promise.resolve().then(async () => {
        const route = await this.resolveBackend({ backend: profileId, backendSpecified: profileId !== undefined });
        if (route.error) throw route.error;
        if (!this.routes.has(route.profile.id)) this.routes.set(route.profile.id, Promise.resolve(route));
        return route;
      }));
    }
    return this.routes.get(profileId);
  }

  async bind(route) {
    const { profile, transportOptions } = await this.select(route.backend);
    const response = await this.request(profile, { operation: "backend.scope", body: { schemaVersion: 1 } }, transportOptions);
    const scopeId = response.result?.scopeId;
    if (typeof scopeId !== "string" || !scopeId) {
      throw Object.assign(new Error("Dure did not identify the backend that owns this task."), { code: "slack_backend_scope_missing" });
    }
    return { profileId: profile.id, backendId: profile.expected.backendId, scopeId };
  }

  async target(thread) {
    if (!thread.backend.scopeId) {
      throw Object.assign(new Error("This older Slack link has no saved server identity. Share the task again from its original Dure server."), { code: "slack_backend_scope_missing" });
    }
    const route = await this.select(thread.backend.profileId);
    // Carry the saved identity in the actual transport request so repointing
    // a profile cannot redirect an existing task to a different backend.
    return { ...route, profile: { ...route.profile, expected: {
      ...route.profile.expected, backendId: thread.backend.backendId, scopeId: thread.backend.scopeId,
    } } };
  }

  async call(thread, operation, body) {
    const backend = await this.target(thread);
    const response = await this.request(backend.profile, { operation, body }, {
      ...backend.transportOptions, deadlineMs: 185_000, maxResponseBytes: 2 * 1024 * 1024,
    });
    return response.result;
  }

  async start(message, thread) {
    const backend = await this.target(thread);
    const idempotencyKey = `slack-${message.threadKey}`;
    const { report, presentationProject } = await collectAgentRun({
      projectId: message.route.projectId, providerId: message.route.providerId,
      agentName: defaultAgentRunName(message.route.providerId, idempotencyKey),
      prompt: slackInput(message, { initial: true }), idempotencyKey,
      worktree: { kind: "dedicated", branch: `slack/${message.threadKey.slice(0, 16)}` },
      includePresentationProject: this.presentRun !== undefined,
      backend, requestBackend: this.request,
    });
    if (report.receipt?.state !== "succeeded") {
      throw Object.assign(new Error(`Dure has not confirmed the Slack task launch (${report.receipt?.state ?? report.error?.code ?? "unavailable"}).`), { code: report.error?.code ?? "slack_task_launch_failed" });
    }
    if (this.presentRun) {
      try {
        await this.presentRun({ report, profile: backend.profile, projectPath: presentationProject?.root, message });
      } catch (error) {
        // A client projection failure does not change a successfully created
        // task. Surface that result separately, without spawning again.
        this.onPresentationError?.(error, report.receipt.plan.agentId);
      }
    }
    return report.receipt.plan.agentId;
  }

  async native(thread) {
    const snapshot = await this.call(thread, "agent_runtime.projection.inspect", { schemaVersion: 1, agentId: thread.agentId });
    return nativeSlackTarget(snapshot, thread.agentId);
  }

  async tail(thread) {
    const native = await this.native(thread);
    if (native) return nativeSlackPage(await this.call(thread, "agent_runtime.native.read", native), native);

    const { binding } = await this.call(thread, "agent_conversation.inspect", { schemaVersion: 1, agentId: thread.agentId });
    if (!binding) throw new Error("The Slack task does not have a conversation binding yet.");
    const { read } = await this.call(thread, "agent_conversation.read", {
      schemaVersion: 1, interactionSessionId: binding.interactionSessionId, direction: "tail", limit: 1,
    });
    if (read?.type !== "page") throw new Error("Dure could not establish the conversation to share.");
    return read.page;
  }

  async read(thread) {
    const native = await this.native(thread);
    if (native) {
      const snapshot = await this.call(thread, "agent_runtime.native.read", { ...native, after: thread.nativeCursor ?? null });
      return nativeSlackPage(snapshot, native, thread.nativeCursor);
    }

    let interactionSessionId = thread.interactionSessionId;
    let cursor = thread.cursor;
    if (!interactionSessionId) {
      const { binding } = await this.call(thread, "agent_conversation.inspect", { schemaVersion: 1, agentId: thread.agentId });
      if (!binding) throw new Error("The Slack task does not have a conversation binding yet.");
      interactionSessionId = binding.interactionSessionId;
      cursor ??= { epoch: binding.timelineEpoch, sequence: 0 };
    }
    const { read } = await this.call(thread, "agent_conversation.read", {
      schemaVersion: 1, interactionSessionId, direction: "after", cursor, limit: 100,
    });
    if (read?.type !== "page") throw new Error("The task conversation changed; reconnect its exact binding in Dure.");
    return read.page;
  }

  async deliver(thread, intent, operation) {
    const { receipt } = await this.call(thread, operation, intent);
    if (operation === "agent_runtime.native.input") {
      if (receipt?.terminalEpoch !== intent.expectedTerminalEpoch ||
          receipt.state !== "written_to_pty") {
        throw Object.assign(new Error("Dure could not confirm terminal input delivery."), { code: "slack_task_input_failed" });
      }
      return;
    }
    const expected = operation === "agent_conversation.answer_pending" ? "succeeded" : "accepted";
    if (receipt?.state !== expected) {
      throw Object.assign(new Error(`Dure has not confirmed message delivery (${receipt?.state ?? "unavailable"}).`), { code: "slack_task_input_failed" });
    }
  }
}
