import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { browserSnapshotOptions } from "./browser-snapshot.mjs";

const MAX_TEXT_BYTES = 1024 * 1024;

export function nativeDiffArguments(values) {
  const family = values[0];
  if (!["snapshot", "screenshot"].includes(family)) throw new Error("browser_exec_command_unsupported");
  const names = { "-b": "--baseline", "--baseline": "--baseline", "-s": "--selector", "--selector": "--selector", ...(family === "snapshot" ? { "-d": "--depth", "--depth": "--depth" } : { "-o": "--output", "--output": "--output", "-t": "--threshold", "--threshold": "--threshold" }) };
  const booleans = family === "snapshot" ? { "-c": "--compact", "--compact": "--compact" } : { "-f": "--full", "--full": "--full" };
  const result = ["diff", family];
  for (let index = 1; index < values.length; index++) {
    const flag = values[index];
    if (flag === "--json") continue;
    if (Object.hasOwn(booleans, flag)) result.push(booleans[flag]);
    else if (Object.hasOwn(names, flag) && values[index + 1] !== undefined) result.push(names[flag], values[++index]);
    else throw new Error("browser_exec_command_invalid");
  }
  return result;
}

async function baselineText(value, cwd) {
  if (value === undefined || value === "") return "";
  if (value.includes("\0") || Buffer.byteLength(value) > MAX_TEXT_BYTES) throw new Error("browser_diff_baseline_invalid");
  let file;
  try {
    file = await open(resolve(cwd ?? process.cwd(), value), constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    // Match native baseline syntax: a nonexistent path is literal text.
    if (["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes(error.code)) return value;
    throw new Error("browser_diff_baseline_unavailable", { cause: error });
  }
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error("browser_diff_baseline_unavailable");
    if (before.size > MAX_TEXT_BYTES) throw new Error("browser_diff_baseline_too_large");
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const part = await file.read(bytes, size, bytes.length - size, size);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    const after = await file.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("browser_diff_baseline_changed");
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)); }
    catch (cause) { throw new Error("browser_diff_baseline_invalid", { cause }); }
  } finally { await file.close(); }
}

export async function browserDiff(command, values, options, cwd) {
  if (command !== "diff") {
    if (["baseline", "diffThreshold", "diffFullPage"].some(key => options[key] !== undefined)) throw new Error("browser_command_invalid");
    return undefined;
  }
  if (values.length !== 1) throw new Error("browser_diff_command_invalid");
  if (values[0] === "snapshot") {
    if (["interactive", "urls", "cursor", "output", "diffThreshold", "diffFullPage"].some(key => options[key] !== undefined)) throw new Error("browser_diff_command_invalid");
    return { kind: "snapshot", options: { ...browserSnapshotOptions("snapshot", options), diff_baseline: await baselineText(options.baseline, cwd) } };
  }
  if (values[0] !== "screenshot" || ["interactive", "urls", "cursor", "compact", "depth", "format", "quality", "annotate", "captureElement"].some(key => options[key] !== undefined)) throw new Error("browser_diff_command_invalid");
  if (typeof options.baseline !== "string" || !options.baseline || options.baseline.includes("\0")) throw new Error("browser_diff_baseline_required");
  const threshold = options.diffThreshold === undefined ? 0.1 : Number(options.diffThreshold);
  if (options.diffThreshold !== undefined && !/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(options.diffThreshold) || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("browser_diff_threshold_invalid");
  if (options.output !== undefined && (!options.output || options.output.includes("\0"))) throw new Error("browser_output_required");
  const selector = browserSnapshotOptions("snapshot", { selector: options.selector })?.selector;
  return { kind: "screenshot", baseline: resolve(cwd ?? process.cwd(), options.baseline), threshold, full_page: options.diffFullPage === true, selector, output: options.output === undefined ? undefined : resolve(cwd ?? process.cwd(), options.output) };
}
