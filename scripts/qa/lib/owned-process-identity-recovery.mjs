const OWNED_PROCESS_GROUP_ERROR = "owned_process_group_error";

function diagnostic(value) {
  return String(value ?? "none").trim().replaceAll(/\s+/gu, " ").slice(0, 256);
}

function censusRelations(observation, effectiveUid) {
  if (
    observation?.status !== "complete" ||
    observation.scope?.kind !== "user_identity_census" ||
    observation.scope?.evidence !== "closed_enumeration" ||
    observation.scope?.effectiveUid !== effectiveUid ||
    !Array.isArray(observation.relations)
  ) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: exact identity census is incomplete: ${diagnostic(
        observation?.reason,
      )}`,
    );
  }
  return observation.relations;
}

function ownedClosure(seedIdentities, relations) {
  const owned = new Set(seedIdentities);
  let changed = true;
  while (changed) {
    changed = false;
    for (const relation of relations) {
      if (
        relation.parentProcessIdentity &&
        owned.has(relation.parentProcessIdentity) &&
        !owned.has(relation.processIdentity)
      ) {
        owned.add(relation.processIdentity);
        changed = true;
      }
    }
  }
  return relations.filter(({ processIdentity }) => owned.has(processIdentity));
}

export function identityOwnedRelations(
  seedIdentities,
  observation,
  effectiveUid,
) {
  return ownedClosure(
    seedIdentities,
    censusRelations(observation, effectiveUid),
  );
}

export async function terminateIdentityOwnedTree({
  assertCurrent = () => {},
  effectiveUid,
  killGraceMs,
  leaderPid,
  maxPasses,
  observe,
  pollIntervalMs,
  seedIdentities,
  signal,
  timeoutMs,
  wait,
}) {
  const ownedIdentities = new Set(seedIdentities);
  const captured = new Map();
  const deadline = performance.now() + timeoutMs;
  let stableFingerprint;
  let stablePasses = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    assertCurrent();
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) break;
    const owned = identityOwnedRelations(
      ownedIdentities,
      await observe({ timeoutMs: remaining }),
      effectiveUid,
    );
    for (const relation of owned) {
      assertCurrent();
      const identity = {
        pid: relation.pid,
        processIdentity: relation.processIdentity,
      };
      if (signal(identity, "SIGSTOP")) {
        captured.set(relation.processIdentity, identity);
        ownedIdentities.add(relation.processIdentity);
      }
    }
    const fingerprint = [...captured.keys()].sort().join("\n");
    stablePasses = fingerprint === stableFingerprint ? stablePasses + 1 : 0;
    stableFingerprint = fingerprint;
    if (stablePasses >= 2) break;
    await wait(pollIntervalMs);
  }
  if (stablePasses < 2) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: identity-only ownership did not quiesce`,
    );
  }

  const targets = [...captured.values()].sort((left, right) => {
    const leaderOrder =
      Number(left.pid === leaderPid) - Number(right.pid === leaderPid);
    return leaderOrder || left.pid - right.pid;
  });
  for (const target of targets) {
    assertCurrent();
    signal(target, "SIGKILL");
  }

  const verificationDeadline = performance.now() + killGraceMs;
  let surviving = [];
  do {
    assertCurrent();
    surviving = identityOwnedRelations(
      ownedIdentities,
      await observe({
        timeoutMs: Math.max(
          1,
          Math.ceil(verificationDeadline - performance.now()),
        ),
      }),
      effectiveUid,
    );
    if (surviving.length === 0) return;
    await wait(pollIntervalMs);
  } while (performance.now() < verificationDeadline);
  throw new Error(
    `${OWNED_PROCESS_GROUP_ERROR}: identity-only owned generations survived SIGKILL: ` +
      surviving.map(({ pid }) => pid).join(","),
  );
}
