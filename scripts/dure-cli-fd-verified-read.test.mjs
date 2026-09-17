import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readVerifiedDescriptorText } from "../cli/lib/fd-verified-read.mjs";

describe("readVerifiedDescriptorText", () => {
  const cleanups = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()();
  });

  function fixtureFile(content) {
    const root = mkdtempSync(join(tmpdir(), "fd-verified-read-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "payload.json");
    writeFileSync(path, content, { mode: 0o600 });
    const descriptor = openSync(path, "r");
    cleanups.push(() => closeSync(descriptor));
    return { path, descriptor };
  }

  it("returns the full UTF-8 content when the file is unchanged", () => {
    const content = `{"agents":["가","나"],"emoji":"✅"}`;
    const { descriptor } = fixtureFile(content);
    const before = fstatSync(descriptor, { bigint: true });
    expect(readVerifiedDescriptorText(descriptor, before)).toBe(content);
  });

  it("returns null when the file grows after the snapshot", () => {
    const { path, descriptor } = fixtureFile("{}");
    const before = fstatSync(descriptor, { bigint: true });
    appendFileSync(path, "trailing");
    expect(readVerifiedDescriptorText(descriptor, before)).toBeNull();
  });

  it("returns null when the file is truncated after the snapshot", () => {
    const { path, descriptor } = fixtureFile("0123456789");
    const before = fstatSync(descriptor, { bigint: true });
    truncateSync(path, 4);
    expect(readVerifiedDescriptorText(descriptor, before)).toBeNull();
  });

  it("returns null when the file is rewritten in place with the same size", () => {
    const { path, descriptor } = fixtureFile("original!!");
    const before = fstatSync(descriptor, { bigint: true });
    // Same byte length, different content: only mtimeNs/ctimeNs move.
    writeFileSync(path, "tampered!!", { mode: 0o600 });
    expect(readVerifiedDescriptorText(descriptor, before)).toBeNull();
  });
});
