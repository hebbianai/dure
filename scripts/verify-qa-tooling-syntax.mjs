#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const QA_ROOT = path.resolve("scripts/qa");

function filesBelow(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(target) : [target];
    })
    .sort();
}

// Linux sh is often dash, which rejects bash syntax, so a script's shebang
// selects the shell that parses it.
function shellForScript(source) {
  const [interpreter = "", ...args] =
    source.match(/^#!(.*)/)?.[1].trim().split(/\s+/) ?? [];
  const program =
    path.posix.basename(interpreter) === "env"
      ? args.find((arg) => !arg.startsWith("-") && !arg.includes("="))
      : interpreter;
  return path.posix.basename(program ?? "") === "bash" ? "bash" : "sh";
}

export function syntaxCommand(file) {
  if (/\.[cm]?js$/.test(file)) return [process.execPath, ["--check", file]];
  if (file.endsWith(".sh")) {
    return [shellForScript(fs.readFileSync(file, "utf8")), ["-n", file]];
  }
  if (file.endsWith(".py")) {
    return [
      "python3",
      [
        "-c",
        "import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())",
        file,
      ],
    ];
  }
  return undefined;
}

if (import.meta.main) {
  for (const file of filesBelow(QA_ROOT)) {
    const command = syntaxCommand(file);
    if (!command) continue;
    const result = spawnSync(command[0], command[1], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
