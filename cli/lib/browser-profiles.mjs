const allowedOptions = new Set(["positional", "backend", "operationId", "label", "scope", "noUaSpoof"]);

export function browserProfiles(values, options, operationId) {
  if (values[0] === "delete") {
    const allowed = new Set(["positional", "backend", "operationId", "profileId"]);
    if (values.length !== 1 || !options.profileId?.trim() || Object.keys(options).some((key) => !allowed.has(key))) throw new Error("browser_command_invalid");
    return { kind: "profile_delete", profile_id: options.profileId, operation_id: operationId };
  }
  if (["set", "clone", "use-default", "show"].includes(values[0])) {
    const selectsProfile = values[0] === "set" || values[0] === "clone";
    const allowed = new Set(["positional", "backend", "operationId", "page", ...(values[0] === "show" ? [] : ["controller", "epoch"]), ...(selectsProfile ? ["profileId"] : [])]);
    const profile = values[0] === "use-default" ? "default" : options.profileId ?? values[2];
    const count = selectsProfile && options.profileId === undefined ? 3 : 2;
    if (values.length !== count || !values[1]?.trim() || (values[0] !== "show" && !profile?.trim()) || Object.keys(options).some((key) => !allowed.has(key))) throw new Error("browser_command_invalid");
    return { kind: values[0] === "show" ? "profile_show" : values[0] === "clone" ? "profile_clone" : "profile_set", resource_id: values[1], ...(values[0] === "show" ? {} : { profile_id: profile }) };
  }
  if (values.length !== 1 || Object.keys(options).some((key) => !allowedOptions.has(key))) throw new Error("browser_command_invalid");
  if (values[0] === "list" && options.label === undefined && options.scope === undefined && options.noUaSpoof === undefined) return { kind: "profile_list" };
  if (values[0] !== "create" || !options.label?.trim() || !["isolated", "imported"].includes(options.scope ?? "isolated")) throw new Error("browser_command_invalid");
  return {
    kind: "profile_create", operation_id: operationId, label: options.label,
    scope: options.scope ?? "isolated", user_agent_mode: options.noUaSpoof ? "native" : "clean",
  };
}
