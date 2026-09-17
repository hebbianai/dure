import { describe, expect, it, vi } from "vitest";
import {
  MAX_EXTERNAL_DROP_BYTES,
  prepareDroppedFilePayloads,
  type ExternalFileDropError,
} from "./externalFileDrop";

function file(name: string, bytes: number[]): File {
  return new File([new Uint8Array(bytes)], name);
}

describe("external file drop", () => {
  it("encodes files in order without changing their names", async () => {
    await expect(
      prepareDroppedFilePayloads([
        file("hello world.txt", [1, 2]),
        file("한글's.png", [3]),
      ]),
    ).resolves.toEqual([
      { fileName: "hello world.txt", dataB64: "AQI=" },
      { fileName: "한글's.png", dataB64: "Aw==" },
    ]);
  });

  it("rejects an oversized batch before reading any file", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const files = [
      { name: "first.bin", size: MAX_EXTERNAL_DROP_BYTES, arrayBuffer },
      { name: "second.bin", size: 1, arrayBuffer },
    ];

    await expect(prepareDroppedFilePayloads(files)).rejects.toMatchObject({
      code: "total_too_large",
    } satisfies Partial<ExternalFileDropError>);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
