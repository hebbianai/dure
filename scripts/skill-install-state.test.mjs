import { describe, expect, it } from "vitest";
import {
  SKILL_RECEIPT_SCHEMA,
  isSkillReceipt,
  skillInstallState,
} from "../cli/lib/contracts/skill-install.mjs";

const D1 = "a".repeat(64);
const D2 = "b".repeat(64);

describe("skillInstallState", () => {
  it.each([
    ["current",   { diskDigest: D1, receiptDigest: D1, bundleDigest: D1 }],
    ["outdated",  { diskDigest: D1, receiptDigest: D1, bundleDigest: D2 }],
    ["modified",  { diskDigest: D2, receiptDigest: D1, bundleDigest: D1 }],
    ["modified",  { diskDigest: D2, receiptDigest: D1, bundleDigest: D2 }],
    ["missing",   { diskDigest: null, receiptDigest: D1, bundleDigest: D1 }],
    ["missing",   { diskDigest: null, receiptDigest: null, bundleDigest: D1 }],
    ["current",   { diskDigest: D1, receiptDigest: null, bundleDigest: D1 }],
    ["unmanaged", { diskDigest: D2, receiptDigest: null, bundleDigest: D1 }],
    // `""` is not the contract's spelling of "absent" (`null` is), but the
    // falsy checks in skillInstallState cannot tell "" from null. This row
    // pins that conflation as an assertion, not just as a comment, so a
    // future reader sees the actual behavior rather than trusting prose.
    ["missing",   { diskDigest: "", receiptDigest: D1, bundleDigest: D1 }],
  ])("is %s", (expected, input) => {
    expect(skillInstallState(input)).toBe(expected);
  });
});

describe("isSkillReceipt", () => {
  const VALID_RECEIPT = Object.freeze({
    schemaVersion: SKILL_RECEIPT_SCHEMA,
    name: "dure",
    provider: "claude",
    target: "global",
    digest: D1,
    cliVersion: "1.2.3",
    installedAt: "2026-09-16T00:00:00.000Z",
  });

  it("is true for a valid receipt", () => {
    expect(isSkillReceipt(VALID_RECEIPT)).toBe(true);
  });

  it("is false for the wrong schemaVersion", () => {
    expect(isSkillReceipt({ ...VALID_RECEIPT, schemaVersion: 2 })).toBe(false);
  });

  it("is false when schemaVersion is the string \"1\" instead of the number", () => {
    // Receipts are read back from JSON on disk, so a string where a number
    // belongs is a real corruption shape (e.g. a hand edit, or a future
    // schema writing the field as text), not a hypothetical.
    expect(isSkillReceipt({ ...VALID_RECEIPT, schemaVersion: "1" })).toBe(false);
  });

  it("is false for a digest that is not 64 hex characters", () => {
    expect(isSkillReceipt({ ...VALID_RECEIPT, digest: "a".repeat(63) })).toBe(false);
  });

  it("is false when a required field is missing", () => {
    const { provider, ...withoutProvider } = VALID_RECEIPT;
    expect(isSkillReceipt(withoutProvider)).toBe(false);
  });

  it.each([
    ["null", null],
    ["a primitive", "not-a-receipt"],
    ["an array", []],
  ])("is false for %s", (_label, value) => {
    expect(isSkillReceipt(value)).toBe(false);
  });
});
