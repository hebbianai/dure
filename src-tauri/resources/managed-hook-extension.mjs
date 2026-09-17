import fs from "node:fs";
import path from "node:path";

function ownedDirectory(directory, privateMode = false) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0) {
    throw new Error("Provider extension directory must be owned and not writable by other users");
  }
}

function verifyExtension(directory, files, manifest) {
  ownedDirectory(directory, true);
  ownedDirectory(path.join(directory, "hooks"), true);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(directory, relative);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
      || fs.readFileSync(file, "utf8") !== contents) {
      throw new Error("Existing Dure provider extension differs; refusing to overwrite it");
    }
  }
  if (fs.readdirSync(directory).sort().join(",") !== [manifest, "hooks"].sort().join(",")
    || fs.readdirSync(path.join(directory, "hooks")).join(",") !== "hooks.json") {
    throw new Error("Existing Dure provider extension contains unrecognized files");
  }
}

export function prepareHookExtension(directory, profile, files, manifest) {
  ownedDirectory(directory, true);
  if (!path.isAbsolute(profile)) throw new Error("Provider profile must be absolute");
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  ownedDirectory(profile);
  const extensions = path.join(profile, "extensions");
  fs.mkdirSync(extensions, { recursive: true, mode: 0o700 });
  ownedDirectory(extensions);
  const destination = path.join(extensions, "dure-lifecycle-v1");
  if (!fs.lstatSync(destination, { throwIfNoEntry: false })) {
    // Build outside the scanned extensions directory and publish a complete tree.
    const pending = fs.mkdtempSync(path.join(profile, ".dure-lifecycle-"));
    try {
      fs.mkdirSync(path.join(pending, "hooks"), { mode: 0o700 });
      for (const [relative, contents] of Object.entries(files)) {
        fs.writeFileSync(path.join(pending, relative), contents, { mode: 0o600, flag: "wx" });
      }
      try { fs.renameSync(pending, destination); }
      catch (error) { if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error; }
    } finally { fs.rmSync(pending, { recursive: true, force: true }); }
  }
  verifyExtension(destination, files, manifest);
}
