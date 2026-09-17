import {
  observeProcessMembers,
  requireNativeProcessGroupSupport,
  signalProcessGeneration,
} from "./process-identity.mjs";
import {
  WINDOWS_JOB_AUTHORITY_KIND,
  observeWindowsJob,
  prepareWindowsJobRuntime,
  terminateWindowsJob,
} from "./windows-process-job.mjs";

export const POSIX_PROCESS_GROUP_AUTHORITY_KIND =
  "posix_process_group_v1";
export const PROCESS_GROUP_WITNESS_PROTOCOL_VERSION = 1;
export const PROCESS_GROUP_WITNESS_CONTROL_TIMEOUT_MS = 1_000;
const PROCESS_GROUP_FREEZE_MAX_PASSES = 32;
const PROCESS_GROUP_RETIREMENT_BATCH_SIZE = 256;
const PROCESS_GROUP_RETIREMENT_MAX_WAIT_MS = 60_000;
const PROCESS_GROUP_RETIREMENT_POLL_MS = 20;

export function processGroupSupport(platform = process.platform) {
  if (platform === "darwin" || platform === "linux") {
    return { supported: true, kind: POSIX_PROCESS_GROUP_AUTHORITY_KIND };
  }
  if (platform === "win32") return { supported: true, kind: WINDOWS_JOB_AUTHORITY_KIND };
  return {
    supported: false,
    reason: "process_group_authority_unavailable_for_platform",
  };
}

export function requireProcessGroupSupport(platform = process.platform) {
  const support = processGroupSupport(platform);
  if (!support.supported) {
    const error = new Error(
      `development process groups are unsupported: ${support.reason}`,
    );
    error.code = "DEV_PROCESS_GROUP_UNSUPPORTED";
    throw error;
  }
  return support;
}

export async function requireProcessGroupAdmission(
  platform = process.platform,
) {
  const support = requireProcessGroupSupport(platform);
  if (platform === "win32") await prepareWindowsJobRuntime();
  else await requireNativeProcessGroupSupport(platform);
  return support;
}

function exactProcessMember(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.processIdentity !== "string" ||
    value.processIdentity.length === 0
  ) {
    throw new Error(`invalid ${label}`);
  }
  return {
    pid: value.pid,
    processIdentity: value.processIdentity,
  };
}

export function parseProcessGroupAuthority(value, { leaderPid } = {}) {
  const validId = value?.kind === WINDOWS_JOB_AUTHORITY_KIND
    ? typeof value.id === "string" && /^[a-f0-9]{64}$/.test(value.id) &&
      typeof value.runtimeBuild === "string" && /^[a-f0-9]{64}$/.test(value.runtimeBuild)
    : value?.kind === POSIX_PROCESS_GROUP_AUTHORITY_KIND &&
      Number.isSafeInteger(value.id) && value.id > 0 &&
      (leaderPid === undefined || value.id === leaderPid);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !validId
  ) {
    throw new Error("invalid process group authority");
  }
  const witness = exactProcessMember(
    value.witness,
    "process group witness",
  );
  if (witness.pid === value.id) {
    throw new Error("process group witness aliases its leader");
  }
  return {
    kind: value.kind,
    id: value.id,
    ...(value.kind === WINDOWS_JOB_AUTHORITY_KIND ? { runtimeBuild: value.runtimeBuild } : {}),
    witness,
  };
}

export function sameProcessGroupAuthority(left, right) {
  return (
    Boolean(left) &&
    Boolean(right) &&
    left.kind === right.kind &&
    left.id === right.id &&
    left.runtimeBuild === right.runtimeBuild &&
    left.witness?.pid === right.witness?.pid &&
    left.witness?.processIdentity === right.witness?.processIdentity
  );
}

export function processGroupWitnessCanRetire(
  observations,
  { groupId, witnessPid },
) {
  return (
    groupMembers(observations, groupId) !== null &&
    observations.members.some(
      ({ pid, state }) => pid === witnessPid && state !== "zombie",
    ) &&
    observations.members.every(
      ({ pid, state }) => pid === witnessPid || state === "zombie",
    )
  );
}

export function parseProcessGroupWitnessReady(
  value,
  { schemaVersion, channel, generation },
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== schemaVersion ||
    value.protocolVersion !== PROCESS_GROUP_WITNESS_PROTOCOL_VERSION ||
    value.type !== "process_group_witness_ready" ||
    value.channel !== channel ||
    value.generation !== generation ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0
  ) {
    throw new Error("invalid process group witness readiness");
  }
  return { pid: value.pid };
}

function sameRequestedPids(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((pid, index) => actual[index] === pid);
}

function canonicalPointPids(pids) {
  return [...new Set(pids)].sort((left, right) => left - right);
}

function exactPointPids(currentPid, exactMembers) {
  return canonicalPointPids([
    currentPid,
    ...exactMembers.map(({ member }) => member.pid),
  ]);
}

function pointMembers(observation, requestedPids) {
  if (
    observation?.status !== "complete" ||
    observation.scope?.kind !== "point" ||
    !sameRequestedPids(
      observation.scope.requestedPids,
      requestedPids,
    )
  ) {
    return null;
  }
  const members = new Map();
  for (const member of observation.members) {
    if (
      !Number.isSafeInteger(member?.pid) ||
      member.pid <= 0 ||
      !Number.isSafeInteger(member.groupId) ||
      member.groupId <= 0 ||
      !["live", "stopped", "zombie"].includes(member.state) ||
      typeof member.processIdentity !== "string" ||
      member.processIdentity.length === 0 ||
      members.has(member.pid)
    ) {
      return null;
    }
    members.set(member.pid, member);
  }
  return members;
}

function groupMembers(observation, groupId) {
  if (
    observation?.status !== "complete" ||
    observation.scope?.kind !== "group_census" ||
    observation.scope.groupId !== groupId
  ) {
    return null;
  }
  const members = new Map();
  for (const member of observation.members) {
    if (
      !Number.isSafeInteger(member?.pid) ||
      member.pid <= 0 ||
      !["live", "stopped", "zombie"].includes(member.state) ||
      members.has(member.pid)
    ) {
      return null;
    }
    members.set(member.pid, member);
  }
  return members;
}

function evaluateExactProcessGroup({
  groupId,
  currentPid,
  exactMembers,
  requiredRoles,
  pointObservation,
  groupObservation,
  confirmationObservation,
}) {
  if (
    exactMembers.some(({ member }) => member.pid === currentPid) ||
    groupId === currentPid
  ) {
    return { state: "unproven" };
  }
  const points = pointMembers(
    pointObservation,
    exactPointPids(currentPid, exactMembers),
  );
  const caller = points?.get(currentPid);
  if (!caller || caller.state !== "live" || caller.groupId === groupId) {
    return { state: "unproven" };
  }
  const currentRoles = Object.fromEntries(
    exactMembers.map(({ role, member, eligible = true }) => {
      const observed = points.get(member.pid);
      return [
        role,
        eligible &&
          observed &&
          observed?.state !== "zombie" &&
          observed.groupId === groupId &&
          observed.processIdentity === member.processIdentity,
      ];
    }),
  );
  if (requiredRoles.every((role) => currentRoles[role] === true)) {
    return { state: "owned", currentRoles };
  }
  if (groupObservation === undefined) {
    return { state: "needs_group_observation", currentRoles };
  }
  const members = groupMembers(groupObservation, groupId);
  if (!members) return { state: "unproven", currentRoles };
  const liveMembers = new Set(
    [...members.values()]
      .filter(({ state }) => state !== "zombie")
      .map(({ pid }) => pid),
  );
  const liveCurrentRoles = Object.fromEntries(
    exactMembers.map(({ role, member }) => [
      role,
      currentRoles[role] === true && liveMembers.has(member.pid),
    ]),
  );
  if (liveMembers.size > 0) {
    return requiredRoles.some((role) => liveCurrentRoles[role] === true)
      ? { state: "owned", currentRoles: liveCurrentRoles }
      : { state: "unproven", currentRoles: liveCurrentRoles };
  }
  if (Object.values(currentRoles).some(Boolean)) {
    return { state: "unproven", currentRoles };
  }
  if (confirmationObservation === undefined) {
    return { state: "needs_confirmation", currentRoles };
  }
  const confirmation = groupMembers(confirmationObservation, groupId);
  if (!confirmation) return { state: "unproven", currentRoles };
  return [...confirmation.values()].every(({ state }) => state === "zombie")
    ? { state: "retired", currentRoles }
    : { state: "unproven", currentRoles };
}

function completeObservation(result) {
  return result.state === "needs_group_observation" ||
      result.state === "needs_confirmation"
    ? { ...result, state: "unproven" }
    : result;
}

function observePoint(pids, options) {
  return observeProcessMembers(
    { kind: "point", pids: canonicalPointPids([process.pid, ...pids]) },
    options,
  );
}

function observeGroup(groupId, options) {
  return observeProcessMembers(
    { kind: "group_census", groupId },
    options,
  );
}

function retirementObservationOptions(deadline) {
  if (deadline === undefined) return undefined;
  const timeoutMs = Math.ceil(deadline - performance.now());
  if (timeoutMs <= 0) {
    throw destructiveAuthorityUnavailable(
      "exact process group did not retire before the deadline",
    );
  }
  return { timeoutMs };
}

async function exactAnchorRetired(anchor, deadline) {
  const requestedPids = [anchor.pid];
  const members = pointMembers(
    await observeProcessMembers(
      { kind: "point", pids: requestedPids },
      retirementObservationOptions(deadline),
    ),
    requestedPids,
  );
  if (!members) {
    throw destructiveAuthorityUnavailable(
      "exact process group anchor observation is incomplete",
    );
  }
  const observed = members.get(anchor.pid);
  return !observed ||
    observed.processIdentity !== anchor.processIdentity ||
    observed.state === "zombie";
}

function destructiveAuthorityUnavailable(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "DEV_PROCESS_GROUP_AUTHORITY_UNAVAILABLE";
  return error;
}

function exactCensusMembers(observation, groupId) {
  const members = groupMembers(observation, groupId);
  if (!members) return null;
  for (const member of members.values()) {
    if (
      member.groupId !== groupId ||
      typeof member.processIdentity !== "string" ||
      member.processIdentity.length === 0
    ) {
      return null;
    }
  }
  return members;
}

function exactMemberKey(members) {
  return [...members.values()]
    .filter(({ state }) => state !== "zombie")
    .map(({ pid, processIdentity }) => `${pid}:${processIdentity}`)
    .sort()
    .join("\n");
}

function requireExactAnchor(members, anchor, groupId) {
  if (members.has(process.pid)) {
    throw destructiveAuthorityUnavailable(
      "refusing to signal a process group containing the current process",
    );
  }
  const observed = members.get(anchor.pid);
  if (
    !observed ||
    observed.state === "zombie" ||
    observed.groupId !== groupId ||
    observed.processIdentity !== anchor.processIdentity
  ) {
    throw destructiveAuthorityUnavailable(
      "exact process group anchor is unavailable",
    );
  }
}

function orderedExactMembers(members, anchorPid) {
  return [...members.values()]
    .filter(({ state }) => state !== "zombie")
    .sort((left, right) => {
      if (left.pid === anchorPid) return 1;
      if (right.pid === anchorPid) return -1;
      return left.pid - right.pid;
    });
}

async function freezeExactProcessGroup(groupId, anchor, deadline) {
  const stoppedByAuthority = new Map();
  const retiredBeforeStop = new Map();
  let frozen;
  let freezeFailure;
  let previousFrozenKey = null;
  const requireRetiredMembersAbsent = (members) => {
    for (const [pid, processIdentity] of retiredBeforeStop) {
      const observed = members.get(pid);
      if (
        observed &&
        (observed.state !== "zombie" ||
          observed.processIdentity !== processIdentity)
      ) {
        throw destructiveAuthorityUnavailable(
          "an exact process group member reappeared while freezing",
        );
      }
    }
  };
  const requireStoppedMembersCurrent = (members) => {
    for (const member of stoppedByAuthority.values()) {
      const observed = members.get(member.pid);
      if (
        !observed ||
        observed.state === "zombie" ||
        observed.processIdentity !== member.processIdentity
      ) {
        throw destructiveAuthorityUnavailable(
          "a stopped exact process group member changed while freezing",
        );
      }
    }
  };
  try {
    for (let pass = 0; pass < PROCESS_GROUP_FREEZE_MAX_PASSES; pass += 1) {
      const before = exactCensusMembers(
        await observeGroup(
          groupId,
          retirementObservationOptions(deadline),
        ),
        groupId,
      );
      if (!before) {
        throw destructiveAuthorityUnavailable(
          "exact process group census is incomplete",
        );
      }
      if (
        stoppedByAuthority.size === 0 &&
        orderedExactMembers(before, anchor.pid).length === 0
      ) {
        const observedAnchor = before.get(anchor.pid);
        const retiredInGroup =
          observedAnchor?.state === "zombie" &&
          observedAnchor.processIdentity === anchor.processIdentity;
        if (retiredInGroup || await exactAnchorRetired(anchor, deadline)) {
          frozen = { members: [], stoppedByAuthority: [] };
          break;
        }
        throw destructiveAuthorityUnavailable(
          "exact process group anchor is unavailable",
        );
      }
      requireExactAnchor(before, anchor, groupId);
      requireRetiredMembersAbsent(before);
      requireStoppedMembersCurrent(before);
      const signalableBefore = orderedExactMembers(before, anchor.pid);
      for (const member of signalableBefore) {
        if (member.state === "stopped") continue;
        if (!await signalProcessGeneration(
          member,
          "SIGSTOP",
          retirementObservationOptions(deadline),
        )) {
          if (member.pid === anchor.pid) {
            throw destructiveAuthorityUnavailable(
              "exact process group anchor is unavailable",
            );
          }
          retiredBeforeStop.set(member.pid, member.processIdentity);
          continue;
        }
        stoppedByAuthority.set(
          `${member.pid}:${member.processIdentity}`,
          member,
        );
      }

      const after = exactCensusMembers(
        await observeGroup(
          groupId,
          retirementObservationOptions(deadline),
        ),
        groupId,
      );
      if (!after) {
        throw destructiveAuthorityUnavailable(
          "exact process group confirmation is incomplete",
        );
      }
      requireExactAnchor(after, anchor, groupId);
      requireRetiredMembersAbsent(after);
      requireStoppedMembersCurrent(after);
      for (const member of signalableBefore) {
        if (
          retiredBeforeStop.get(member.pid) === member.processIdentity
        ) {
          continue;
        }
        const confirmed = after.get(member.pid);
        if (
          !confirmed ||
          confirmed.processIdentity !== member.processIdentity
        ) {
          throw destructiveAuthorityUnavailable(
            "an exact process group member changed while freezing",
          );
        }
      }
      const signalableAfter = orderedExactMembers(after, anchor.pid);
      if (signalableAfter.some(({ state }) => state !== "stopped")) {
        previousFrozenKey = null;
        continue;
      }
      const frozenKey = exactMemberKey(after);
      if (frozenKey === previousFrozenKey) {
        frozen = {
          members: signalableAfter,
          stoppedByAuthority: [...stoppedByAuthority.values()],
        };
        break;
      }
      previousFrozenKey = frozenKey;
    }
    if (!frozen) {
      throw destructiveAuthorityUnavailable(
        "exact process group did not reach a bounded fixed point",
      );
    }
  } catch (error) {
    freezeFailure = error;
  } finally {
    if (!frozen) {
      const rollbackFailures = [];
      const rollbackMembers = [...stoppedByAuthority.values()];
      let rollbackSkipped = 0;
      for (const [index, member] of rollbackMembers.entries()) {
        let signalOptions;
        try {
          signalOptions = retirementObservationOptions(deadline);
        } catch (error) {
          rollbackFailures.push({ error, pid: member.pid });
          rollbackSkipped = rollbackMembers.length - index - 1;
          break;
        }
        try {
          await signalProcessGeneration(member, "SIGCONT", signalOptions);
        } catch (error) {
          rollbackFailures.push({ error, pid: member.pid });
        }
      }
      if (rollbackFailures.length > 0) {
        const listedPids = rollbackFailures
          .slice(0, 16)
            .map(({ pid }) => pid)
            .join(",");
        const omitted = Math.max(0, rollbackFailures.length - 16) +
          rollbackSkipped;
        const primaryMessage = String(
          freezeFailure?.message ?? "process group freeze failed",
        ).replaceAll(/\s+/gu, " ").slice(0, 192);
        const aggregate = new AggregateError(
          [freezeFailure, ...rollbackFailures.map(({ error }) => error)],
          `${primaryMessage}; exact rollback failed for ` +
            listedPids + (omitted > 0 ? `,+${omitted}` : ""),
          { cause: freezeFailure },
        );
        aggregate.code =
          freezeFailure?.code ?? "DEV_PROCESS_GROUP_AUTHORITY_UNAVAILABLE";
        freezeFailure = aggregate;
      }
    }
  }
  if (freezeFailure) throw freezeFailure;
  return frozen;
}

async function signalExactProcessGroupReceipt(
  groupId,
  anchor,
  signal,
  deadline,
) {
  if (signal !== "SIGTERM" && signal !== "SIGKILL") {
    throw new Error("invalid process group signal");
  }
  const frozen = await freezeExactProcessGroup(groupId, anchor, deadline);
  if (frozen.members.length === 0) return { members: [] };
  const signalFailures = [];
  if (signal === "SIGKILL") {
    for (const member of frozen.members.slice(0, -1)) {
      try {
        await signalProcessGeneration(
          member,
          signal,
          retirementObservationOptions(deadline),
        );
      } catch (error) {
        signalFailures.push(error);
      }
    }
    if (signalFailures.length === 1) throw signalFailures[0];
    if (signalFailures.length > 1) {
      throw new AggregateError(
        signalFailures,
        "multiple exact process group members could not be terminated",
      );
    }
    await signalProcessGeneration(
      frozen.members.at(-1),
      signal,
      retirementObservationOptions(deadline),
    );
    return { members: frozen.members };
  }

  const retired = new Set();
  for (const member of frozen.members) {
    try {
      if (!await signalProcessGeneration(
        member,
        signal,
        retirementObservationOptions(deadline),
      )) {
        retired.add(`${member.pid}:${member.processIdentity}`);
      }
    } catch (error) {
      signalFailures.push(error);
    }
  }
  const resumeFailures = [];
  for (const member of frozen.stoppedByAuthority) {
    if (retired.has(`${member.pid}:${member.processIdentity}`)) continue;
    try {
      await signalProcessGeneration(member, "SIGCONT");
    } catch (error) {
      resumeFailures.push(error);
    }
  }
  const failures = [...signalFailures, ...resumeFailures];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "multiple exact process group members could not terminate or resume",
    );
  }
  return { members: frozen.members };
}

async function signalExactProcessGroup(groupId, anchor, signal) {
  const receipt = await signalExactProcessGroupReceipt(
    groupId,
    anchor,
    signal,
  );
  return receipt.members.length > 0;
}

async function waitForExactRetirement(
  exactMembers,
  deadline,
  delay,
) {
  if (exactMembers.length === 0) return;
  for (;;) {
    const surviving = [];
    for (
      let offset = 0;
      offset < exactMembers.length;
      offset += PROCESS_GROUP_RETIREMENT_BATCH_SIZE
    ) {
      const batch = exactMembers.slice(
        offset,
        offset + PROCESS_GROUP_RETIREMENT_BATCH_SIZE,
      );
      const requestedPids = canonicalPointPids(
        batch.map(({ pid }) => pid),
      );
      const observed = pointMembers(
        await observeProcessMembers(
          { kind: "point", pids: requestedPids },
          retirementObservationOptions(deadline),
        ),
        requestedPids,
      );
      if (!observed) {
        throw destructiveAuthorityUnavailable(
          "exact process group retirement observation is incomplete",
        );
      }
      surviving.push(...batch.filter((expected) => {
        const member = observed.get(expected.pid);
        return member?.state !== "zombie" &&
          member?.processIdentity === expected.processIdentity;
      }));
    }
    if (surviving.length === 0) return;
    await delay(Math.min(
      PROCESS_GROUP_RETIREMENT_POLL_MS,
      Math.max(1, deadline - performance.now()),
    ));
  }
}

async function requireExactGroupRetired(groupId, deadline) {
  const members = exactCensusMembers(
    await observeGroup(
      groupId,
      retirementObservationOptions(deadline),
    ),
    groupId,
  );
  if (!members) {
    throw destructiveAuthorityUnavailable(
      "exact process group retirement census is incomplete",
    );
  }
  if (orderedExactMembers(members, groupId).length > 0) {
    throw destructiveAuthorityUnavailable(
      "exact process group retained live members after retirement",
    );
  }
}

export async function retireExactLeaderProcessGroup(
  leader,
  {
    timeoutMs = 1_000,
    delay = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  requireProcessGroupSupport();
  const exactLeader = exactProcessMember(leader, "process group leader");
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > PROCESS_GROUP_RETIREMENT_MAX_WAIT_MS ||
    typeof delay !== "function"
  ) {
    throw new Error("invalid process group retirement options");
  }
  const deadline = performance.now() + Math.max(1, timeoutMs);
  const signaled = await signalExactProcessGroupReceipt(
    exactLeader.pid,
    exactLeader,
    "SIGKILL",
    deadline,
  );
  const members = signaled.members.map(({ pid, processIdentity }) =>
    Object.freeze({ pid, processIdentity })
  );
  await waitForExactRetirement(members, deadline, delay);
  await requireExactGroupRetired(exactLeader.pid, deadline);
  return Object.freeze({
    groupId: exactLeader.pid,
    members: Object.freeze(members),
    status: "retired",
  });
}

export async function bindProcessGroupAuthority({
  leader,
  witnessPid,
  timeoutMs = 1_000,
  delay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  requireProcessGroupSupport();
  if (
    !leader ||
    !Number.isSafeInteger(leader.pid) ||
    leader.pid <= 0 ||
    !Number.isSafeInteger(witnessPid) ||
    witnessPid <= 0 ||
    witnessPid === leader.pid
  ) {
    throw new Error("invalid process group binding");
  }
  const deadline = Date.now() + timeoutMs;
  let witness = null;
  do {
    const observation = await observeProcessMembers(
      { kind: "point", pids: [leader.pid, witnessPid] },
      { timeoutMs: Math.max(1, deadline - Date.now()) },
    );
    if (
      pointMembers(
        observation,
        canonicalPointPids([leader.pid, witnessPid]),
      )
    ) {
      const members = new Map(
        observation.members.map((member) => [member.pid, member]),
      );
      const observedLeader = members.get(leader.pid);
      const observedWitness = members.get(witnessPid);
      if (
        observedLeader?.state === "live" &&
        observedLeader.groupId === leader.pid &&
        observedLeader.processIdentity === leader.processIdentity &&
        observedWitness?.state === "live" &&
        observedWitness.groupId === leader.pid
      ) {
        witness = observedWitness;
        break;
      }
    }
    await delay(20);
  } while (Date.now() < deadline);
  if (!witness) {
    throw new Error("could not bind an exact process group witness");
  }
  return {
    kind: POSIX_PROCESS_GROUP_AUTHORITY_KIND,
    id: leader.pid,
    witness: {
      pid: witnessPid,
      processIdentity: witness.processIdentity,
    },
  };
}

export function evaluateOwnedProcessGroupSnapshots(
  owner,
  observations,
) {
  const authority = parseProcessGroupAuthority(owner?.processGroup, {
    leaderPid: owner?.pid,
  });
  const leader = exactProcessMember(owner, "process group leader");
  const evaluated = evaluateExactProcessGroup({
    groupId: authority.id,
    currentPid: observations.currentPid,
    exactMembers: [
      { role: "leader", member: leader },
      { role: "witness", member: authority.witness },
    ],
    requiredRoles: ["witness"],
    ...observations,
  });
  const leaderCurrent = evaluated.currentRoles?.leader === true;
  const witnessCurrent = evaluated.currentRoles?.witness === true;
  return {
    ...evaluated,
    authority,
    ...(evaluated.state === "owned"
      ? {
          proof: leaderCurrent ? "leader" : "witness",
          leaderCurrent,
          witnessCurrent,
        }
      : {}),
  };
}

export async function observeOwnedProcessGroup(owner, options) {
  requireProcessGroupSupport();
  const authority = parseProcessGroupAuthority(owner?.processGroup, {
    leaderPid: owner?.pid,
  });
  if (authority.kind === WINDOWS_JOB_AUTHORITY_KIND) {
    return observeWindowsJob({ ...owner, processGroup: authority });
  }
  const observations = {
    currentPid: process.pid,
    pointObservation: await observePoint([
      owner.pid,
      authority.witness.pid,
    ], options),
  };
  let evaluated = evaluateOwnedProcessGroupSnapshots(owner, observations);
  if (evaluated.state === "needs_group_observation") {
    observations.groupObservation = await observeGroup(authority.id, options);
    evaluated = evaluateOwnedProcessGroupSnapshots(owner, observations);
  }
  if (evaluated.state === "needs_confirmation") {
    observations.confirmationObservation = await observeGroup(
      authority.id,
      options,
    );
    evaluated = evaluateOwnedProcessGroupSnapshots(owner, observations);
  }
  const result = completeObservation(evaluated);
  if (result.state === "unproven") {
    const incomplete = [
      observations.pointObservation,
      observations.groupObservation,
      observations.confirmationObservation,
    ].find((observation) => observation?.status === "incomplete");
    if (incomplete) return { ...result, reason: incomplete.reason };
  }
  return result;
}

export async function signalOwnedProcessGroup(owner, signal) {
  const authority = parseProcessGroupAuthority(owner?.processGroup, { leaderPid: owner?.pid });
  if (authority.kind === WINDOWS_JOB_AUTHORITY_KIND) {
    return terminateWindowsJob({ ...owner, processGroup: authority }, signal);
  }
  const observed = await observeOwnedProcessGroup(owner);
  if (observed.state === "retired") return false;
  if (observed.state !== "owned" || !observed.witnessCurrent) {
    const error = new Error(
      "process group is live without an exact durable witness authority",
    );
    error.code = "DEV_PROCESS_GROUP_AUTHORITY_UNAVAILABLE";
    throw error;
  }
  return signalExactProcessGroup(
    observed.authority.id,
    observed.authority.witness,
    signal,
  );
}

export function legacyProcessGroupPresent(groupId) {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    throw new Error("invalid legacy process group");
  }
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export async function signalExactProcess(owner, signal) {
  const member = exactProcessMember(owner, "legacy process owner");
  return signalProcessGeneration(member, signal);
}
