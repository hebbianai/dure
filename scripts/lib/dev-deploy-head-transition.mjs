import { execFileSync, spawnSync } from "node:child_process";
import { worktreeDevIdentity } from "./app-channel.mjs";
import {
  headTransitionMode,
  headTransitionTransactionId,
  readHeadTransitionJournal,
  sameHeadTransitionIdentity,
  writeHeadTransitionJournal,
} from "./dev-deploy-head-transition-journal.mjs";
import { HEAD_TRANSITION_MODE } from "./dev-deploy-head-transition-options.mjs";
import { assertNoHeadTransitionTargetPathCollision } from "./dev-deploy-target-collision.mjs";
import { withoutLocalGitOverrides } from "./git-environment.mjs";
import { inspectOwnedWorktreeCheckpoint } from "./worktree-wip.mjs";

const RETAINED_REF_PREFIX = "refs/dure-dev-deploy/retained-v1";

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: withoutLocalGitOverrides(),
  }).trim();
}

function gitResult(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: withoutLocalGitOverrides(),
  });
}

function commandFailure(label, result) {
  const detail =
    result.error?.message || result.stderr?.trim() || result.stdout?.trim();
  return new Error(`${label}${detail ? `: ${detail}` : ""}`);
}

function assertObjectId(value, label) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error(`${label} is not a full Git object id`);
  }
}

function worktreeStatus(root) {
  return git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
}

function assertClean(root, boundary) {
  if (worktreeStatus(root) !== "") {
    throw new Error(`head transition requires a clean worktree ${boundary}`);
  }
}

function assertNotAncestor(root, currentHead, targetHead) {
  const result = gitResult(root, [
    "merge-base",
    "--is-ancestor",
    currentHead,
    targetHead,
  ]);
  if (result.status === 0) {
    throw new Error(
      "head transition is only valid for a non-fast-forward head",
    );
  }
  if (result.status !== 1) {
    throw commandFailure("could not classify the live head ancestry", result);
  }
}

function resolveMergeTree(root, currentHead, targetHead) {
  const result = gitResult(root, [
    "merge-tree",
    "--write-tree",
    currentHead,
    targetHead,
  ]);
  if (result.status !== 0) {
    throw commandFailure("integrated target merge-tree failed", result);
  }
  const mergeTree = result.stdout.trim().split("\n", 1)[0];
  assertObjectId(mergeTree, "merge tree");
  const targetTree = git(root, ["rev-parse", `${targetHead}^{tree}`]);
  if (mergeTree !== targetTree) {
    throw new Error(
      `integrated target merge tree ${mergeTree} differs from target tree ${targetTree}`,
    );
  }
  return mergeTree;
}

function retainedRefFor(root, currentHead) {
  const { channel } = worktreeDevIdentity(root);
  return `${RETAINED_REF_PREFIX}/${channel}/${currentHead}`;
}

function refHead(root, retainedRef) {
  const result = gitResult(root, [
    "rev-parse",
    "--verify",
    `${retainedRef}^{commit}`,
  ]);
  if (result.status === 1 || result.status === 128) return undefined;
  if (result.status !== 0) {
    throw commandFailure("could not inspect the retained head ref", result);
  }
  return result.stdout.trim();
}

function assertRetainedRef(root, retainedRef, currentHead) {
  const retainedHead = refHead(root, retainedRef);
  if (retainedHead !== currentHead) {
    throw new Error(
      `retained head ref verification failed: expected ${currentHead}, ` +
        `got ${retainedHead ?? "missing"}`,
    );
  }
}

function createOrResumeRetainedRef(plan) {
  const existing = refHead(plan.root, plan.retainedRef);
  if (existing !== undefined) {
    if (existing !== plan.currentHead) {
      throw new Error(`head transition retained ref collision: ${plan.retainedRef}`);
    }
    return;
  }
  const created = gitResult(plan.root, [
    "update-ref",
    "--create-reflog",
    "-m",
    "dure dev deploy preserved head transition",
    plan.retainedRef,
    plan.currentHead,
    "",
  ]);
  if (created.status !== 0) {
    throw commandFailure("could not create the retained head ref", created);
  }
  assertRetainedRef(plan.root, plan.retainedRef, plan.currentHead);
}

function wipIdentity(root, ref, currentHead) {
  const checkpoint = inspectOwnedWorktreeCheckpoint(root, ref);
  if (checkpoint.metadata.base !== currentHead) {
    throw new Error(
      `WIP checkpoint base ${checkpoint.metadata.base} does not match current head ${currentHead}`,
    );
  }
  assertObjectId(checkpoint.object, "WIP checkpoint object");
  assertObjectId(checkpoint.metadata.base, "WIP checkpoint base");
  return {
    ref: checkpoint.ref,
    object: checkpoint.object,
    base: checkpoint.metadata.base,
    worktree: checkpoint.root,
    operationId: checkpoint.metadata.operationId,
  };
}

function sameWipIdentity(left, right) {
  return (
    left?.ref === right?.ref &&
    left?.object === right?.object &&
    left?.base === right?.base &&
    left?.worktree === right?.worktree &&
    left?.operationId === right?.operationId
  );
}

function verifyWipIdentity(plan) {
  const observed = wipIdentity(
    plan.root,
    plan.wipCheckpoint.ref,
    plan.currentHead,
  );
  if (!sameWipIdentity(observed, plan.wipCheckpoint)) {
    throw new Error("preserved-head WIP checkpoint identity changed");
  }
}

function verifyIntegratedIdentity(plan) {
  const mergeTree = resolveMergeTree(
    plan.root,
    plan.currentHead,
    plan.targetHead,
  );
  if (mergeTree !== plan.mergeTree) {
    throw new Error("integrated target merge identity changed");
  }
}

function verifyModeAuthority(plan) {
  if (headTransitionMode(plan) === HEAD_TRANSITION_MODE.INTEGRATED_TARGET) {
    verifyIntegratedIdentity(plan);
  } else {
    verifyWipIdentity(plan);
  }
}

function verifyCurrentBoundary(plan) {
  if (git(plan.root, ["rev-parse", "HEAD"]) !== plan.currentHead) {
    throw new Error("live worktree head changed during transition validation");
  }
  assertClean(plan.root, "at the head transition boundary");
  verifyModeAuthority(plan);
  assertNoHeadTransitionTargetPathCollision(plan);
}

function moveHeadWithoutClobber(plan) {
  execFileSync(
    "git",
    ["-C", plan.root, "reset", "--merge", "--quiet", plan.targetHead],
    {
      cwd: plan.root,
      encoding: "utf8",
      env: withoutLocalGitOverrides(),
    },
  );
}

function verifyTransitionedHead(plan) {
  const deployedHead = git(plan.root, ["rev-parse", "HEAD"]);
  if (deployedHead !== plan.targetHead) {
    throw new Error(
      `head transition verification failed: expected ${plan.targetHead}, got ${deployedHead}`,
    );
  }
  assertClean(plan.root, "after the head transition");
  assertRetainedRef(plan.root, plan.retainedRef, plan.currentHead);
  verifyModeAuthority(plan);
}

function modeSpecificPlan(request, root, currentHead, targetHead) {
  if (request.mode === HEAD_TRANSITION_MODE.INTEGRATED_TARGET) {
    return { mergeTree: resolveMergeTree(root, currentHead, targetHead) };
  }
  return {
    reason: request.reason,
    evidence: request.evidence,
    wipCheckpoint: wipIdentity(root, request.wipRef, currentHead),
  };
}

function newPlan({ root, home, currentHead, targetHead, request }) {
  assertObjectId(currentHead, "current head");
  assertObjectId(targetHead, "target head");
  if (currentHead === targetHead) {
    throw new Error("head transition requires distinct heads");
  }
  assertClean(root, "before validation");
  assertNotAncestor(root, currentHead, targetHead);
  const { channel } = worktreeDevIdentity(root);
  const retainedRef = retainedRefFor(root, currentHead);
  const plan = {
    schemaVersion:
      request.mode === HEAD_TRANSITION_MODE.INTEGRATED_TARGET ? 1 : 2,
    home,
    root,
    channel,
    mode: request.mode,
    currentHead,
    targetHead,
    retainedRef,
    ...modeSpecificPlan(request, root, currentHead, targetHead),
  };
  plan.transactionId = headTransitionTransactionId(plan);
  if (refHead(root, retainedRef) !== undefined) {
    throw new Error(`head transition retained ref collision: ${retainedRef}`);
  }
  assertNoHeadTransitionTargetPathCollision(plan);
  return plan;
}

function requestMatchesJournal(request, journal) {
  const mode = headTransitionMode(journal);
  if (request.mode !== mode) return false;
  if (mode === HEAD_TRANSITION_MODE.INTEGRATED_TARGET) return true;
  return (
    request.reason === journal.reason &&
    request.evidence === journal.evidence &&
    request.wipRef === journal.wipCheckpoint.ref
  );
}

function resumePlan(
  journal,
  { root, home, currentHead, targetHead, request },
) {
  const { channel } = worktreeDevIdentity(root);
  if (
    !requestMatchesJournal(request, journal) ||
    journal.root !== root ||
    journal.channel !== channel ||
    journal.targetHead !== targetHead ||
    (currentHead !== journal.currentHead && currentHead !== journal.targetHead)
  ) {
    return undefined;
  }
  const plan = { ...journal, home };
  if (journal.retainedRef !== retainedRefFor(root, journal.currentHead)) {
    throw new Error("head transition journal retained ref does not match its channel");
  }
  verifyModeAuthority(plan);
  if (currentHead === journal.currentHead) {
    if (journal.state === "head_adopted" || journal.state === "verified") {
      throw new Error("head transition journal state is ahead of the live head");
    }
    assertClean(root, "while resuming the previous head");
    assertNoHeadTransitionTargetPathCollision(plan);
  } else {
    if (journal.state === "planned") {
      throw new Error("head transition journal did not retain before moving HEAD");
    }
    assertClean(root, "while resuming the transitioned head");
  }
  if (journal.state !== "planned") {
    assertRetainedRef(root, journal.retainedRef, journal.currentHead);
  }
  return plan;
}

function transactionDescription(request) {
  return request.mode === HEAD_TRANSITION_MODE.INTEGRATED_TARGET
    ? "integrated target transaction"
    : "preserved-head retirement transaction";
}

export function planHeadTransition({
  root,
  home,
  currentHead,
  targetHead,
  request,
}) {
  if (!request) throw new Error("head transition request is required");
  const { channel } = worktreeDevIdentity(root);
  const journal = readHeadTransitionJournal({ home, channel });
  if (journal) {
    const resumed = resumePlan(journal, {
      root,
      home,
      currentHead,
      targetHead,
      request,
    });
    if (resumed) return resumed;
    if (journal.state !== "verified") {
      throw new Error(
        `unfinished ${transactionDescription(request)} ` +
          `${journal.transactionId} does not match this request`,
      );
    }
  }
  return newPlan({ root, home, currentHead, targetHead, request });
}

function receipt(plan) {
  const common = {
    headTransitionTransactionId: plan.transactionId,
    previousHead: plan.currentHead,
    targetHead: plan.targetHead,
    retainedRef: plan.retainedRef,
  };
  if (headTransitionMode(plan) === HEAD_TRANSITION_MODE.INTEGRATED_TARGET) {
    return {
      headTransition: "adopt-integrated-target",
      ...common,
      mergeTree: plan.mergeTree,
    };
  }
  return {
    headTransition: "retire-preserved-live-head",
    headTransitionMode: HEAD_TRANSITION_MODE.RETIRE_PRESERVED_HEAD,
    headTransitionReason: plan.reason,
    headTransitionEvidence: plan.evidence,
    ...common,
    wipCheckpoint: plan.wipCheckpoint,
  };
}

export function executeHeadTransition(plan) {
  let journal = readHeadTransitionJournal({
    home: plan.home,
    channel: plan.channel,
  });
  if (
    journal &&
    !sameHeadTransitionIdentity(journal, plan) &&
    journal.state !== "verified"
  ) {
    throw new Error(
      `unfinished head transition transaction ${journal.transactionId} does not match this request`,
    );
  }
  if (!journal || !sameHeadTransitionIdentity(journal, plan)) {
    verifyCurrentBoundary(plan);
    journal = writeHeadTransitionJournal(plan, "planned");
  }

  if (journal.state === "planned") {
    verifyCurrentBoundary(plan);
    createOrResumeRetainedRef(plan);
    verifyModeAuthority(plan);
    journal = writeHeadTransitionJournal(plan, "retained");
  }
  if (journal.state === "retained") {
    verifyModeAuthority(plan);
    assertRetainedRef(plan.root, plan.retainedRef, plan.currentHead);
    const head = git(plan.root, ["rev-parse", "HEAD"]);
    if (head === plan.currentHead) {
      verifyCurrentBoundary(plan);
      moveHeadWithoutClobber(plan);
    } else if (head !== plan.targetHead) {
      throw new Error("live worktree head does not match the transition transaction");
    }
    verifyTransitionedHead(plan);
    journal = writeHeadTransitionJournal(plan, "head_adopted");
  }
  if (journal.state === "head_adopted") {
    verifyTransitionedHead(plan);
    journal = writeHeadTransitionJournal(plan, "verified");
  }
  if (journal.state !== "verified") {
    throw new Error("head transition transaction did not reach verified state");
  }
  verifyTransitionedHead(plan);
  return receipt(plan);
}
