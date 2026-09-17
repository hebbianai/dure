import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveBackendProfilesPath } from "./backend-profiles.mjs";

// This retains only the user's local destination intent. Recording state and
// identity come from the Host; a backend filename never grants a local write.
export async function recordingOutput(profile, resource, operation, output, environment, cwd) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error("browser_recording_output_unsafe");
  const key = createHash("sha256").update(JSON.stringify([profile.id, profile.expected, profile.endpoint, resource, operation])).digest("hex");
  const root = join(dirname(resolveBackendProfilesPath({ environment })), "browser-recording-outputs");
  if (output !== undefined) await mkdir(root, { recursive: true, mode: 0o700 });
  let directory;
  try { directory = await lstat(root); } catch (error) { if (output === undefined && error.code === "ENOENT") return; throw error; }
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || (process.getuid && directory.uid !== process.getuid())) throw new Error("browser_recording_output_unsafe");
  const file = join(root, `${key}.json`);
  const value = output === undefined ? undefined : { key, output: resolve(cwd ?? process.cwd(), output) };
  if (value) {
    let writer;
    try {
      writer = await open(file, "wx", 0o600);
      await writer.writeFile(JSON.stringify(value));
      await writer.sync();
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    finally { if (writer) await writer.close(); }
  }
  let reader;
  try {
    reader = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await reader.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("browser_recording_output_unsafe");
    const saved = JSON.parse(await reader.readFile("utf8"));
    if (saved.key !== key || typeof saved.output !== "string" || !saved.output || resolve(saved.output) !== saved.output || (value && saved.output !== value.output)) throw new Error("browser_recording_output_conflict");
    return saved.output;
  } catch (error) { if (!value && error.code === "ENOENT") return; throw error; }
  finally { if (reader) await reader.close(); }
}
