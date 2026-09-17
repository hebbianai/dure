// Clipboard access uses controller admission and the operation journal.
// Shortcuts remain neutral until the execution host selects its platform keys.
export function browserClipboard(values, options) {
  const allowed = new Set(["positional", "backend", "page", "controller", "epoch", "operationId", "text"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) throw new Error("browser_clipboard_invalid");
  if (values.length === 1 && ["copy", "paste"].includes(values[0]) && options.text === undefined) {
    return { kind: "clipboard", operation: values[0] };
  }
  if (values.length === 1 && values[0] === "read" && options.text === undefined) {
    return { kind: "evaluate", script: "navigator.clipboard.readText().then(text=>({text}))" };
  }
  if (values[0] !== "write" || (options.text === undefined ? values.length !== 2 : values.length !== 1)) throw new Error("browser_clipboard_invalid");
  const text = options.text ?? values[1];
  if (Buffer.byteLength(text, "utf8") > 8 * 1024) throw new Error("browser_clipboard_text_too_large");
  return {
    kind: "evaluate",
    script: `(async()=>{const text=${JSON.stringify(text)};await navigator.clipboard.writeText(text);return {written:text};})()`,
  };
}
