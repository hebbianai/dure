/**
 * A pretend Host for the demo build: the terminal behind every session.
 *
 * It speaks the phone's own transport — complete viewport frames in the
 * terminal state protocol, JSON control records beside them — so the real
 * `structuredTerminal` mounts over it unchanged. What it says is scripted: a
 * transcript per session, an echo of what is typed, a canned answer to Enter.
 *
 * Intent records coming back are decoded with the desktop's own decoder, which
 * is the one thing that keeps this honest: a demo that only *sent* frames
 * would keep working after the input side of the protocol had moved.
 */

import { create } from "@bufbuild/protobuf";
import {
  BufferId,
  CellStyleSchema,
  ColorKind,
  CursorShape,
  CursorStateSchema,
  GraphemeSchema,
  InputModesSchema,
  MouseEncoding,
  MouseTrackingMode,
  RowTermination,
  TerminalColorOverridesSchema,
  TerminalColorSchema,
  TerminalRowSchema,
  TerminalStateRecordSchema,
  TerminalTablesSchema,
  UnderlineKind,
  UnicodeWidthProfileSchema,
  ViewportAnchorStatus,
  ViewportFrameSchema,
} from "@/contracts/terminalStateProtocol";
import { TERMINAL_STATE_PROTOCOL_MINOR } from "@/lib/terminal/protocol/terminalStateLimits";
import {
  decodeTerminalStateRecord,
  encodeTerminalStateRecord,
} from "@/lib/terminal/protocol/terminalStateProtocol";
import type { AttachedSession } from "../ipc";
import type { RemoteSession } from "../sessions";

type Tone = "plain" | "dim" | "accent" | "ok" | "warn" | "bold";

interface Line {
  readonly text: string;
  readonly tone: Tone;
}

interface Runtime {
  lifecycle: "starting" | "running" | "exited";
  activity: "working" | "waiting";
  attention: "none" | "input_required" | "approval_required" | "error";
  attentionId?: string;
  revision: number;
  turns: number;
}

interface Transcript {
  readonly kind: "agent" | "shell";
  readonly promptPrefix: string;
  readonly lines: Line[];
  prompt: string;
  runtime: Runtime;
  /** The approval the agent is waiting on, while it waits. */
  pendingApproval?: string;
  timers: Set<ReturnType<typeof setTimeout>>;
  /** Lines the agent still has to "produce" while it is working. */
  backlog: Line[];
}

interface Attachment {
  readonly id: string;
  readonly session: RemoteSession;
  readonly epoch: string;
  readonly writable: boolean;
  columns: number;
  rows: number;
  /** Rows the viewport sits above the tail. 0 follows the tail. */
  scrollOffset: number;
  projectionRevision: bigint;
  stateRevision: bigint;
  throughOutputSeq: bigint;
  appliedIntentSeq: bigint;
  nextRecordId: bigint;
  queue: Uint8Array[];
  waiter?: (bytes: ArrayBuffer) => void;
  closed: boolean;
}

/** A phone-sized default until the first resize says otherwise. */
const DEFAULT_COLUMNS = 44;
const DEFAULT_ROWS = 28;
const STYLE_INDEX: Record<Tone, number> = { plain: 0, dim: 1, accent: 2, ok: 3, warn: 4, bold: 5 };
const BOLD = 1n << 0n;
const FAINT = 1n << 1n;

function rgb(value: number) {
  return create(TerminalColorSchema, { kind: ColorKind.RGB, value });
}

function styles() {
  return [
    create(CellStyleSchema, { underline: UnderlineKind.NONE }),
    create(CellStyleSchema, { underline: UnderlineKind.NONE, flags: FAINT }),
    create(CellStyleSchema, { underline: UnderlineKind.NONE, foreground: rgb(0x8ab4f8) }),
    create(CellStyleSchema, { underline: UnderlineKind.NONE, foreground: rgb(0x7ed492) }),
    create(CellStyleSchema, { underline: UnderlineKind.NONE, foreground: rgb(0xf2c46d) }),
    create(CellStyleSchema, { underline: UnderlineKind.NONE, flags: BOLD }),
  ];
}

/** Cell width by code point. Hangul, CJK and emoji take two; box drawing one. */
function charWidth(codePoint: number): number {
  if (codePoint < 0x1100) return 1;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

interface Cell {
  readonly text: string;
  readonly width: number;
  readonly tone: Tone;
}

interface PhysicalRow {
  readonly cells: Cell[];
  readonly lineIndex: number;
  readonly offset: number;
  readonly continues: boolean;
  readonly last: boolean;
}

/** One logical line, wrapped at `columns` the way a terminal would. */
function wrap(text: string, tone: Tone, lineIndex: number, columns: number): PhysicalRow[] {
  const rows: PhysicalRow[] = [];
  let cells: Cell[] = [];
  let width = 0;
  let offset = 0;
  for (const grapheme of Array.from(text)) {
    const cellWidth = charWidth(grapheme.codePointAt(0) ?? 0);
    if (width + cellWidth > columns) {
      rows.push({ cells, lineIndex, offset, continues: rows.length > 0, last: false });
      offset += width;
      cells = [];
      width = 0;
    }
    cells.push({ text: grapheme, width: cellWidth, tone });
    width += cellWidth;
  }
  rows.push({ cells, lineIndex, offset, continues: rows.length > 0, last: true });
  return rows;
}

function commandError(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function providerLabel(providerId: string): string {
  const id = providerId.toLowerCase();
  if (id.includes("claude")) return "Claude Code";
  if (id.includes("codex")) return "Codex";
  if (id.includes("gemini")) return "Gemini";
  if (id.includes("kimi")) return "Kimi";
  return providerId;
}

/** The first screen of each session, written once per session id. */
function openingTranscript(session: RemoteSession): Transcript {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const provider = session.provider_id.toLowerCase();
  const shell = provider.includes("shell") || provider === "";
  const title = session.session_name ?? session.session_id;
  const workspace = session.workspace_id;

  if (shell && session.launch_program === "ssh") {
    return {
      kind: "shell",
      promptPrefix: "seung@sdd:~$ ",
      lines: [
        { text: "Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic aarch64)", tone: "dim" },
        { text: "", tone: "plain" },
        { text: "  System load:  0.08    Users logged in: 1", tone: "dim" },
        { text: "  Usage of /:   41.2%   Memory usage:    23%", tone: "dim" },
        { text: "", tone: "plain" },
        { text: "Last login: Sun Sep 14 09:41:07 2026 from 10.0.0.12", tone: "dim" },
      ],
      prompt: "",
      runtime: { lifecycle: "running", activity: "waiting", attention: "none", revision: 1, turns: 0 },
      timers,
      backlog: [],
    };
  }

  if (shell) {
    return {
      kind: "shell",
      promptPrefix: `seung@mac-studio ${workspace} % `,
      lines: [
        { text: "Last login: Sun Sep 14 10:02:11 on ttys004", tone: "dim" },
        { text: `seung@mac-studio ${workspace} % git status -sb`, tone: "plain" },
        { text: "## main...origin/main", tone: "plain" },
        { text: " M src/app.ts", tone: "warn" },
        { text: " M src/styles.css", tone: "warn" },
        { text: `seung@mac-studio ${workspace} % pnpm test -- --run src/home`, tone: "plain" },
        { text: " ✓ src/home.test.ts (14 tests) 212ms", tone: "ok" },
        { text: " Test Files  1 passed (1)", tone: "dim" },
        { text: "      Tests  14 passed (14)", tone: "dim" },
      ],
      prompt: "",
      runtime: { lifecycle: "running", activity: "waiting", attention: "none", revision: 1, turns: 3 },
      timers,
      backlog: [],
    };
  }

  const header: Line[] = [
    { text: `╭─ ${providerLabel(session.provider_id)} · ${workspace}`, tone: "dim" },
    { text: `╰─ /Users/seung/Dev/${workspace}`, tone: "dim" },
    { text: "", tone: "plain" },
  ];

  if (session.session_id === "s-pay-retry") {
    return {
      kind: "agent",
      promptPrefix: "❯ ",
      lines: [
        ...header,
        { text: "❯ 결제 API 재시도를 지수 백오프로 바꿔줘. 4xx는 재시도 제외.", tone: "bold" },
        { text: "", tone: "plain" },
        { text: "● src/payments/retry.ts 읽음", tone: "dim" },
        { text: "● src/payments/backoff.ts 새로 만듦 (+41)", tone: "plain" },
        { text: "● src/payments/retry.ts 수정 (+84 −12)", tone: "plain" },
        { text: "● src/legacy/poller.ts 삭제 (−148)", tone: "plain" },
        { text: "● 테스트 실행: pnpm test src/payments — 12 passed", tone: "ok" },
        { text: "", tone: "plain" },
        { text: "⏺ 승인이 필요해요", tone: "accent" },
        { text: "  git commit -m \"결제 재시도를 지수 백오프로 교체\"", tone: "warn" },
        { text: "  파일 3개 · fix/payment-retry", tone: "dim" },
        { text: "  [y] 허용   [n] 거부", tone: "dim" },
        { text: "", tone: "plain" },
      ],
      prompt: "",
      runtime: {
        lifecycle: "running",
        activity: "waiting",
        attention: "approval_required",
        attentionId: "appr-commit-1",
        revision: 7,
        turns: 2,
      },
      pendingApproval: "appr-commit-1",
      timers,
      backlog: [],
    };
  }

  if (session.session_id === "s-onboarding") {
    return {
      kind: "agent",
      promptPrefix: "❯ ",
      lines: [
        ...header,
        { text: `❯ ${title}`, tone: "bold" },
        { text: "", tone: "plain" },
        { text: "● Notes/2026-09/onboarding.md 읽음", tone: "dim" },
        { text: "● 경쟁 서비스 화면 6개 정리 중…", tone: "dim" },
        { text: "", tone: "plain" },
        { text: "✗ 네트워크 오류: fetch failed (ENOTFOUND)", tone: "warn" },
        { text: "  다시 시도하려면 아무 메시지나 보내세요.", tone: "dim" },
        { text: "", tone: "plain" },
      ],
      prompt: "",
      runtime: { lifecycle: "running", activity: "waiting", attention: "error", revision: 4, turns: 1 },
      timers,
      backlog: [],
    };
  }

  if (session.lifecycle === "exited") {
    return {
      kind: "agent",
      promptPrefix: "❯ ",
      lines: [
        ...header,
        { text: `❯ ${title}`, tone: "bold" },
        { text: "", tone: "plain" },
        { text: "● 랜딩 히어로 문구 3안 작성", tone: "plain" },
        { text: "● docs/landing-copy.md 수정 (+38 −12)", tone: "plain" },
        { text: "✓ 커밋 완료 — 2 files, c41e9d0", tone: "ok" },
        { text: "", tone: "plain" },
        { text: "세션이 종료되었습니다.", tone: "dim" },
      ],
      prompt: "",
      runtime: { lifecycle: "exited", activity: "waiting", attention: "none", revision: 9, turns: 3 },
      timers,
      backlog: [],
    };
  }

  const working = session.session_id === "s-card-tokens" || session.session_id === "s-mobile-folder" ||
    session.session_id === "m-browser-cli";
  const backlog: Line[] = working
    ? [
        { text: "● src/components/card/Card.tsx 읽음", tone: "dim" },
        { text: "● src/components/card/tokens.ts 새로 만듦 (+58)", tone: "plain" },
        { text: "● Card.tsx 수정 (+31 −27)", tone: "plain" },
        { text: "● 테스트 실행: pnpm test src/components/card — 9 passed", tone: "ok" },
        { text: "", tone: "plain" },
        { text: "⏺ 토큰을 tokens.ts 로 모았어요. 레거시 CSS도 지울까요?", tone: "accent" },
        { text: "", tone: "plain" },
      ]
    : [];
  return {
    kind: "agent",
    promptPrefix: "❯ ",
    lines: [
      ...header,
      { text: `❯ ${title}`, tone: "bold" },
      { text: "", tone: "plain" },
      ...(working
        ? [{ text: "● 관련 파일을 찾는 중…", tone: "dim" as Tone }]
        : [
            { text: "● 관련 파일 4개 읽음", tone: "dim" as Tone },
            { text: "● src/toast.ts 수정 (+22 −9)", tone: "plain" as Tone },
            { text: "● src/toast.css 수정 (+14 −3)", tone: "plain" as Tone },
            { text: "✓ 테스트 통과 — 61 files, 803 tests", tone: "ok" as Tone },
            { text: "", tone: "plain" as Tone },
            { text: "⏺ 토스트를 한 가지 모양으로 통일했어요. 모바일에도 적용할까요?", tone: "accent" as Tone },
            { text: "", tone: "plain" as Tone },
          ]),
    ],
    prompt: "",
    runtime: working
      ? { lifecycle: "running", activity: "working", attention: "none", revision: 3, turns: 0 }
      : { lifecycle: "running", activity: "waiting", attention: "input_required", revision: 5, turns: 1 },
    timers,
    backlog,
  };
}

export interface DemoTerminals {
  attach(session: RemoteSession, writable: boolean): AttachedSession;
  detach(attachmentId: string | undefined): string | null;
  next(attachmentId: string): Promise<ArrayBuffer>;
  send(attachmentId: string, record: Uint8Array): string;
}

export function createDemoTerminals(): DemoTerminals {
  const transcripts = new Map<string, Transcript>();
  const attachments = new Map<string, Attachment>();
  /** The one attachment reading each session, by session id. */
  const live = new Map<string, Attachment>();
  let attachmentCounter = 0;

  function transcriptOf(session: RemoteSession): Transcript {
    let transcript = transcripts.get(session.session_id);
    if (!transcript) {
      transcript = openingTranscript(session);
      transcripts.set(session.session_id, transcript);
    }
    return transcript;
  }

  function deliver(attachment: Attachment, bytes: Uint8Array): void {
    if (attachment.closed) return;
    const waiter = attachment.waiter;
    if (waiter) {
      attachment.waiter = undefined;
      waiter(toArrayBuffer(bytes));
      return;
    }
    attachment.queue.push(bytes);
  }

  function frameRecord(attachment: Attachment, transcript: Transcript): Uint8Array {
    const { columns } = attachment;
    const rows = Math.max(1, attachment.rows);
    const physical: PhysicalRow[] = [];
    transcript.lines.forEach((line, index) => {
      physical.push(...wrap(line.text, line.tone, index, columns));
    });
    const promptIndex = transcript.lines.length;
    const promptRows = wrap(transcript.promptPrefix + transcript.prompt, "plain", promptIndex, columns);
    const lastPrompt = promptRows[promptRows.length - 1];
    const lastWidth = lastPrompt.cells.reduce((total, cell) => total + cell.width, 0);
    physical.push(...promptRows);
    // A full last row puts the cursor past the edge; a terminal wraps it down.
    let cursorColumn = lastWidth;
    if (lastWidth >= columns) {
      physical.push({ cells: [], lineIndex: promptIndex, offset: lastPrompt.offset + lastWidth, continues: true, last: true });
      cursorColumn = 0;
    }

    const total = physical.length;
    const maxOffset = Math.max(0, total - rows);
    attachment.scrollOffset = Math.min(Math.max(0, attachment.scrollOffset), maxOffset);
    const end = total - attachment.scrollOffset;
    const start = Math.max(0, end - rows);
    const window = physical.slice(start, end);
    const cursorRow = total - 1 - start;

    attachment.projectionRevision += 1n;
    attachment.stateRevision += 1n;
    attachment.throughOutputSeq += 1n;
    const revision = attachment.projectionRevision;

    const graphemeIndex = new Map<string, number>();
    const graphemes: { text: string; displayWidth: number }[] = [];
    const indexOf = (cell: Cell): number => {
      const key = `${cell.width}:${cell.text}`;
      const known = graphemeIndex.get(key);
      if (known !== undefined) return known;
      graphemes.push({ text: cell.text, displayWidth: cell.width });
      graphemeIndex.set(key, graphemes.length - 1);
      return graphemes.length - 1;
    };

    const frameRows = [];
    for (let index = 0; index < rows; index += 1) {
      const row = window[index];
      const rowId = revision * 1000n + BigInt(index + 1);
      if (!row) {
        frameRows.push(
          create(TerminalRowSchema, {
            rowId,
            logicalLineId: revision * 1000n + 500n + BigInt(index),
            logicalCellOffset: 0,
            logicalCellSpan: 0,
            termination: RowTermination.HARD_BREAK,
            continuesFromPrevious: false,
            cells: [],
          }),
        );
        continue;
      }
      const span = row.cells.reduce((sum, cell) => sum + cell.width, 0);
      frameRows.push(
        create(TerminalRowSchema, {
          rowId,
          logicalLineId: revision * 1000n + BigInt(row.lineIndex + 1),
          logicalCellOffset: row.offset,
          logicalCellSpan: span,
          termination: row.last ? RowTermination.HARD_BREAK : RowTermination.SOFT_WRAP,
          continuesFromPrevious: row.continues && index > 0,
          cells: row.cells.map((cell) => ({ graphemeIndex: indexOf(cell), styleIndex: STYLE_INDEX[cell.tone] })),
        }),
      );
    }

    const followTail = attachment.scrollOffset === 0;
    const record = create(TerminalStateRecordSchema, {
      schemaMinor: TERMINAL_STATE_PROTOCOL_MINOR,
      terminalEpoch: attachment.epoch,
      throughOutputSeq: attachment.throughOutputSeq,
      stateRevision: attachment.stateRevision,
      body: {
        case: "viewportFrame",
        value: create(ViewportFrameSchema, {
          title: transcript.kind === "agent" ? providerLabel(attachment.session.provider_id) : "zsh",
          projectionRevision: revision,
          damageBaseProjectionRevision: 0n,
          canonicalColumns: columns,
          viewportRows: rows,
          activeBuffer: BufferId.NORMAL,
          rows: frameRows,
          tables: create(TerminalTablesSchema, {
            graphemes:
              graphemes.length > 0
                ? graphemes.map((grapheme) => create(GraphemeSchema, grapheme))
                : [create(GraphemeSchema, { text: "", displayWidth: 0 })],
            styles: styles(),
          }),
          cursor: create(CursorStateSchema, {
            row: Math.min(Math.max(0, cursorRow), rows - 1),
            column: cursorColumn,
            visible: cursorRow >= 0 && cursorRow < rows && transcript.runtime.lifecycle !== "exited",
            shape: CursorShape.BLOCK,
          }),
          inputModes: create(InputModesSchema, {
            mouseTracking: MouseTrackingMode.NONE,
            mouseEncoding: MouseEncoding.DEFAULT,
            synchronizedOutput: false,
          }),
          colorOverrides: create(TerminalColorOverridesSchema),
          unicodeWidth: create(UnicodeWidthProfileSchema, {
            unicodeVersion: "15.1.0",
            ambiguousWidth: 1,
            emojiWidth: 2,
          }),
          throughEventId: 0n,
          followTail,
          hasMoreBefore: start > 0,
          hasMoreAfter: end < total,
          appliedIntentSeq: attachment.appliedIntentSeq,
          anchorStatus: followTail ? ViewportAnchorStatus.FOLLOW_TAIL : ViewportAnchorStatus.ANCHORED,
          rowsFromTail: BigInt(attachment.scrollOffset),
          changedRowIndices: [],
        }),
      },
    });
    const recordId = attachment.nextRecordId;
    attachment.nextRecordId += 1n;
    return encodeTerminalStateRecord(recordId, record);
  }

  function runtimeRecord(attachment: Attachment, transcript: Transcript): Uint8Array {
    const runtime = transcript.runtime;
    return new TextEncoder().encode(
      JSON.stringify({
        kind: "control",
        body: {
          kind: "agent_runtime_state",
          payload: {
            terminal_epoch: attachment.epoch,
            revision: String(runtime.revision),
            observed_through_output_seq: String(attachment.throughOutputSeq),
            lifecycle: runtime.lifecycle,
            activity: runtime.activity,
            attention: runtime.attention,
            ...(runtime.attentionId === undefined ? {} : { attention_id: runtime.attentionId }),
            source: "provider_event",
            turn_completed_count: String(runtime.turns),
          },
        },
      }),
    );
  }

  function paint(sessionId: string): void {
    const attachment = live.get(sessionId);
    const transcript = transcripts.get(sessionId);
    if (!attachment || !transcript || attachment.closed) return;
    deliver(attachment, frameRecord(attachment, transcript));
  }

  function announce(sessionId: string, change: Partial<Runtime>): void {
    const transcript = transcripts.get(sessionId);
    if (!transcript) return;
    const next: Runtime = { ...transcript.runtime, ...change, revision: transcript.runtime.revision + 1 };
    if (!("attentionId" in change)) next.attentionId = undefined;
    transcript.runtime = next;
    const attachment = live.get(sessionId);
    if (attachment && !attachment.closed) deliver(attachment, runtimeRecord(attachment, transcript));
  }

  function later(sessionId: string, ms: number, run: () => void): void {
    const transcript = transcripts.get(sessionId);
    if (!transcript) return;
    const timer = setTimeout(() => {
      transcript.timers.delete(timer);
      run();
    }, ms);
    transcript.timers.add(timer);
  }

  function say(sessionId: string, line: Line): void {
    transcripts.get(sessionId)?.lines.push(line);
    paint(sessionId);
  }

  /** A working agent keeps producing its backlog while somebody watches. */
  function drainBacklog(sessionId: string): void {
    const transcript = transcripts.get(sessionId);
    if (transcript?.runtime.activity !== "working") return;
    const nextLine = transcript.backlog.shift();
    if (!nextLine) {
      announce(sessionId, { activity: "waiting", attention: "input_required", turns: transcript.runtime.turns + 1 });
      return;
    }
    say(sessionId, nextLine);
    later(sessionId, 1_600 + Math.random() * 1_400, () => drainBacklog(sessionId));
  }

  function answerAgent(sessionId: string, transcript: Transcript, typed: string): void {
    const approval = transcript.pendingApproval;
    if (approval !== undefined) {
      transcript.pendingApproval = undefined;
      const allowed = /^(y|yes|ok|허용|응|ㅇ)?$/i.test(typed.trim());
      transcript.lines.push({ text: `❯ ${typed}`, tone: "bold" });
      transcript.lines.push(
        allowed
          ? { text: "✓ 커밋 완료 — 3 files, a91f3c2", tone: "ok" }
          : { text: "✗ 커밋을 건너뛰었어요. 변경은 워크트리에 남아 있어요.", tone: "warn" },
      );
      announce(sessionId, { activity: "working", attention: "none" });
      paint(sessionId);
      later(sessionId, 1_300, () => {
        say(sessionId, { text: "", tone: "plain" });
        say(sessionId, {
          text: allowed ? "⏺ 커밋했어요. PR을 열까요?" : "⏺ 알겠어요. 다음은 무엇을 할까요?",
          tone: "accent",
        });
        say(sessionId, { text: "", tone: "plain" });
        announce(sessionId, { activity: "waiting", attention: "input_required", turns: transcript.runtime.turns + 1 });
      });
      return;
    }
    transcript.lines.push({ text: `❯ ${typed}`, tone: "bold" });
    transcript.lines.push({ text: "", tone: "plain" });
    announce(sessionId, { activity: "working", attention: "none" });
    paint(sessionId);
    later(sessionId, 700, () => say(sessionId, { text: "● 알겠어요. 관련 코드를 확인할게요.", tone: "dim" }));
    later(sessionId, 1_900, () => say(sessionId, { text: "● src/app.ts 수정 (+8 −3)", tone: "plain" }));
    later(sessionId, 3_100, () => say(sessionId, { text: "● 테스트 실행: pnpm test — 803 passed", tone: "ok" }));
    later(sessionId, 3_900, () => {
      say(sessionId, { text: "", tone: "plain" });
      say(sessionId, { text: "⏺ 반영했어요. 다른 것도 볼까요?", tone: "accent" });
      say(sessionId, { text: "", tone: "plain" });
      announce(sessionId, { activity: "waiting", attention: "input_required", turns: transcript.runtime.turns + 1 });
    });
  }

  function answerShell(sessionId: string, transcript: Transcript, typed: string): void {
    transcript.lines.push({ text: transcript.promptPrefix + typed, tone: "plain" });
    const command = typed.trim();
    const output: Line[] = [];
    if (command === "") {
      // An empty line is just a new prompt.
    } else if (command === "ls" || command.startsWith("ls ")) {
      output.push({ text: "Dev        Documents  Downloads  Notes      Pictures", tone: "plain" });
    } else if (command === "pwd") {
      output.push({ text: "/Users/seung/Dev/HebbianIDE", tone: "plain" });
    } else if (command.startsWith("git status")) {
      output.push({ text: "## main...origin/main", tone: "plain" });
      output.push({ text: " M src/app.ts", tone: "warn" });
      output.push({ text: " M src/styles.css", tone: "warn" });
    } else if (command.startsWith("git log")) {
      output.push({ text: "a91f3c2 결제 재시도를 지수 백오프로 교체", tone: "plain" });
      output.push({ text: "5d07b1e 타임아웃을 클라이언트 옵션으로 분리", tone: "plain" });
    } else if (command.startsWith("echo ")) {
      output.push({ text: command.slice(5), tone: "plain" });
    } else if (command === "whoami") {
      output.push({ text: "seung", tone: "plain" });
    } else if (command === "date") {
      output.push({ text: new Date().toString(), tone: "plain" });
    } else if (command === "clear") {
      transcript.lines.length = 0;
    } else {
      output.push({ text: `zsh: command not found: ${command.split(" ")[0]}`, tone: "warn" });
    }
    transcript.lines.push(...output);
    paint(sessionId);
  }

  function submit(sessionId: string): void {
    const transcript = transcripts.get(sessionId);
    if (!transcript) return;
    const typed = transcript.prompt;
    transcript.prompt = "";
    if (transcript.runtime.lifecycle === "exited") {
      paint(sessionId);
      return;
    }
    if (transcript.kind === "shell") answerShell(sessionId, transcript, typed);
    else answerAgent(sessionId, transcript, typed);
  }

  function handleKey(sessionId: string, transcript: Transcript, key: string, modifiers: number): void {
    const ctrl = (modifiers & (1 << 2)) !== 0;
    if (ctrl && key.toLowerCase() === "c") {
      transcript.lines.push({ text: `${transcript.promptPrefix}${transcript.prompt}^C`, tone: "dim" });
      transcript.prompt = "";
      for (const timer of transcript.timers) clearTimeout(timer);
      transcript.timers.clear();
      if (transcript.runtime.activity === "working") {
        announce(sessionId, { activity: "waiting", attention: "input_required" });
      }
      paint(sessionId);
      return;
    }
    if (ctrl && key.toLowerCase() === "l") {
      transcript.lines.length = 0;
      paint(sessionId);
      return;
    }
    if (ctrl && key.toLowerCase() === "u") {
      transcript.prompt = "";
      paint(sessionId);
      return;
    }
    switch (key) {
      case "Enter":
        submit(sessionId);
        return;
      case "Backspace":
        transcript.prompt = Array.from(transcript.prompt).slice(0, -1).join("");
        paint(sessionId);
        return;
      case "Tab":
      case "Escape":
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight":
        return;
      default:
        if (key.length === 1 && !ctrl) {
          transcript.prompt += key;
          paint(sessionId);
        }
    }
  }

  return {
    attach(session, writable) {
      // One reader per phone: the real command retires the previous transport
      // before dialing, and a second pull loop would race the first.
      for (const other of attachments.values()) {
        other.closed = true;
        other.waiter = undefined;
      }
      attachments.clear();
      live.clear();
      const transcript = transcriptOf(session);
      attachmentCounter += 1;
      const attachment: Attachment = {
        id: `demo-attach-${attachmentCounter}`,
        session,
        epoch: session.terminal_epoch,
        writable,
        columns: DEFAULT_COLUMNS,
        rows: DEFAULT_ROWS,
        scrollOffset: 0,
        // A replica refuses a zero state revision; the receipt starts at one and
        // the first frame moves past it.
        projectionRevision: 0n,
        stateRevision: 1n,
        throughOutputSeq: 1n,
        appliedIntentSeq: 0n,
        nextRecordId: 1n,
        queue: [],
        closed: false,
      };
      attachments.set(attachment.id, attachment);
      live.set(session.session_id, attachment);
      deliver(attachment, frameRecord(attachment, transcript));
      deliver(attachment, runtimeRecord(attachment, transcript));
      if (transcript.runtime.activity === "working" && transcript.timers.size === 0) {
        later(session.session_id, 1_200, () => drainBacklog(session.session_id));
      }
      return {
        session_id: session.session_id,
        attestation: "demo build — nothing was verified",
        granted_capabilities: writable ? ["terminal_input", "terminal_resize"] : [],
        withheld_over_relay: [],
        role: writable ? "controller" : "observer",
        terminal: {
          attachment_id: attachment.id,
          terminal_epoch: attachment.epoch,
          through_output_seq: "1",
          state_revision: "1",
          initial_delivery_record_count: 2,
        },
      };
    },

    detach(attachmentId) {
      const targets = attachmentId === undefined
        ? [...attachments.values()]
        : [attachments.get(attachmentId)].filter((one): one is Attachment => one !== undefined);
      let retired: string | null = null;
      for (const attachment of targets) {
        attachment.closed = true;
        // Left pending on purpose: the surface is disposed before this runs,
        // and a rejection would land on a screen that has already moved on.
        attachment.waiter = undefined;
        attachments.delete(attachment.id);
        if (live.get(attachment.session.session_id) === attachment) live.delete(attachment.session.session_id);
        retired = attachment.id;
      }
      return retired;
    },

    next(attachmentId) {
      const attachment = attachments.get(attachmentId);
      if (!attachment || attachment.closed) {
        return Promise.reject(commandError("terminal_detached", "이 연결은 이미 끊겼습니다"));
      }
      const queued = attachment.queue.shift();
      if (queued) return Promise.resolve(toArrayBuffer(queued));
      return new Promise((resolve) => {
        attachment.waiter = resolve;
      });
    },

    send(attachmentId, record) {
      const attachment = attachments.get(attachmentId);
      if (!attachment || attachment.closed) throw commandError("terminal_detached", "이 연결은 이미 끊겼습니다");
      const transcript = transcriptOf(attachment.session);
      const sessionId = attachment.session.session_id;
      let decoded: ReturnType<typeof decodeTerminalStateRecord>;
      try {
        decoded = decodeTerminalStateRecord(record);
      } catch {
        return "ignored";
      }
      const body = decoded.record.body;
      if (body.case === "viewportIntent") {
        const intent = body.value;
        if (intent.intentSeq > attachment.appliedIntentSeq) attachment.appliedIntentSeq = intent.intentSeq;
        switch (intent.intent.case) {
          case "scrollRows":
            // Positive asks for rows before the viewport: `terminalScroll` negates the drag.
            attachment.scrollOffset += intent.intent.value.rows;
            break;
          case "setViewportRows":
            attachment.rows = Math.max(1, intent.intent.value.rows);
            break;
          case "followTail":
            attachment.scrollOffset = 0;
            break;
          default:
            break;
        }
        paint(sessionId);
        return "ok";
      }
      if (body.case !== "inputIntent") return "ok";
      const intent = body.value.intent;
      switch (intent.case) {
        case "resize":
          attachment.columns = Math.max(8, intent.value.columns);
          attachment.rows = Math.max(1, intent.value.rows);
          paint(sessionId);
          break;
        case "text":
        case "paste":
          if (!attachment.writable) break;
          transcript.prompt += new TextDecoder().decode(intent.value.utf8);
          paint(sessionId);
          break;
        case "key":
          if (!attachment.writable) break;
          handleKey(sessionId, transcript, intent.value.key, intent.value.modifiers);
          break;
        default:
          break;
      }
      return "ok";
    },
  };
}
