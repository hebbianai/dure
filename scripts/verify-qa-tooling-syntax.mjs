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

function syntaxCommand(file) {
  if (/\.[cm]?js$/.test(file)) return [process.execPath, ["--check", file]];
  if (file.endsWith(".sh")) return ["sh", ["-n", file]];
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

for (const file of filesBelow(QA_ROOT)) {
  const command = syntaxCommand(file);
  if (!command) continue;
  const result = spawnSync(command[0], command[1], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
