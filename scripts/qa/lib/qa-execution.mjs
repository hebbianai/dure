const TOKEN = /^[a-z][a-z0-9_]{0,47}$/;
const MAX_PHASES = 16;
const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;

function requireToken(value, name) {
  if (typeof value !== "string" || !TOKEN.test(value)) {
    throw new Error(`${name} must be a lowercase QA token`);
  }
  return value;
}

function boundedDuration(value) {
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  return Math.min(value, MAX_DURATION_MS);
}

export class QaExecutionTimeline {
  constructor(layer, now = Date.now) {
    this.layer = requireToken(layer, "QA execution layer");
    this.now = now;
    this.currentPhase = undefined;
    this.currentPhaseStartedAtMs = undefined;
    this.phaseDurationsMs = {};
    this.failureClass = undefined;
  }

  begin(phase) {
    const resolved = requireToken(phase, "QA execution phase");
    this.complete();
    if (
      !(resolved in this.phaseDurationsMs) &&
      Object.keys(this.phaseDurationsMs).length >= MAX_PHASES
    ) {
      throw new Error(`QA execution cannot record more than ${MAX_PHASES} phases`);
    }
    this.currentPhase = resolved;
    this.currentPhaseStartedAtMs = this.now();
  }

  complete() {
    if (
      this.currentPhase === undefined ||
      this.currentPhaseStartedAtMs === undefined
    ) {
      return;
    }
    const elapsed = boundedDuration(
      Math.max(0, this.now() - this.currentPhaseStartedAtMs),
    );
    if (elapsed !== undefined) {
      this.phaseDurationsMs[this.currentPhase] =
        (this.phaseDurationsMs[this.currentPhase] ?? 0) + elapsed;
    }
    this.currentPhase = undefined;
    this.currentPhaseStartedAtMs = undefined;
  }

  fail(failureClass) {
    this.complete();
    this.failureClass ??= requireToken(
      failureClass,
      "QA execution failure class",
    );
  }

  snapshot() {
    const currentPhaseElapsedMs =
      this.currentPhaseStartedAtMs === undefined
        ? undefined
        : boundedDuration(
            Math.max(0, this.now() - this.currentPhaseStartedAtMs),
          );
    return {
      schemaVersion: 1,
      layer: this.layer,
      phaseDurationsMs: { ...this.phaseDurationsMs },
      ...(this.currentPhase
        ? {
            currentPhase: this.currentPhase,
            currentPhaseElapsedMs,
          }
        : {}),
      ...(this.failureClass ? { failureClass: this.failureClass } : {}),
    };
  }

  decorate(status) {
    return {
      ...status,
      qaExecution: this.snapshot(),
    };
  }
}

export function sanitizeQaExecution(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.schemaVersion !== 1 ||
    typeof value.layer !== "string" ||
    !TOKEN.test(value.layer) ||
    !value.phaseDurationsMs ||
    typeof value.phaseDurationsMs !== "object" ||
    Array.isArray(value.phaseDurationsMs)
  ) {
    return undefined;
  }
  const phases = Object.entries(value.phaseDurationsMs);
  if (
    phases.length > MAX_PHASES ||
    phases.some(
      ([phase, duration]) =>
        !TOKEN.test(phase) || boundedDuration(duration) === undefined,
    )
  ) {
    return undefined;
  }
  if (
    value.currentPhase !== undefined &&
    (typeof value.currentPhase !== "string" ||
      !TOKEN.test(value.currentPhase) ||
      boundedDuration(value.currentPhaseElapsedMs) === undefined)
  ) {
    return undefined;
  }
  if (
    value.failureClass !== undefined &&
    (typeof value.failureClass !== "string" ||
      !TOKEN.test(value.failureClass))
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    layer: value.layer,
    phaseDurationsMs: Object.fromEntries(phases),
    ...(value.currentPhase
      ? {
          currentPhase: value.currentPhase,
          currentPhaseElapsedMs: value.currentPhaseElapsedMs,
        }
      : {}),
    ...(value.failureClass ? { failureClass: value.failureClass } : {}),
  };
}
