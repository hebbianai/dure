import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { readUtf8Stdin } from "../cli/lib/text-input.mjs";

it("preserves UTF-8 characters split across pipe chunks until EOF", async () => {
  const text = "\ufeff한글 👋\n";
  const chunks = [...Buffer.from(text)].map((byte) => Buffer.from([byte]));
  expect(await readUtf8Stdin(Buffer.byteLength(text), Readable.from(chunks))).toBe(text);
});

it("rejects input above the byte cap and malformed UTF-8", async () => {
  await expect(readUtf8Stdin(3, Readable.from([Buffer.from("123"), Buffer.from("4")]))).rejects.toThrow("3 bytes");
  await expect(readUtf8Stdin(3, Readable.from([Buffer.from([0xff])]))).rejects.toThrow();
});
