import { spawnSync } from "node:child_process";
import { macosProcessMarkerCompileArguments } from "./owned-process-group.mjs";

export function compileFaultInjectableMacosObserver(executable) {
  const args = macosProcessMarkerCompileArguments(executable);
  args.splice(1, 0, "-DDURE_OWNERSHIP_OBSERVER_FAULT_INJECTION=1");
  const result = spawnSync("cc", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error("fault observer compile failed: " + result.stderr);
  }
  return executable;
}
