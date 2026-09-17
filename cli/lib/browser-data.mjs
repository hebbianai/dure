// Cookie and web-storage writes enter the same Host action path as page input.
// Fixed reads use browser queries and never evaluate caller-provided script.
import { browserCookieImport } from "./browser-cookie-import.mjs";

export function browserData(command, values, options, cwd) {
  if (command === "storage") {
    const [area, operation, key, value] = values;
    if (!["local", "session"].includes(area)) throw new Error("browser_storage_area_invalid");
    if (values.length === 1 || (operation === "get" && [2, 3].includes(values.length))) return { query: { kind: "data", query: { kind: "storage", area, ...(key === undefined ? {} : { key }) } } };
    if (operation === "set" && values.length === 4) return { action: { kind: "data", action: { kind: "storage_set", area, key, value } } };
    if (operation === "clear" && values.length === 2) return { action: { kind: "data", action: { kind: "storage_clear", area } } };
    throw new Error("browser_storage_command_invalid");
  }
  const [operation, name, value] = values;
  if (options.cookieFile !== undefined) {
    if (operation !== "set" || values.length !== 1 || ["name", "value", "path", "secure", "httpOnly", "sameSite", "expires"].some((key) => options[key] !== undefined)) throw new Error("browser_cookie_command_invalid");
    return { action: { kind: "data", action: { kind: "cookies_set", cookies: browserCookieImport(options.cookieFile, options, cwd) } } };
  }
  if (operation === "clear" && values.length === 1 && !["name", "url", "domain", "path", "secure", "httpOnly", "sameSite", "expires"].some((key) => options[key] !== undefined)) {
    return { action: { kind: "data", action: { kind: "cookies_clear" } } };
  }
  const selection = { name, ...(options.url !== undefined ? { url: options.url } : {}), ...(options.domain !== undefined ? { domain: options.domain } : {}), ...(options.path !== undefined ? { path: options.path } : {}) };
  if (operation === "get" && values.length === 1 && !["domain", "path", "secure", "httpOnly", "sameSite", "expires"].some((key) => options[key] !== undefined)) {
    return { query: { kind: "data", query: { kind: "cookies", ...(options.url !== undefined ? { url: options.url } : {}) } } };
  }
  if (operation === "delete" && values.length === 2 && !["secure", "httpOnly", "sameSite", "expires"].some((key) => options[key] !== undefined)) {
    return { action: { kind: "data", action: { kind: "cookie_delete", cookie: selection } } };
  }
  if (operation === "set" && values.length === 3) {
    const sameSite = options.sameSite === undefined ? undefined : ["Strict", "Lax", "None"].find((value) => value.toLowerCase() === options.sameSite.toLowerCase());
    if (options.sameSite !== undefined && !sameSite) throw new Error("browser_cookie_invalid");
    const expires = options.expires === undefined ? undefined : Number(options.expires);
    if (expires !== undefined && (!Number.isFinite(expires) || expires < -1 || !options.expires.trim())) throw new Error("browser_cookie_invalid");
    const cookie = { ...selection, value, ...(options.secure ? { secure: true } : {}), ...(options.httpOnly ? { httpOnly: true } : {}), ...(sameSite ? { sameSite } : {}), ...(expires !== undefined ? { expires } : {}) };
    return { action: { kind: "data", action: { kind: "cookie_set", cookie } } };
  }
  throw new Error("browser_cookie_command_invalid");
}
