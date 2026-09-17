#!/usr/bin/env node
// Run on the APK's extracted lib/<abi>/*.so files, not Cargo intermediates.
import { execFileSync } from "node:child_process";

const [readelf, ...libraries] = process.argv.slice(2);
if (!readelf || libraries.length === 0) {
  throw new Error("Usage: node scripts/qa/check-android-elf-alignment.mjs <llvm-readelf> <library.so> [...]");
}

for (const library of libraries) {
  const headers = execFileSync(readelf, ["-lW", library], { encoding: "utf8" });
  const loads = headers.split("\n").filter((line) => /^\s*LOAD\s/.test(line));
  if (loads.length === 0) throw new Error(`No LOAD segments: ${library}`);
  const alignments = loads.map((line) => line.trim().split(/\s+/).at(-1));
  const aligned = alignments.every((value) => /^0x[\da-f]+$/i.test(value) && Number(value) >= 16384);
  console.log(`${aligned ? "ALIGNED" : "UNALIGNED"} ${library}: ${alignments.join(", ")}`);
  if (!aligned) process.exitCode = 1;
}
