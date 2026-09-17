/** Snapshot options stay read-only and never become native connection flags. */
export function nativeSnapshotArguments(values) {
  const options = new Map();
  const booleans = { "-i": "--interactive", "--interactive": "--interactive", "-c": "--compact", "--compact": "--compact", "-u": "--urls", "--urls": "--urls" };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (Object.hasOwn(booleans, value)) options.set(booleans[value], []);
    else if (["-C", "--cursor"].includes(value)) continue;
    else if (["-s", "--selector"].includes(value) && values[index + 1] !== undefined) options.set("--selector", [values[++index]]);
    else if (["-d", "--depth"].includes(value) && /^[+-]?[0-9]+$/.test(values[index + 1] ?? "")) {
      const depth = BigInt(values[index + 1]);
      if (depth >= -2147483648n && depth <= 2147483647n) {
        index++;
        // Native parsing accepts i32, but its handler ignores negative depth.
        if (depth < 0n) options.delete("--depth");
        else options.set("--depth", [String(depth)]);
      }
    }
    // Unrecognized words are ignored by the native snapshot grammar.
  }
  return ["snapshot", ...[...options].flatMap(([flag, values]) => [flag, ...values])];
}

export function browserSnapshotOptions(command, options) {
  const fields = ["interactive", "compact", "depth", "selector", "urls", "cursor"];
  if (!fields.some((key) => options[key] !== undefined)) return undefined;
  if (command !== "snapshot") throw new Error("browser_command_invalid");
  const result = Object.fromEntries(fields.filter((key) => key !== "cursor" && options[key] !== undefined).map((key) => [key, options[key]]));
  if (result.depth !== undefined) {
    if (!/^\+?[0-9]+$/.test(result.depth) || BigInt(result.depth) > 4294967295n) throw new Error("browser_snapshot_options_invalid");
    result.depth = Number(result.depth);
  }
  if (result.selector !== undefined && (!result.selector.trim() || Buffer.byteLength(result.selector) > 8192 || result.selector.includes("\0"))) throw new Error("browser_snapshot_options_invalid");
  return Object.keys(result).length ? result : undefined;
}
