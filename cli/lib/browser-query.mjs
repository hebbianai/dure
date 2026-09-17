import { target } from "./browser-reference.mjs";

export function browserQuery(command, values, readTarget = target) {
  const [kind, selector, name] = values;
  if (command === "get") {
    if (["url", "title"].includes(kind) && values.length === 1) return { kind };
    if (kind === "attr" && values.length === 3) return { kind: "attribute", target: readTarget(selector), name };
    if (["text", "html", "value", "count", "box", "styles"].includes(kind) && values.length === 2) {
      const element = readTarget(selector);
      if (kind === "count" && element.kind !== "css") throw new Error("browser_count_requires_selector");
      return { kind, target: element };
    }
  } else if (["visible", "enabled", "checked"].includes(kind) && values.length === 2) {
    return { kind, target: readTarget(selector) };
  }
  throw new Error("browser_query_invalid");
}
