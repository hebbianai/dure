import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function assertGeneratedTerminalStateMatches(expected, checkedIn) {
  comparePath(path.resolve(expected), path.resolve(checkedIn), "");
}

function comparePath(expected, checkedIn, relative) {
  const label = relative || path.basename(checkedIn);
  let expectedStat;
  let checkedInStat;
  try {
    expectedStat = fs.lstatSync(expected);
    checkedInStat = fs.lstatSync(checkedIn);
  } catch {
    throw new Error(`generated terminal state drift at ${label}`);
  }
  if (expectedStat.isSymbolicLink() || checkedInStat.isSymbolicLink()) {
    throw new Error(`generated terminal state path is not regular at ${label}`);
  }
  if (expectedStat.isDirectory() !== checkedInStat.isDirectory()) {
    throw new Error(`generated terminal state type drift at ${label}`);
  }
  if (expectedStat.isDirectory()) {
    const expectedNames = fs.readdirSync(expected).sort();
    const checkedInNames = fs.readdirSync(checkedIn).sort();
    if (expectedNames.join("\0") !== checkedInNames.join("\0")) {
      throw new Error(`generated terminal state file-set drift at ${label}`);
    }
    for (const name of expectedNames) {
      comparePath(
        path.join(expected, name),
        path.join(checkedIn, name),
        relative ? `${relative}/${name}` : name,
      );
    }
    return;
  }
  if (!expectedStat.isFile() || !checkedInStat.isFile()) {
    throw new Error(`generated terminal state path is not regular at ${label}`);
  }
  if (!fs.readFileSync(expected).equals(fs.readFileSync(checkedIn))) {
    throw new Error(`generated terminal state content drift at ${label}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pairs = process.argv.slice(2);
  if (pairs.length === 0 || pairs.length % 2 !== 0) {
    throw new Error("expected generated/check-in path pairs");
  }
  for (let index = 0; index < pairs.length; index += 2) {
    assertGeneratedTerminalStateMatches(pairs[index], pairs[index + 1]);
  }
}
