import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { cpus, loadavg, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { writeAtomicFile } from "./durable-file.mjs";

const executeFile = promisify(execFile);
export const HOST_RESOURCE_POLICY_ENV = "DURE_HOST_RESOURCE_POLICY";
export const DEFAULT_HOST_RESOURCE_POLICY = Object.freeze({
  schema: "dure.host-resource-policy/v1",
  enabled: false,
  maxLoadPerCore: 2,
  memoryPressureCeiling: "normal",
  pollIntervalMs: 10_000,
});

export function hostResourcePolicyPath(environment = process.env) {
  // A disposable HOME/DURE_HOME must not silently bypass host-wide policy.
  const pathname = environment[HOST_RESOURCE_POLICY_ENV] ??
    join(userInfo().homedir, ".dure", "host-resource-policy-v1.json");
  if (!isAbsolute(pathname)) throw new Error(`${HOST_RESOURCE_POLICY_ENV} must be absolute`);
  return pathname;
}

export function parseHostResourcePolicy(value) {
  const keys = Object.keys(DEFAULT_HOST_RESOURCE_POLICY);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)) ||
      value.schema !== DEFAULT_HOST_RESOURCE_POLICY.schema ||
      typeof value.enabled !== "boolean" ||
      !Number.isFinite(value.maxLoadPerCore) || value.maxLoadPerCore <= 0 ||
      value.maxLoadPerCore > 16 ||
      !["normal", "warning"].includes(value.memoryPressureCeiling) ||
      !Number.isInteger(value.pollIntervalMs) || value.pollIntervalMs < 1_000 ||
      value.pollIntervalMs > 60_000) {
    throw new Error("Invalid host resource policy; inspect or replace the complete policy before launching work");
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

export function readHostResourcePolicy(pathname = hostResourcePolicyPath()) {
  let source;
  try {
    source = readFileSync(pathname, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_HOST_RESOURCE_POLICY;
    throw error;
  }
  if (source.length > 16_384) throw new Error("Host resource policy is too large");
  return parseHostResourcePolicy(JSON.parse(source));
}

export function writeHostResourcePolicy(policy, pathname = hostResourcePolicyPath()) {
  const normalized = parseHostResourcePolicy(policy);
  mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 });
  // Replaceable configuration, not a job lease or compare-and-swap revision.
  writeAtomicFile(pathname, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export function parseMacMemoryPressure(source) {
  // sysctl returns dispatch flags (1/2/4), not XNU's internal 0/1/2/3 enum.
  // Sources: apple-oss-distributions/xnu bsd/kern/kern_memorystatus_notify.c;
  // apple/swift-corelibs-libdispatch dispatch/source.h.
  return ({ "1": "normal", "2": "warning", "4": "critical" })[source.trim()] ?? "unknown";
}

export async function observeHostResources({
  platform = process.platform,
  execute = executeFile,
  readLoad = loadavg,
  readCpus = cpus,
  signal,
} = {}) {
  const started = performance.now();
  const observedAt = new Date().toISOString();
  const logicalCores = readCpus().length;
  const oneMinuteLoad = platform === "win32" ? null : readLoad()[0];
  const loadPerCore = logicalCores > 0 && Number.isFinite(oneMinuteLoad) && oneMinuteLoad >= 0
    ? oneMinuteLoad / logicalCores : null;
  let memoryPressure = "unknown";
  let memoryError = "unsupported_platform";
  if (platform === "darwin") {
    try {
      const result = await execute("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
        encoding: "utf8", timeout: 2_000, maxBuffer: 4_096, signal,
      });
      memoryPressure = parseMacMemoryPressure(result.stdout);
      memoryError = memoryPressure === "unknown" ? "unrecognized_pressure_value" : null;
    } catch (error) {
      signal?.throwIfAborted();
      memoryError = error.code === "ENOENT" ? "pressure_probe_unavailable" : "pressure_probe_failed";
    }
  }
  const durationMs = performance.now() - started;
  return {
    observedAt, durationMs, platform, logicalCores, oneMinuteLoad, loadPerCore,
    memoryPressure, memoryError,
    memorySource: platform === "darwin" ? "kern.memorystatus_vm_pressure_level" : null,
  };
}

export function hostResourceDecision(policy, observation, now = Date.now()) {
  if (!policy.enabled) return { state: "disabled", reasonCodes: [] };
  const reasonCodes = [];
  const age = now - Date.parse(observation.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 5_000 ||
      !Number.isFinite(observation.durationMs) || observation.durationMs < 0 || observation.durationMs > 5_000) {
    reasonCodes.push("host_resource_observation_stale");
  }
  if (!Number.isFinite(observation.loadPerCore) || observation.loadPerCore < 0) {
    reasonCodes.push("host_load_unavailable");
  } else if (observation.loadPerCore >= policy.maxLoadPerCore) {
    reasonCodes.push("host_load_above_limit");
  }
  if (!["normal", "warning", "critical"].includes(observation.memoryPressure)) {
    reasonCodes.push("host_memory_pressure_unavailable");
  } else if (observation.memoryPressure === "critical" ||
      (observation.memoryPressure === "warning" && policy.memoryPressureCeiling === "normal")) {
    reasonCodes.push("host_memory_pressure_above_limit");
  }
  return { state: reasonCodes.length ? "waiting" : "ready", reasonCodes };
}

export async function hostResourceStatus({
  policyPath = hostResourcePolicyPath(),
  readPolicy = readHostResourcePolicy,
  observe = observeHostResources,
  signal,
} = {}) {
  const policy = readPolicy(policyPath);
  const observation = await observe({ signal });
  return { policyPath, policy, observation, ...hostResourceDecision(policy, observation) };
}

export async function waitForHostResources({
  environment = process.env,
  policyPath = hostResourcePolicyPath(environment),
  readPolicy = readHostResourcePolicy,
  observe = observeHostResources,
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
  report = (receipt) => process.stderr.write(`[host-resources] ${JSON.stringify(receipt)}\n`),
  signal,
  maxWaitMs = 0,
  label = "heavy work",
} = {}) {
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0) throw new Error("maxWaitMs must be a nonnegative integer");
  const started = performance.now();
  const cancellation = new AbortController();
  const effectiveSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  const cancel = () => cancellation.abort(new Error("Host resource wait cancelled; command was not started"));
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let waited = false;
  try {
    for (;;) {
      effectiveSignal.throwIfAborted();
      if (maxWaitMs && performance.now() - started >= maxWaitMs) {
        throw new Error("Host resource wait timed out; command was not started");
      }
      const policy = readPolicy(policyPath);
      if (!policy.enabled) {
        const receipt = { label, policyPath, policy, state: "disabled", reasonCodes: [] };
        if (waited) report(receipt);
        return receipt;
      }
      const observation = await observe({ signal: effectiveSignal });
      effectiveSignal.throwIfAborted();
      if (maxWaitMs && performance.now() - started >= maxWaitMs) {
        throw new Error("Host resource wait timed out; command was not started");
      }
      const receipt = { label, policyPath, policy, observation, ...hostResourceDecision(policy, observation) };
      report(receipt);
      if (receipt.state === "ready") return receipt;
      waited = true;
      const remaining = maxWaitMs ? maxWaitMs - (performance.now() - started) : policy.pollIntervalMs;
      await sleep(Math.max(1, Math.min(policy.pollIntervalMs, remaining)), effectiveSignal);
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
