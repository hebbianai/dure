import { randomUUID } from "node:crypto";
import { requestAppControl } from "./app-control-client.mjs";

/** The registry selects a conversation; the owning frontend revalidates it.
 * Submitted input targets that conversation; only drafts require a pane.
 * A lost or mismatched receipt is never retried automatically. */
export async function sendStructuredAgentInput({
  agent, text, enter, windowLabel, idempotencyKey = randomUUID(), descriptor,
}) {
  const profile = agent.interactionProfile;
  const domainId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
  if (!profile || profile.schemaVersion !== 1 || profile.kind !== "structured_protocol" ||
      typeof profile.backendProfileId !== "string" || !domainId.test(profile.backendProfileId) ||
      typeof profile.interactionSessionId !== "string" || !domainId.test(profile.interactionSessionId)) {
    throw new Error("The structured interaction projection is invalid; refresh the selected agent.");
  }
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(idempotencyKey)) {
    throw new Error("--idempotency-key must contain 1–128 letters, digits, dots, underscores or hyphens.");
  }
  const submit = enter !== false;
  try {
    const response = await requestAppControl({
      descriptor, path: "/agent/input",
      body: {
        name: agent.id, sessionId: agent.sessionId,
        expectedInteractionProfile: {
          schemaVersion: 1, kind: "structured_protocol",
          backendProfileId: profile.backendProfileId,
          interactionSessionId: profile.interactionSessionId,
        },
        text, enter: submit, idempotencyKey,
        ...(windowLabel !== undefined ? { windowLabel } : {}),
      },
    });
    const input = response.input;
    if (input?.agentId !== agent.id ||
        (!submit && (typeof input?.panelId !== "string" || !input.panelId || input.panelId.length > 512)) ||
        input?.sessionId !== profile.interactionSessionId || input?.enter !== submit ||
        input?.byteLength !== Buffer.byteLength(text, "utf8") + Number(submit) ||
        input?.receipt?.kind !== "structured_chat" ||
        !(submit ? ["sent", "steered", "queued"] : ["drafted"]).includes(input.receipt.delivery)) {
      throw new Error("Invalid structured input receipt; delivery is uncertain and was not retried.");
    }
    return input;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} (idempotency key: ${idempotencyKey})`, { cause: error });
  }
}
