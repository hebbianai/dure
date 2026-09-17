import { describe, expect, it, vi } from "vitest";
import { ExternalFileDropError } from "@/lib/files/externalFileDrop";
import {
  createTerminalFileDropHandlers,
  prepareTerminalFileDrop,
  quoteTerminalFilePath,
} from "@/lib/terminal/interaction/terminalFileDrop";

const file = (name: string, bytes: number[]) => ({
  name,
  size: bytes.length,
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
});

const dragEvent = (files: ReturnType<typeof file>[]) => ({
  dataTransfer: {
    types: ["Files"],
    files: Object.assign({ length: files.length }, files),
  } as unknown as DataTransfer,
  preventDefault: vi.fn(),
  stopImmediatePropagation: vi.fn(),
});

describe("quoteTerminalFilePath", () => {
  it("공백과 작은따옴표가 든 경로도 한 인자로 남는다", () => {
    expect(quoteTerminalFilePath("/tmp/a b.txt")).toBe("'/tmp/a b.txt'");
    expect(quoteTerminalFilePath("/tmp/it's.txt")).toBe("'/tmp/it'\\''s.txt'");
  });
});

describe("prepareTerminalFileDrop", () => {
  it("준비된 경로들을 따옴표로 묶어 한 줄로 만든다", async () => {
    const prepareFiles = vi.fn(async () => ["/tmp/a.txt", "/tmp/b c.txt"]);
    const input = await prepareTerminalFileDrop(
      [file("a.txt", [104]), file("b c.txt", [105])],
      { prepareFiles },
    );

    expect(prepareFiles).toHaveBeenCalledWith([
      { fileName: "a.txt", dataB64: "aA==" },
      { fileName: "b c.txt", dataB64: "aQ==" },
    ]);
    expect(input).toBe("'/tmp/a.txt' '/tmp/b c.txt' ");
  });

  it("준비가 돌려준 원격 경로도 그대로 쓴다 — 로컬/원격을 구분하지 않는다", async () => {
    const prepareFiles = vi.fn(async () => ["/tmp/dure-drop.aB123z/a.txt"]);
    await expect(
      prepareTerminalFileDrop([file("a.txt", [104])], { prepareFiles }),
    ).resolves.toBe("'/tmp/dure-drop.aB123z/a.txt' ");
  });

  it("백엔드가 상대 경로나 개수가 안 맞는 결과를 주면 입력하지 않는다", async () => {
    await expect(
      prepareTerminalFileDrop([file("a.txt", [104])], {
        prepareFiles: async () => ["relative.txt"],
      }),
    ).rejects.toBeInstanceOf(ExternalFileDropError);
    await expect(
      prepareTerminalFileDrop([file("a.txt", [104])], {
        prepareFiles: async () => ["/tmp/a.txt", "/tmp/b.txt"],
      }),
    ).rejects.toBeInstanceOf(ExternalFileDropError);
  });
});

describe("createTerminalFileDropHandlers", () => {
  const build = (
    over: Partial<Parameters<typeof createTerminalFileDropHandlers>[0]> = {},
  ) => {
    const options = {
      prepareFiles: vi.fn(async () => ["/tmp/a.txt"]),
      activateInputTarget: vi.fn(),
      forwardUserInput: vi.fn(),
      onError: vi.fn(),
      ...over,
    };
    return { options, handlers: createTerminalFileDropHandlers(options) };
  };

  it("외부 파일 드래그만 드롭 대상으로 받는다", () => {
    const { handlers } = build();
    const external = {
      dataTransfer: { types: ["Files"] } as unknown as DataTransfer,
      preventDefault: vi.fn(),
    };
    const internal = {
      dataTransfer: {
        types: ["application/x-dure-pane"],
      } as unknown as DataTransfer,
      preventDefault: vi.fn(),
    };

    handlers.onDragOver(external);
    handlers.onDragOver(internal);

    expect(external.preventDefault).toHaveBeenCalledOnce();
    expect(internal.preventDefault).not.toHaveBeenCalled();
  });

  it("앱 내부 pane 드래그는 통과시켜 dockview가 처리하게 둔다", async () => {
    const { options, handlers } = build();
    const event = {
      dataTransfer: {
        types: ["application/x-dure-pane"],
        files: { length: 0 },
      } as unknown as DataTransfer,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    expect(await handlers.onDrop(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(options.forwardUserInput).not.toHaveBeenCalled();
  });

  it("입력 대상을 먼저 활성화하고 준비된 경로를 한 번만 입력한다", async () => {
    const { options, handlers } = build();

    expect(await handlers.onDrop(dragEvent([file("a.txt", [104])]))).toBe(true);

    expect(options.activateInputTarget).toHaveBeenCalledOnce();
    expect(options.forwardUserInput).toHaveBeenCalledExactlyOnceWith(
      "'/tmp/a.txt' ",
    );
    expect(options.onError).not.toHaveBeenCalled();
  });

  it("준비가 실패하면 아무것도 입력하지 않고 보고만 한다", async () => {
    const cause = new Error("save failed");
    const { options, handlers } = build({
      prepareFiles: vi.fn(async () => {
        throw cause;
      }),
    });

    expect(await handlers.onDrop(dragEvent([file("a.txt", [104])]))).toBe(true);

    expect(options.forwardUserInput).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(cause);
  });
});
