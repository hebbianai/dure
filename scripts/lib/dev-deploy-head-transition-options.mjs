export const HEAD_TRANSITION_MODE = Object.freeze({
  INTEGRATED_TARGET: "integrated_target",
  RETIRE_PRESERVED_HEAD: "retire_preserved_head",
});

const MAX_AUDIT_TEXT_BYTES = 4_096;
const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEPLOY_ARGUMENTS_WITH_VALUES = new Set([
  "--port",
  "--verify-timeout",
  "--live-worktree",
  "--retire-reason",
  "--retire-evidence",
  "--retire-wip-ref",
]);

function assignOnce(values, field, value, option) {
  if (values[field] !== undefined) {
    throw new Error(`${option} may only be specified once`);
  }
  if (value === undefined) throw new Error(`${option} requires a value`);
  values[field] = value;
}

export function assertHeadTransitionAuditText(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be non-empty text`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_AUDIT_TEXT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_AUDIT_TEXT_BYTES} bytes`);
  }
}

export function resolveHeadTransitionRequest(args) {
  let integratedTarget = false;
  let retirePreservedHead = false;
  const values = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--adopt-integrated-target") {
      if (integratedTarget) {
        throw new Error("--adopt-integrated-target may only be specified once");
      }
      integratedTarget = true;
    } else if (argument === "--retire-preserved-live-head") {
      if (retirePreservedHead) {
        throw new Error(
          "--retire-preserved-live-head may only be specified once",
        );
      }
      retirePreservedHead = true;
    } else if (argument === "--retire-reason") {
      assignOnce(values, "reason", args[(index += 1)], argument);
    } else if (argument === "--retire-evidence") {
      assignOnce(values, "evidence", args[(index += 1)], argument);
    } else if (argument === "--retire-wip-ref") {
      assignOnce(values, "wipRef", args[(index += 1)], argument);
    }
  }

  if (integratedTarget && retirePreservedHead) {
    throw new Error("head transition modes are mutually exclusive");
  }
  if (!retirePreservedHead && Object.keys(values).length > 0) {
    throw new Error(
      "retire reason, evidence, and WIP ref require --retire-preserved-live-head",
    );
  }
  if (integratedTarget) {
    return { mode: HEAD_TRANSITION_MODE.INTEGRATED_TARGET };
  }
  if (!retirePreservedHead) return undefined;

  if (values.reason === undefined) throw new Error("retire reason is required");
  if (values.evidence === undefined) {
    throw new Error("retire evidence is required");
  }
  if (values.wipRef === undefined) throw new Error("retire WIP ref is required");
  assertHeadTransitionAuditText(values.reason, "retire reason");
  assertHeadTransitionAuditText(values.evidence, "retire evidence");
  if (
    typeof values.wipRef !== "string" ||
    values.wipRef === "" ||
    values.wipRef.includes("\0") ||
    values.wipRef.length > 4_096
  ) {
    throw new Error("retire WIP ref is invalid");
  }
  return {
    mode: HEAD_TRANSITION_MODE.RETIRE_PRESERVED_HEAD,
    reason: values.reason,
    evidence: values.evidence,
    wipRef: values.wipRef,
  };
}

export function supportsExactTargetTransition(transition) {
  return transition === undefined ||
    transition.mode === HEAD_TRANSITION_MODE.RETIRE_PRESERVED_HEAD;
}

export function resolveTargetCommitRequest(args, headTransition) {
  let targetCommit;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--target-commit") {
      if (DEPLOY_ARGUMENTS_WITH_VALUES.has(argument)) index += 1;
      continue;
    }
    if (targetCommit !== undefined) {
      throw new Error("--target-commit may only be specified once");
    }
    const value = args[(index += 1)];
    if (!FULL_COMMIT_SHA.test(value ?? "")) {
      throw new Error(
        "--target-commit requires one full lowercase commit SHA (40 or 64 hex)",
      );
    }
    targetCommit = value;
  }
  if (targetCommit === undefined) return undefined;
  const transition =
    headTransition === undefined
      ? resolveHeadTransitionRequest(args)
      : headTransition;
  if (!supportsExactTargetTransition(transition)) {
    throw new Error(
      "--target-commit cannot be combined with a head transition mode",
    );
  }
  if (args.includes("--restart-only")) {
    throw new Error("--target-commit cannot be combined with --restart-only");
  }
  return targetCommit;
}

export function isHeadTransitionArgument(argument) {
  return (
    argument === "--adopt-integrated-target" ||
    argument === "--retire-preserved-live-head" ||
    argument === "--retire-reason" ||
    argument === "--retire-evidence" ||
    argument === "--retire-wip-ref"
  );
}

export function headTransitionArgumentTakesValue(argument) {
  return (
    argument === "--retire-reason" ||
    argument === "--retire-evidence" ||
    argument === "--retire-wip-ref"
  );
}

export function deployArgumentTakesValue(argument) {
  return (
    argument === "--target-commit" ||
    headTransitionArgumentTakesValue(argument)
  );
}
