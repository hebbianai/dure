import { isBackendRuntimeFingerprint } from "../../src/contracts/frontendRuntimeObservation.mjs";
import { requireCurrentNodeDependencyInstall } from "../node-dependency-preflight.mjs";
import { computeBackendRuntimeFingerprint } from "./backend-runtime-fingerprint.mjs";
import {
  DEV_LAUNCH_FRONTEND_READY_PATH,
  parseDevLaunchFrontendReady,
} from "./dev-launch-contract.mjs";

export function normalizeFrontendAuthority(frontend) {
  if (frontend === undefined) return undefined;
  if (
    !frontend ||
    typeof frontend !== "object" ||
    Array.isArray(frontend) ||
    typeof frontend.command !== "string" ||
    frontend.command.length === 0 ||
    !Array.isArray(frontend.args) ||
    frontend.args.some((argument) => typeof argument !== "string") ||
    !frontend.spawnOptions ||
    typeof frontend.spawnOptions !== "object" ||
    Array.isArray(frontend.spawnOptions) ||
    typeof frontend.probe !== "function" ||
    (frontend.canReuse !== undefined && typeof frontend.canReuse !== "function")
  ) {
    throw new Error("invalid dev launch frontend authority");
  }
  return {
    command: frontend.command,
    args: [...frontend.args],
    spawnOptions: frontend.spawnOptions,
    probe: frontend.probe,
    canReuse: frontend.canReuse,
  };
}

async function readFrontendReady({ origin, channel }, identity) {
  try {
    const response = await fetch(new URL(DEV_LAUNCH_FRONTEND_READY_PATH, origin), {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const value = await response.json();
    const ready = parseDevLaunchFrontendReady(value, {
      channel,
      generation: identity.generation,
    });
    return {
      ...ready,
      backendRuntimeFingerprint: isBackendRuntimeFingerprint(value.backendRuntimeFingerprint)
        ? value.backendRuntimeFingerprint
        : null,
      nodeDependencyFingerprint: value.nodeDependencyFingerprint,
    };
  } catch {
    return null;
  }
}

/** Health observation must not hash artifacts or reinterpret reuse eligibility. */
export async function probeDevFrontend(target, identity) {
  return (await readFrontendReady(target, identity)) !== null;
}

/** Called only at launch admission, after preparation. Missing observations on
 * older frontends select exact replacement, not an unsupported-version refusal.
 * Failure to read the prepared inputs throws before retiring an incumbent. */
export async function canReuseDevFrontend(target, identity) {
  const expected = computeBackendRuntimeFingerprint(target.worktreeRoot);
  const dependencies = requireCurrentNodeDependencyInstall(target.worktreeRoot);
  const ready = await readFrontendReady(target, identity);
  return ready?.backendRuntimeFingerprint === expected &&
    ready.nodeDependencyFingerprint === dependencies.fingerprint;
}
