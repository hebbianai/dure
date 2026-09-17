#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { evaluateWorkspacePerformanceSlo } from "./lib/workspace-performance-slo.mjs";

const PROFILES = new Set([
  "chromium_mock",
  "tauri_hmux",
  "tauri_hmux_single_desktop",
  "tauri_hmux_pressure",
  "tauri_hmux_structured_focus",
]);

export function parseWorkspacePerformanceSloArgs(argv) {
  const options = { profile: "tauri_hmux", report: "-", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--profile" || argument === "--report") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { ...options, help: true };
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!PROFILES.has(options.profile)) {
    throw new Error(`unknown profile: ${options.profile}`);
  }
  return options;
}

export function readWorkspacePerformanceReport(reportPath, stdin = process.stdin) {
  const source = reportPath === "-" ? fs.readFileSync(stdin.fd, "utf8") : fs.readFileSync(reportPath, "utf8");
  if (!source.trim()) throw new Error("workspace performance report is empty");
  const parsed = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("workspace performance report must be a JSON object");
  }
  return parsed;
}

export function formatWorkspacePerformanceSlo(result) {
  const passed = result.failures.length === 0;
  const lines = [
    `workspace performance SLO: ${passed ? "PASS" : "FAIL"} (${result.profile}, ${result.observations.length} checks)`,
  ];
  for (const failure of result.failures) lines.push(`- ${failure}`);
  return lines.join("\n");
}

export function workspacePerformanceSloUsage() {
  return [
    "Usage: node scripts/qa/workspace-performance-slo.mjs [options]",
    "",
    "  --profile chromium_mock|tauri_hmux|tauri_hmux_single_desktop|tauri_hmux_pressure|tauri_hmux_structured_focus",
    "  --report <path|->                    report JSON (default: stdin)",
    "  --json                               print the machine-readable result",
    "",
    "Example:",
    "  dure perf report --json | pnpm perf:workspace:slo -- --profile tauri_hmux",
  ].join("\n");
}

export function runWorkspacePerformanceSlo(argv, io = process) {
  const options = parseWorkspacePerformanceSloArgs(argv);
  if (options.help) {
    io.stdout.write(`${workspacePerformanceSloUsage()}\n`);
    return 0;
  }
  const report = readWorkspacePerformanceReport(options.report, io.stdin);
  const result = evaluateWorkspacePerformanceSlo(report, options.profile);
  io.stdout.write(
    options.json
      ? `${JSON.stringify(result)}\n`
      : `${formatWorkspacePerformanceSlo(result)}\n`,
  );
  return result.failures.length === 0 ? 0 : 1;
}

const executedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (executedDirectly) {
  try {
    process.exitCode = runWorkspacePerformanceSlo(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `workspace performance SLO input error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
