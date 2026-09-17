/** React scripts run through the selected Page's existing action authority. */
export function browserReact(command, values, options) {
  if (command !== "react") {
    if (options.onlyDynamic !== undefined) throw new Error("browser_react_command_invalid");
    return undefined;
  }
  const [kind, argument] = values;
  if (options.onlyDynamic !== undefined && kind !== "suspense") throw new Error("browser_react_command_invalid");
  if (kind === "tree" && values.length === 1) return { kind: "react", action: { kind: "tree" } };
  if (kind === "inspect" && values.length === 2 && /^\+?[0-9]+$/.test(argument)) {
    const id = Number(argument);
    if (Number.isSafeInteger(id) && id > 0) return { kind: "react", action: { kind: "inspect", fiber_id: id } };
  }
  if (kind === "renders" && values.length <= 2 && [undefined, "start", "stop"].includes(argument)) {
    return { kind: "react", action: { kind: argument === "stop" ? "renders_stop" : "renders_start" } };
  }
  if (kind === "suspense" && values.length === 1) return { kind: "react", action: { kind: "suspense", only_dynamic: options.onlyDynamic === true } };
  throw new Error("browser_react_command_invalid");
}

/** Built-ins are named transport inputs; user source byte limits are unchanged. */
export function browserLaunchFeatures(command, enabled, environment = process.env) {
  if (command !== "create") {
    if (enabled !== undefined) throw new Error("browser_feature_requires_create");
    return undefined;
  }
  const values = [environment.AGENT_BROWSER_ENABLE ?? "", ...(enabled ?? [])]
    .flatMap(value => value.split(/[,\n]/)).map(value => value.trim()).filter(Boolean);
  if (values.some(value => !["react-devtools", "react"].includes(value))) throw new Error("browser_feature_unknown");
  return values.length ? ["react_devtools"] : undefined;
}
