import { homedir } from "node:os";
import { PARENT_RELOAD_CAPABILITY } from "./dev-launch-contract.mjs";
import {
  observeDevLaunchParentAuthority,
  observeDevLaunchRestartAuthority,
} from "./dev-launch-client.mjs";
import {
  DEV_DEPLOY_IMPACT,
  DEV_PARENT_RELOAD_STRATEGY,
} from "./dev-launch-impact.mjs";
import {
  DEV_CHAIN_RESTART_STATE,
  coldBootstrapDiscoveryRoot,
  executeDevChainRestart,
  inspectDevChainState,
  supportsDevChainColdBootstrap,
  supportsStandaloneCreateOperation,
  unavailableResult,
} from "./dev-chain-recovery.mjs";
import { resolveUnixDevChainTools } from "./unix-process-tools.mjs";

function canRepairPreparingParent(descriptor) {
  return (
    descriptor?.state === "preparing" &&
    descriptor.sourceGeneration !== undefined &&
    descriptor.candidateLaunch === undefined &&
    descriptor.candidateFrontend === undefined &&
    descriptor.capabilities.includes(PARENT_RELOAD_CAPABILITY)
  );
}

function parentPreparationFailure(recovery, reason = recovery.reason) {
  return {
    kind: DEV_DEPLOY_IMPACT.PARENT_RELOAD,
    state:
      recovery.state === DEV_CHAIN_RESTART_STATE.RESTARTED
        ? DEV_CHAIN_RESTART_STATE.FAILED
        : recovery.state,
    attempted: recovery.attempted,
    destructiveBoundaryCrossed: recovery.destructiveBoundaryCrossed,
    relaunchDispatched: recovery.relaunchDispatched,
    reason,
    recoveryTransition: recovery,
  };
}

export async function prepareDevLaunchCheckout(options = {}, adapter = {}) {
  const kind = options.kind ?? DEV_DEPLOY_IMPACT.PARENT_RELOAD;
  const parent = kind === DEV_DEPLOY_IMPACT.PARENT_RELOAD;
  let authorityReason =
    "cold_bootstrap_required: the target changes the Node runtime pin and cannot be activated by same-binary exec";
  if (options.parentStrategy !== DEV_PARENT_RELOAD_STRATEGY.COLD_BOOTSTRAP) {
    const observe =
      adapter.observe ??
      (parent
        ? observeDevLaunchParentAuthority
        : observeDevLaunchRestartAuthority);
    const observation = {
      root: options.root,
      channel: options.channel,
      home: options.home,
      ...(parent
        ? { requireParentReloadAuthority: true, requireFrontendAuthority: true }
        : {}),
      timeoutMs: options.timeoutMs,
    };
    try {
      await observe(observation);
      return { admitted: true };
    } catch (error) {
      authorityReason = `${parent ? "dev_launch_parent" : "dev_launch_supervisor"}_authority_unavailable: ${error.message}`;
    }
    let restartAuthority;
    if (parent) {
      try {
        restartAuthority = await (
          adapter.observeRestart ?? observeDevLaunchRestartAuthority
        )({
          root: options.root,
          channel: options.channel,
          home: options.home,
          timeoutMs: options.timeoutMs,
        });
      } catch {}
    }
    if (canRepairPreparingParent(restartAuthority)) {
      const recovery = await (adapter.restart ?? executeDevChainRestart)({
        root: options.root,
        channel: options.channel,
        home: options.home,
        timeoutMs: options.timeoutMs,
        expectedAuthority: restartAuthority,
      });
      if (
        recovery.state === DEV_CHAIN_RESTART_STATE.RESTARTED ||
        recovery.destructiveBoundaryCrossed === false
      ) {
        try {
          await observe(observation);
          return { admitted: true, recoveryTransition: recovery };
        } catch (error) {
          if (recovery.state === DEV_CHAIN_RESTART_STATE.RESTARTED) {
            return {
              admitted: false,
              transition: parentPreparationFailure(
                recovery,
                `dev_launch_parent_authority_unavailable: ${error.message}`,
              ),
            };
          }
        }
      }
      if (recovery.attempted) {
        return {
          admitted: false,
          transition: parentPreparationFailure(recovery),
        };
      }
    }
  }

  if (!options.allowColdBootstrap) {
    return {
      admitted: false,
      transition: unavailableResult(
        kind,
        `${authorityReason}; cold bootstrap unavailable: cold bootstrap requires an exact capability-bound queued deploy transaction`,
      ),
    };
  }
  if (!supportsStandaloneCreateOperation()) {
    return {
      admitted: false,
      transition: unavailableResult(
        kind,
        `${authorityReason}; cold bootstrap unavailable: this platform has no standalone-create operation adapter`,
      ),
    };
  }
  if (options.coldBootstrapReplay) return { admitted: true };

  const toolCapability = (adapter.resolveTools ?? resolveUnixDevChainTools)();
  let chain;
  try {
    const home = options.home ?? homedir();
    chain = (adapter.inspect ?? inspectDevChainState)({
      root: options.root,
      channel: options.channel,
      port: options.port,
      home,
      discoveryRoot: coldBootstrapDiscoveryRoot(home),
      toolCapability,
    });
  } catch (error) {
    chain = { state: "unknown", reason: error.message };
  }
  if (chain?.state === "absent") {
    if (!supportsDevChainColdBootstrap(toolCapability)) {
      return {
        admitted: false,
        transition: unavailableResult(
          kind,
          `${authorityReason}; cold bootstrap unavailable: ${toolCapability.reason}`,
        ),
      };
    }
    return { admitted: true, coldBootstrapToolCapability: toolCapability };
  }
  return {
    admitted: false,
    transition: unavailableResult(
      kind,
      `${authorityReason}; cold bootstrap unavailable: ${chain?.reason ?? "dev chain absence was not proven"}`,
    ),
  };
}
