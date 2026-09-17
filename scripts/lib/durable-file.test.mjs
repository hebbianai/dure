import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fsyncDirectory,
  writeAtomicFile,
  writeExclusiveFile,
} from "./durable-file.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryFile() {
  const root = mkdtempSync(join(tmpdir(), "dure-durable-file-"));
  temporaryRoots.push(root);
  return { root, pathname: join(root, "state.json") };
}

describe("durable file publication", () => {
  it("does not open a directory for an unsupported Windows flush", () => {
    const { root } = temporaryFile();
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });

    try {
      expect(() => fsyncDirectory(join(root, "missing"))).not.toThrow();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("publishes a complete file without replacing an exclusive winner", () => {
    const { root, pathname } = temporaryFile();

    writeExclusiveFile(pathname, "first\n");
    expect(() => writeExclusiveFile(pathname, "second\n")).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(readFileSync(pathname, "utf8")).toBe("first\n");
    expect(readdirSync(root)).toEqual(["state.json"]);
  });

  it("atomically replaces a published file", () => {
    const { root, pathname } = temporaryFile();

    writeAtomicFile(pathname, "first\n");
    writeAtomicFile(pathname, "second\n");
    expect(readFileSync(pathname, "utf8")).toBe("second\n");
    expect(readdirSync(root)).toEqual(["state.json"]);
  });
});
