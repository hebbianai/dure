import { createDecipheriv, createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { appRootDirectory } from "./app-control-location.mjs";
import { browserStateEncryptionKey } from "./browser-state.mjs";

const LIMIT = 64 * 1024 * 1024;
const operations = ["list", "show", "clear", "clean", "rename"];
const routing = ["backend", "resource", "defaultResource", "page", "controller", "epoch", "operationId"];
const fail = (code, cause) => { throw new Error(code, { cause }); };
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

async function directory(environment, create = false) {
  const root = appRootDirectory(environment);
  if (!isAbsolute(root) || root.includes("\0") || Buffer.byteLength(root) > 8192) fail("browser_state_directory_invalid");
  const destination = join(root, "browser", "states");
  for (const path of [root, join(root, "browser"), destination]) {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    let metadata;
    try { metadata = await lstat(path); }
    catch (error) { if (!create && error.code === "ENOENT") return { path: destination, exists: false }; throw error; }
    if (!metadata.isDirectory() || metadata.uid !== process.getuid() || (metadata.mode & (path === destination ? 0o077 : 0o022))) fail("browser_state_directory_invalid");
  }
  return { path: destination, exists: true };
}

export async function defaultBrowserStateOutput(environment, resourceId, encrypted) {
  const root = await directory(environment, true);
  const identity = createHash("sha256").update(resourceId).digest("hex");
  return join(root.path, `browser-${identity}.json${encrypted ? ".enc" : ""}`);
}

function metadata(path, stat) {
  return { filename: basename(path), path, size: stat.size, modified: Math.floor(stat.mtimeMs / 1000), encrypted: path.endsWith(".enc") };
}

async function regular(path) {
  const stat = await lstat(path);
  if (!stat.isFile()) fail("browser_state_file_invalid");
  return stat;
}

async function listed(environment) {
  const root = await directory(environment);
  const files = [];
  if (root.exists) for (const entry of await readdir(root.path, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.json(?:\.enc)?$/.test(entry.name)) continue;
    const path = join(root.path, entry.name);
    let stat;
    try { stat = await regular(path); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    files.push({ ...metadata(path, stat), stat });
  }
  files.sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
  return { directory: root.path, files };
}

async function remove(path, expected) {
  if (!sameFile(await regular(path), expected)) fail("browser_state_file_changed");
  await unlink(path);
}

async function show(path, environment) {
  const expected = await regular(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !sameFile(expected, stat)) fail("browser_state_file_changed");
    if (stat.size > LIMIT) fail("browser_state_file_too_large");
    bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await file.read(bytes, length, bytes.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length !== stat.size || !sameFile(stat, await file.stat())) fail("browser_state_file_changed");
    bytes = bytes.subarray(0, length);
  } finally { await file.close(); }
  if (path.endsWith(".enc")) {
    const key = browserStateEncryptionKey(environment);
    if (key === undefined) fail("browser_state_key_required");
    if (bytes.length < 28) fail("browser_state_decryption_failed");
    try {
      const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(-16));
      bytes = Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
    } catch (error) { fail("browser_state_decryption_failed", error); }
  }
  let state;
  try { state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) { fail("browser_state_file_invalid", error); }
  // Showing a file grants no browser-write authority; import owns full validation.
  if (!state || typeof state !== "object" || Array.isArray(state) || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) fail("browser_state_file_invalid");
  return { ...metadata(path, expected), summary: `${state.cookies.length} cookies, ${state.origins.length} origins`, state };
}

async function rename(path, name) {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name) || Buffer.byteLength(name) > 200) fail("browser_state_name_invalid");
  const before = await regular(path);
  const stem = name.replace(/\.json(?:\.enc)?$/, "");
  if (!stem || stem === "." || stem === "..") fail("browser_state_name_invalid");
  const target = join(dirname(path), `${stem}.json${path.endsWith(".enc") ? ".enc" : ""}`);
  if (target === path) return { renamed: true, from: path, to: target };
  // Hard-link publication refuses an existing destination and keeps file mode.
  await link(path, target);
  const published = await regular(target);
  if (published.dev !== before.dev || published.ino !== before.ino || published.size !== before.size || published.mtimeMs !== before.mtimeMs) fail("browser_state_file_changed");
  // link changes ctime on the same inode; use its post-publication snapshot.
  await remove(path, published);
  return { renamed: true, from: path, to: target };
}

export async function collectBrowserStateFiles(options, { environment = process.env, cwd = process.cwd() } = {}) {
  if (options.positional[0] !== "state") return undefined;
  if (["load", "save"].includes(options.positional[1])) return undefined;
  const index = operations.includes(options.positional[1]) ? 1 : operations.includes(options.positional[2]) ? 2 : undefined;
  if (index === undefined) return undefined;
  const [operation, ...values] = options.positional.slice(index);
  if (Object.keys(options).some(key => !["positional", ...routing, ...(operation === "clean" ? ["days"] : [])].includes(key))) fail("browser_state_command_invalid");
  const lengths = { list: [0], show: [1], clear: [0, 1], clean: [0], rename: [2] };
  if (!lengths[operation].includes(values.length) || values.some(value => !value)) fail("browser_state_command_invalid");
  if (operation === "clean" && options.days !== undefined && !/^\+?\d+$/.test(options.days)) fail("browser_state_age_invalid");
  const days = Number(options.days ?? 30);
  if (operation === "clean" && (!Number.isSafeInteger(days) || days < 0 || days > Math.floor(Number.MAX_SAFE_INTEGER / 86400000))) fail("browser_state_age_invalid");
  try {
    let result;
    if (operation === "show") result = await show(resolve(cwd, values[0]), environment);
    else if (operation === "rename") result = await rename(resolve(cwd, values[0]), values[1]);
    else if (operation === "clear" && values.length) {
      const path = resolve(cwd, values[0]);
      await remove(path, await regular(path));
      result = { deleted: path };
    } else {
      const list = await listed(environment);
      if (operation === "list") result = { directory: list.directory, files: list.files.map(({ stat: _stat, ...file }) => file) };
      else {
        let deleted = 0, kept = 0;
        const now = Date.now();
        for (const file of list.files) {
          if (operation === "clean" && now - file.stat.mtimeMs <= days * 86400000) { kept++; continue; }
          await remove(file.path, file.stat); deleted++;
        }
        result = operation === "clear" ? { deleted } : { cleaned: deleted, keptCount: kept, days };
      }
    }
    return { ok: true, result };
  } catch (error) {
    if (error.message.startsWith("browser_state_")) throw error;
    fail(error.code === "EEXIST" ? "browser_state_destination_exists" : "browser_state_file_unavailable", error);
  }
}
