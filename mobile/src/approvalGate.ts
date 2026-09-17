/**
 * Face ID before the first input this phone sends while the attached agent
 * is waiting for an approval — once per approval.
 *
 * The gate sits on the terminal surface's one outbound funnel, so every key,
 * typed character, pasted line and trackpad step passes through the same
 * decision. It holds no timer and no cache beyond the id of the approval it
 * last proved: that id is the identity of the approval being answered, which
 * is exactly what "once per approval" needs.
 *
 * One authority, for later: `device_identity.rs` plans an LAContext policy on
 * the Secure-Enclave signing key. When that ships, this UI-side gate must be
 * folded into the key's own biometric policy rather than kept as a second
 * guard in front of it.
 */

import { type AgentRuntimeState, approvalIdentity } from "./agentRuntimeState";
import type { BiometricCheck } from "./biometricLock";

export interface ApprovalGate {
  /** The agent's latest runtime state, as the relay sent it. */
  observe(state: AgentRuntimeState): void;
  /**
   * Sends now, or after the owner proves themself — in the order the sends
   * arrived. A refused or dismissed sheet drops what was waiting: nothing
   * this phone did not mean to send reaches the approval.
   */
  admit(send: () => void): void;
  /** A new attachment: forget the approval, the queue and any sheet still up. */
  reset(): void;
}

export interface ApprovalGateOptions {
  /** Read on every admit — the preference can change while a session is open. */
  readonly enabled: () => boolean;
  /** Shows the sheet. Never expected to throw; a throw counts as a failed check. */
  readonly confirm: () => Promise<BiometricCheck>;
  /** Once per sheet that did not pass, after the queue has been dropped — with how it did not. */
  readonly refused: (check: Exclude<BiometricCheck, "passed">) => void;
}

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  /** The approval the agent is waiting on right now, or none. */
  let pending: string | undefined;
  /** The one approval this phone has already proven its owner for. */
  let proven: string | undefined;
  let queue: (() => void)[] = [];
  let prompting = false;
  /** Bumped by `reset` so a sheet answered after it releases nothing. */
  let generation = 0;

  const settle = (id: string, check: BiometricCheck) => {
    prompting = false;
    const waiting = queue;
    queue = [];
    if (check === "passed") {
      proven = id;
      for (const send of waiting) send();
      return;
    }
    options.refused(check);
  };

  return {
    observe(state) {
      pending = approvalIdentity(state);
    },
    admit(send) {
      // A sheet is up: everything waits behind it, in order — even input the
      // agent no longer needs proven, or it would overtake what came first.
      if (prompting) {
        queue.push(send);
        return;
      }
      if (!options.enabled() || pending === undefined || pending === proven) {
        send();
        return;
      }
      const id = pending;
      const opened = generation;
      queue.push(send);
      prompting = true;
      options.confirm().then(
        (check) => {
          if (opened === generation) settle(id, check);
        },
        () => {
          if (opened === generation) settle(id, "failed");
        },
      );
    },
    reset() {
      generation += 1;
      pending = undefined;
      proven = undefined;
      queue = [];
      prompting = false;
    },
  };
}
