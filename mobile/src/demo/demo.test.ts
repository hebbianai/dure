import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import {
  primeStructuredTerminalViewport,
  reduceStructuredTerminalViewportRecord,
  terminalViewportInputFence,
} from "@/lib/terminal/state/structuredTerminalViewport";
import {
  encodeTerminalKeyIntent,
  encodeTerminalResizeIntent,
  encodeTerminalTextIntent,
} from "@/lib/terminal/state/terminalInputIntent";
import { parseAgentRuntimeRecord } from "../agentRuntimeState";
import type { HubProbe, SourceControlOutcome } from "../ipc";
import type { RemoteSession } from "../sessions";
import { MACBOOK_HUB_ID, STUDIO_HUB_ID } from "./demoData";
import { DEMO_COMMANDS, demoInvoke } from "./demoInvoke";
import { createDemoTerminals } from "./demoTerminal";

/** Every Rust command `ipc.ts` names, read from its source so the two cannot drift. */
function commandsInIpc(): string[] {
  const source = readFileSync(resolve(process.cwd(), "src/ipc.ts"), "utf8");
  return [...source.matchAll(/invoke<.*?>\(\s*"([^"]+)"/g)].map((match) => match[1]);
}

const SESSION: RemoteSession = {
  session_id: "s-toast",
  session_name: "토스트 통일",
  workspace_id: "Dure",
  session_class: "standalone",
  lifecycle: "running",
  provider_id: "gemini",
  launch_program: null,
  runner_principal: "seung",
  runner_instance: "i-1",
  channel_epoch: "e-1",
  host_instance_id: "box-studio",
  terminal_epoch: "epoch-s-toast",
  capabilities: [],
  ready: true,
};

const ENTER = {
  key: "Enter",
  code: "Enter",
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  repeat: false,
  getModifierState: () => false,
};

describe("demo backend", () => {
  it("answers every command ipc.ts sends", () => {
    const named = commandsInIpc();
    expect(named.length).toBeGreaterThan(30);
    for (const command of named) expect(DEMO_COMMANDS, command).toContain(command);
  });

  it("serves the paired computers and drops the second one after its first answer", async () => {
    const first = await demoInvoke<HubProbe>("hub_open", { id: STUDIO_HUB_ID });
    expect(first.sessions.map((session) => session.session_id)).toContain("s-pay-retry");
    expect(first.layout?.desktop_order).toEqual(["Main", "Personal"]);

    const once = await demoInvoke<HubProbe>("hub_open", { id: MACBOOK_HUB_ID });
    expect(once.sessions).toHaveLength(2);
    await expect(demoInvoke("hub_open", { id: MACBOOK_HUB_ID })).rejects.toMatchObject({
      code: "hub_unreachable",
    });
  });

  it("commits the chosen files out of the change list", async () => {
    const before = await demoInvoke<SourceControlOutcome>("hub_git_status", {
      id: STUDIO_HUB_ID,
      sessionId: "s-pay-retry",
      want: "changes",
    });
    expect(before.files_read).toBe(true);
    expect(before.files.map((file) => file.path)).toContain(".gitignore");

    const after = await demoInvoke<SourceControlOutcome>("hub_scm_write", {
      id: STUDIO_HUB_ID,
      sessionId: "s-pay-retry",
      actionId: "press-1",
      action: { kind: "commit", paths: [".gitignore", "README.md"], message: "정리" },
    });
    expect(after.files.map((file) => file.path)).not.toContain(".gitignore");
    expect(after.files).toHaveLength(before.files.length - 2);
    expect(after.ahead).toBe((before.ahead ?? 0) + 1);
  });

  it("refuses commands it does not know by name", async () => {
    await expect(demoInvoke("no_such_command")).rejects.toMatchObject({ code: "demo_unsupported" });
  });
});

describe("demo terminal", () => {
  /** Rows as the renderer would read them: grapheme text per cell, joined. */
  function rowsOf(bytes: ArrayBuffer) {
    const decoded = decodeTerminalStateRecord(new Uint8Array(bytes));
    if (decoded.record.body.case !== "viewportFrame") throw new Error(decoded.record.body.case);
    const frame = decoded.record.body.value;
    const graphemes = frame.tables?.graphemes ?? [];
    return {
      decoded,
      frame,
      graphemes,
      text: frame.rows.map((row) =>
        row.cells.map((cell) => graphemes[cell.graphemeIndex].text).join(""),
      ),
    };
  }

  it("paints frames the phone's replica accepts, and echoes what is typed", async () => {
    const terminals = createDemoTerminals();
    const attached = terminals.attach(SESSION, true);
    const id = attached.terminal.attachment_id;
    let replica = primeStructuredTerminalViewport(id, {
      terminalEpoch: attached.terminal.terminal_epoch,
      throughOutputSeq: attached.terminal.through_output_seq,
      stateRevision: attached.terminal.state_revision,
    });
    const apply = (bytes: ArrayBuffer) => {
      const { decoded, frame, graphemes, text } = rowsOf(bytes);
      const reduced = reduceStructuredTerminalViewportRecord(replica, id, decoded);
      expect(reduced.status).toBe("applied");
      if (reduced.status === "applied") replica = reduced.replica;
      return { frame, graphemes, text };
    };

    const opening = apply(await terminals.next(id));
    expect(opening.frame.viewportRows).toBe(opening.frame.rows.length);
    expect(opening.text.join("\n")).toContain("❯ 토스트 통일");
    // Wide characters take two cells; no row may run past the columns.
    for (const row of opening.frame.rows) {
      const width = row.cells.reduce(
        (sum, cell) => sum + opening.graphemes[cell.graphemeIndex].displayWidth,
        0,
      );
      expect(width).toBeLessThanOrEqual(opening.frame.canonicalColumns);
      expect(row.logicalCellSpan).toBe(width);
    }

    const runtime = parseAgentRuntimeRecord(new Uint8Array(await terminals.next(id)));
    expect(runtime).toMatchObject({ lifecycle: "running", activity: "waiting" });

    const fence = () => {
      const current = terminalViewportInputFence(replica);
      if (!current) throw new Error("no fence");
      return current;
    };
    terminals.send(id, encodeTerminalResizeIntent(1n, fence(), 40, 20));
    const resized = apply(await terminals.next(id));
    expect(resized.frame.canonicalColumns).toBe(40);
    expect(resized.frame.rows).toHaveLength(20);

    terminals.send(id, encodeTerminalTextIntent(2n, fence(), "안녕"));
    const typed = apply(await terminals.next(id));
    const typedRows = typed.text.filter((row) => row.length > 0);
    const promptRow = typedRows[typedRows.length - 1];
    expect(promptRow).toBe("❯ 안녕");
    expect(typed.frame.cursor?.column).toBe(6);

    terminals.send(id, encodeTerminalKeyIntent(3n, fence(), ENTER));
    // Enter announces the agent working, then paints the submitted line.
    const working = parseAgentRuntimeRecord(new Uint8Array(await terminals.next(id)));
    expect(working).toMatchObject({ activity: "working" });
    const submitted = apply(await terminals.next(id));
    expect(submitted.text).toContain("❯ 안녕");
    const submittedRows = submitted.text.filter((row) => row.length > 0);
    expect(submittedRows[submittedRows.length - 1]).toBe("❯ ");

    expect(terminals.detach(id)).toBe(id);
    await expect(terminals.next(id)).rejects.toMatchObject({ code: "terminal_detached" });
  });

  it("reads only, when attached as an observer", async () => {
    const terminals = createDemoTerminals();
    const attached = terminals.attach(SESSION, false);
    expect(attached.role).toBe("observer");
    const id = attached.terminal.attachment_id;
    await terminals.next(id);
    await terminals.next(id);
    const fence = {
      schemaMinor: 6,
      terminalEpoch: attached.terminal.terminal_epoch,
      throughOutputSeq: BigInt(attached.terminal.through_output_seq),
      stateRevision: BigInt(attached.terminal.state_revision),
    };
    terminals.send(id, encodeTerminalTextIntent(1n, fence, "x"));
    // Nothing to read: an observer's typing never reaches the transcript.
    let answered = false;
    void terminals.next(id).then(() => {
      answered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false);
  });
});
