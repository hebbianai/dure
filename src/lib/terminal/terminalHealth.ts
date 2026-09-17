export type HmuxPaneHealthState =
  | "connecting"
  | "live"
  | "recovering"
  | "stale"
  | "error";

export interface HmuxPaneHealth {
  state: HmuxPaneHealthState;
  reason?: string;
  terminalEpoch?: string;
  receivedSequence?: string;
  presentedSequence?: string;
  updatedAt: number;
}

export function hmuxPaneHealthId(
  desktopId: string | undefined,
  paneId: string,
): string {
  return `${desktopId ?? "detached"}:${paneId}`;
}

export type HmuxPaneHealthObservation =
  | {
      kind: "connection";
      state: "connecting" | "recovering" | "error";
      reason?: string;
    }
  | {
      kind: "frame_received";
      terminalEpoch: string;
      sequence: string;
    }
  | {
      kind: "frame_presented";
      terminalEpoch: string;
      sequence: string;
    };

/** Reduce exact attachment observations into the pane's connection health. */
export function observeHmuxPaneHealth(
  previous: HmuxPaneHealth | undefined,
  observation: HmuxPaneHealthObservation,
  updatedAt = Date.now(),
): HmuxPaneHealth {
  if (observation.kind === "connection") {
    const retained = observation.state === "connecting" ? undefined : previous;
    return {
      state: observation.state,
      reason: observation.reason,
      terminalEpoch: retained?.terminalEpoch,
      receivedSequence: retained?.receivedSequence,
      presentedSequence: retained?.presentedSequence,
      updatedAt,
    };
  }

  const sameEpoch = previous?.terminalEpoch === observation.terminalEpoch;
  if (observation.kind === "frame_received") {
    return {
      state: "live",
      terminalEpoch: observation.terminalEpoch,
      receivedSequence: observation.sequence,
      presentedSequence: sameEpoch ? previous.presentedSequence : undefined,
      updatedAt,
    };
  }

  return {
    state: "live",
    terminalEpoch: observation.terminalEpoch,
    receivedSequence:
      sameEpoch && previous.receivedSequence
        ? previous.receivedSequence
        : observation.sequence,
    presentedSequence: observation.sequence,
    updatedAt,
  };
}

export function sameHmuxPaneHealth(
  left: HmuxPaneHealth | undefined,
  right: HmuxPaneHealth,
) {
  return (
    left?.state === right.state &&
    left.reason === right.reason &&
    left.terminalEpoch === right.terminalEpoch &&
    left.receivedSequence === right.receivedSequence &&
    left.presentedSequence === right.presentedSequence
  );
}
