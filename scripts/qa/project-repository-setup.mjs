import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const home = fs.realpathSync(process.env.HOME);
assert.match(home, /\/dure-project-repository\.[^/]+\/home$/);
const repo = path.join(home, "repo");
fs.mkdirSync(repo);
fs.mkdirSync(path.join(home, "plain"));
execFileSync("git", ["init", "--quiet", repo]);
// Working-tree status failure must not permanently disable repository actions.
fs.writeFileSync(path.join(repo, ".git", "index"), "invalid index");
assert.throws(() => execFileSync("git", ["-C", repo, "status", "--porcelain"], { stdio: "pipe" }));
