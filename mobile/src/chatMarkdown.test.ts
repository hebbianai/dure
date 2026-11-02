import { describe, expect, it } from "vitest";
import { chatBlocks, chatInline } from "./chatMarkdown";

describe("chatBlocks", () => {
  it("splits paragraphs on blank lines and keeps line breaks inside one", () => {
    expect(chatBlocks("First line\nsecond line\n\nNext paragraph")).toEqual([
      { kind: "paragraph", inline: [{ kind: "text", text: "First line\nsecond line" }] },
      { kind: "paragraph", inline: [{ kind: "text", text: "Next paragraph" }] },
    ]);
  });

  it("reads fenced code as code, language and all, without parsing inside it", () => {
    expect(chatBlocks("Run:\n```sh\npnpm test\n- not a list\n```\nDone")).toEqual([
      { kind: "paragraph", inline: [{ kind: "text", text: "Run:" }] },
      { kind: "code", language: "sh", text: "pnpm test\n- not a list" },
      { kind: "paragraph", inline: [{ kind: "text", text: "Done" }] },
    ]);
  });

  it("keeps an unclosed fence as code to the end", () => {
    expect(chatBlocks("```\nhalf")).toEqual([{ kind: "code", text: "half" }]);
  });

  it("groups list items, ordered or not, with indented continuations", () => {
    expect(chatBlocks("- one\n- two\n  more\n\n3. three\n4) four")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two\nmore" }]],
      },
      {
        kind: "list",
        ordered: true,
        start: 3,
        items: [[{ kind: "text", text: "three" }], [{ kind: "text", text: "four" }]],
      },
    ]);
  });

  it("draws a heading as a bold line", () => {
    expect(chatBlocks("## Summary\nAll good")).toEqual([
      { kind: "paragraph", inline: [{ kind: "strong", text: "Summary" }] },
      { kind: "paragraph", inline: [{ kind: "text", text: "All good" }] },
    ]);
  });

  it("leaves HTML as the text it is", () => {
    expect(chatBlocks("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "paragraph", inline: [{ kind: "text", text: "<img src=x onerror=alert(1)>" }] },
    ]);
  });
});

describe("chatInline", () => {
  it("reads inline code and bold", () => {
    expect(chatInline("Use `pnpm test` and **then** lint")).toEqual([
      { kind: "text", text: "Use " },
      { kind: "code", text: "pnpm test" },
      { kind: "text", text: " and " },
      { kind: "strong", text: "then" },
      { kind: "text", text: " lint" },
    ]);
  });

  it("keeps unmatched markers and dunder names as text", () => {
    expect(chatInline("a `b and **c")).toEqual([{ kind: "text", text: "a `b and **c" }]);
    expect(chatInline("call __init__ here")).toEqual([
      { kind: "text", text: "call __init__ here" },
    ]);
  });
});
