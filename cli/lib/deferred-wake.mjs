/** Explains a wake the Host did not write, from the receipt's typed wake
 * state. The message stays in the inbox either way; nothing is resent. */
export function deferredWake(deliveries) {
  const wake = Array.isArray(deliveries)
    ? deliveries.find((delivery) => delivery?.wake?.state === "queued_until_next_turn")?.wake
    : undefined;
  if (!wake) return null;
  return {
    reason: "wake_deferred",
    wakeReasonCode: wake.reasonCode ?? null,
    message: wake.reasonCode === "hmux_input_draft_pending"
      ? "The target has unsubmitted input at its prompt, so no wake prompt was written. The agent reads this message after that input is submitted."
      : "The target was not idle at its prompt, so no wake prompt was written. The agent reads this message on its next turn.",
  };
}
