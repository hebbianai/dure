/**
 * The light markdown an agent's message is drawn with in the chat (#361).
 *
 * Paragraphs, fenced code blocks and lists, with inline code and bold inside
 * them. Nothing else: no HTML, no links, no images. The result is data, and the
 * view writes it with `textContent`, so a message can never become markup.
 * Anything this does not recognise reads as the paragraph text it is.
 */

export type ChatInline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string };

export type ChatBlock =
  | { readonly kind: "paragraph"; readonly inline: readonly ChatInline[] }
  | { readonly kind: "code"; readonly text: string; readonly language?: string }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      /** The number the first item carries, for an ordered list. */
      readonly start: number;
      readonly items: readonly (readonly ChatInline[])[];
    };

/**
 * An opening fence and its info string. The info string may hold more than a
 * language (```` ```ts title="a.ts" ````); after a backtick fence it may not
 * hold a backtick, which is how a line of inline code is told from a fence.
 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const UNORDERED = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

interface ListMarker {
  readonly ordered: boolean;
  readonly number: number;
  readonly text: string;
}

function listMarker(line: string): ListMarker | undefined {
  const unordered = UNORDERED.exec(line);
  if (unordered) return { ordered: false, number: 1, text: unordered[1] };
  const ordered = ORDERED.exec(line);
  if (ordered) return { ordered: true, number: Number(ordered[1]), text: ordered[2] };
  return undefined;
}

function openingFence(line: string): { marker: string; language?: string } | undefined {
  const match = FENCE.exec(line);
  if (!match) return undefined;
  const [, marker, info] = match;
  if (marker.startsWith("`") && info.includes("`")) return undefined;
  const language = info.trim().split(/\s+/)[0];
  return language ? { marker, language } : { marker };
}

/**
 * A closing fence is the opening's character, at least as many of them, and
 * nothing else. A ```` ```python ```` line inside the block is content.
 */
function closesFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= marker.length &&
    /^\s{0,3}\S/.test(line) &&
    [...trimmed].every((character) => character === marker[0]);
}

/** Split one message into blocks. Line breaks inside a paragraph are kept. */
export function chatBlocks(source: string): ChatBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ChatBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | undefined;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", inline: chatInline(paragraph.join("\n")) });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({
      kind: "list",
      ordered: list.ordered,
      start: list.start,
      items: list.items.map((item) => chatInline(item)),
    });
    list = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = openingFence(line);
    if (fence) {
      flushParagraph();
      flushList();
      const body: string[] = [];
      index += 1;
      // An unclosed fence runs to the end of the message: an agent cut off
      // mid-block still shows its code as code.
      while (index < lines.length && !closesFence(lines[index], fence.marker)) {
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({
        kind: "code",
        text: body.join("\n"),
        ...(fence.language ? { language: fence.language } : {}),
      });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const marker = listMarker(line);
    if (marker) {
      flushParagraph();
      if (list && list.ordered !== marker.ordered) flushList();
      if (!list) list = { ordered: marker.ordered, start: marker.number, items: [] };
      list.items.push(marker.text);
      continue;
    }
    if (list) {
      // An indented line under an item continues it; anything else ends the list.
      if (/^\s+\S/.test(line)) {
        list.items[list.items.length - 1] += `\n${line.trim()}`;
        continue;
      }
      flushList();
    }
    const heading = HEADING.exec(line);
    if (heading) {
      // A heading reads as a bold line of its own; a chat has no outline.
      flushParagraph();
      blocks.push({ kind: "paragraph", inline: [{ kind: "strong", text: heading[1] }] });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** Inline code and bold. An unmatched marker stays as the character it is. */
export function chatInline(source: string): ChatInline[] {
  const spans: ChatInline[] = [];
  let text = "";
  const pushText = () => {
    if (text) spans.push({ kind: "text", text });
    text = "";
  };
  let index = 0;
  while (index < source.length) {
    if (source[index] === "`") {
      let ticks = 1;
      while (source[index + ticks] === "`") ticks += 1;
      const fence = "`".repeat(ticks);
      const close = source.indexOf(fence, index + ticks);
      if (close > index + ticks) {
        pushText();
        spans.push({ kind: "code", text: source.slice(index + ticks, close).trim() || " " });
        index = close + ticks;
        continue;
      }
      text += fence;
      index += ticks;
      continue;
    }
    // `**` only: `__` is half of every Python dunder an agent mentions.
    if (source.startsWith("**", index)) {
      const close = source.indexOf("**", index + 2);
      if (close > index + 2 && !/\s/.test(source[index + 2])) {
        pushText();
        spans.push({ kind: "strong", text: source.slice(index + 2, close) });
        index = close + 2;
        continue;
      }
    }
    text += source[index];
    index += 1;
  }
  pushText();
  return spans;
}
