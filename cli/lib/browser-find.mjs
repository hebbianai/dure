export function browserFind(values, options) {
  const [kind, value, subaction, ...rest] = values;
  const textual = ["role", "text", "label", "placeholder", "alt", "title", "testid"];
  let locator;
  if (textual.includes(kind)) {
    if (!value || (options.name !== undefined && kind !== "role")) throw new Error("browser_find_invalid");
    locator = { kind, value, exact: options.exact === true, ...(kind === "role" ? { name: options.name ?? null } : {}) };
  } else if (["first", "last", "nth"].includes(kind)) {
    if (!value || options.exact || options.name !== undefined) throw new Error("browser_find_invalid");
    locator = { kind: "nth", selector: value, index: kind === "first" ? 0 : -1 };
    if (kind === "nth") {
      if (!/^-?(0|[1-9][0-9]{0,5})$/.test(options.index ?? "")) throw new Error("browser_find_invalid");
      locator.index = Number(options.index);
    }
  } else throw new Error("browser_find_invalid");
  if (kind !== "nth" && options.index !== undefined) throw new Error("browser_find_invalid");
  if (["fill", "type"].includes(subaction)) {
    if (rest.length !== 1) throw new Error("browser_find_invalid");
    return { action: { kind: "find", locator, action: { kind: subaction, text: rest[0] } } };
  }
  if (rest.length || !["click", "check", "uncheck", "focus", "hover", "text"].includes(subaction)) throw new Error("browser_find_invalid");
  return subaction === "text"
    ? { query: { kind: "find_text", locator } }
    : { action: { kind: "find", locator, action: { kind: subaction } } };
}
