import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";

// Import data on the invoking client. A cURL export is never executed and its
// request URL/headers never become backend routing or cookie scope.
export function browserCookieImport(file, options, cwd = process.cwd()) {
  let fd;
  let text;
  try {
    fd = openSync(resolve(cwd, file), constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error();
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > 64 * 1024) throw new Error();
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)).trim();
  } catch {
    throw new Error("browser_cookie_import_file_invalid");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  let cookies;
  try {
    if (text.startsWith("[")) {
      const values = JSON.parse(text);
      if (!Array.isArray(values)) throw new Error();
      cookies = values.map((cookie) => {
        if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") throw new Error();
        return { name: cookie.name, value: cookie.value };
      });
    } else {
      let header = text;
      if (/^curl(?=\s|['"])/i.test(text)) {
        const joined = text.replace(/[\\^]\r?\n/g, " ");
        header = undefined;
        for (const flag of ["-H", "-b", "--cookie"]) {
          for (const match of joined.matchAll(new RegExp(`(?:^|\\s)${flag}\\s+(['"])(.*?)\\1`, "g"))) {
            if (flag === "-H" && !/^cookie:/i.test(match[2])) continue;
            header = flag === "-H" ? match[2].slice(7).trim() : match[2];
            break;
          }
          if (header !== undefined) break;
        }
        if (header === undefined) throw new Error();
      }
      cookies = header.split(";").flatMap((pair) => {
        const equal = pair.indexOf("=");
        const name = equal < 0 ? "" : pair.slice(0, equal).trim();
        return name ? [{ name, value: pair.slice(equal + 1).trim() }] : [];
      });
      if (!cookies.length) throw new Error();
    }
    cookies = cookies.map((cookie) => ({ ...cookie,
      ...(options.domain === undefined ? {} : { domain: options.domain, path: "/" }),
      ...(options.url === undefined ? {} : { url: options.url }),
    }));
    if (cookies.length > 256 || Buffer.byteLength(JSON.stringify(cookies)) > 64 * 1024) throw new Error();
    return cookies;
  } catch {
    throw new Error("browser_cookie_import_invalid");
  }
}
