import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const descriptorPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/qa/workspacePerformance/providers.json",
);

function loadProviderDescriptors() {
  const value = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  if (value?.schemaVersion !== 1 || !Array.isArray(value.providers)) {
    throw new Error("invalid workspace performance provider descriptor");
  }
  const seen = new Set();
  const descriptors = value.providers.map((candidate) => {
    if (
      !candidate ||
      typeof candidate.id !== "string" ||
      !/^[a-z][a-z0-9_]{0,23}$/.test(candidate.id) ||
      !["alternate", "normal"].includes(candidate.resizeBuffer) ||
      seen.has(candidate.id)
    ) {
      throw new Error("invalid workspace performance provider descriptor");
    }
    seen.add(candidate.id);
    return Object.freeze({
      id: candidate.id,
      resizeBuffer: candidate.resizeBuffer,
    });
  });
  if (descriptors.length === 0) {
    throw new Error("workspace performance provider set is empty");
  }
  return Object.freeze(descriptors);
}

export const workspacePerformanceProviders = loadProviderDescriptors();
export const workspacePerformanceProviderNames = Object.freeze(
  workspacePerformanceProviders.map(({ id }) => id),
);

export function workspacePerformanceProviderDescriptor(provider) {
  return workspacePerformanceProviders.find(({ id }) => id === provider);
}

export function workspacePerformanceProviderForCell(desktop, pane) {
  if (!Number.isInteger(desktop) || desktop < 1) {
    throw new Error("desktop must be a positive integer");
  }
  if (!Number.isInteger(pane) || pane < 1) {
    throw new Error("pane must be a positive integer");
  }
  return workspacePerformanceProviders[
    (desktop + pane) % workspacePerformanceProviders.length
  ];
}
