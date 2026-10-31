/** Explains a wake the Host did not write yet, from the receipt's typed wake
 * state. The backend retries the wake prompt; the message itself is never resent. */
export function deferredWake(deliveries) {
  const wake = Array.isArray(deliveries)
    ? deliveries.find((delivery) => delivery?.wake?.state === "queued_until_next_turn")?.wake
    : undefined;
  if (!wake) return null;
  return {
    reason: "wake_deferred",
    wakeReasonCode: wake.reasonCode ?? null,
    message: wake.reasonCode === "hmux_input_draft_pending"
      ? "The target has unsubmitted input at its prompt, so no wake prompt was written yet. Dure retries the wake for up to 24 hours once that input is submitted or erased; the message stays in the inbox."
      : "The target was not idle at its prompt, so no wake prompt was written yet. Dure retries the wake for up to 24 hours once it is idle or a person interrupts its turn with Esc; the message stays in the inbox.",
  };
}
