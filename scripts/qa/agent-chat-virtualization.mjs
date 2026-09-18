import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, webkit, expect } from "@playwright/test";
import tailwind from "@tailwindcss/vite";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentChatSurface } from "@/components/agents/chat/AgentChatSurface";
import { AgentPendingRequestCard } from "@/components/agents/chat/AgentPendingRequestCard";
import "/src/index.css";
const small = new URLSearchParams(location.search).has("small");
const longList = new URLSearchParams(location.search).has("long-list");
const row = (n) => ({
  cursor: { epoch: "qa", sequence: n },
  item: { itemId: "item-" + n, turnId: "turn-" + Math.floor(n / 10),
    clientMessageId: "message-" + Math.floor(n / 10), providerMessageId: null,
    createdAtMs: n, body: { type: "message", role: !small && !longList && n % 10 === 0 ? "user" : "assistant",
      markdown: "Message " + n + "\\n\\n" + (longList
        ? Array.from({ length: 2000 }, (_, i) => (i + 1) + ". List item **" + (i + 1) + "**").join("\\n")
        : small
        ? Array.from({ length: 20 }, (_, i) => "- List item " + i + " with **detail**").join("\\n")
        : "Variable height transcript content. ".repeat(1 + n % 12)) } }
});
const page = {
  binding: { schemaVersion: 1, interactionSessionId: "qa", agentId: "qa", providerId: "codex",
    executionProfile: { kind: "provider_default" }, providerConversationRef: null,
    runtime: { runtimeGeneration: "qa", providerEpoch: "qa" }, timelineEpoch: "qa",
    bindingRevision: 1, historyComplete: true, createdAtMs: 1, updatedAtMs: 1 },
  rows: Array.from({ length: longList ? 1 : small ? 120 : 1000 }, (_, i) => row(i + 1000)),
  liveText: [], pendingRequests: [], activeTurn: null, latestFailure: null,
  finalCursor: { epoch: "qa", sequence: longList ? 1000 : small ? 1119 : 1999 }, hasMore: true
};
function Fixture() {
  const [value, setValue] = useState(page);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const noop = () => {};
  window.chatQa = {
    retained: () => value.rows.length,
    rewriteList: markdown => setValue(p => ({ ...p, rows: p.rows.map((r, i) => i === 0 ? { ...r, item: { ...r.item, body: { ...r.item.body, markdown } } } : r) })),
    append: () => setValue(p => ({ ...p, rows: [...p.rows, row(p.finalCursor.sequence + 1)],
      finalCursor: { ...p.finalCursor, sequence: p.finalCursor.sequence + 1 } })),
    stream: () => setValue(p => ({ ...p, liveText: [{ streamId: "live", itemId: "live",
      kind: "assistant", text: (p.liveText[0]?.text ?? "Live answer") + "\\n\\n" + "Streaming content. ".repeat(100),
      turnId: null, clientMessageId: null, providerMessageId: null, updatedAtMs: 1 }] })),
    pending: () => setValue({ ...page, hasMore: false, pendingRequests: [{ interactionSessionId: "qa", runtime: page.binding.runtime,
      request: { requestId: "question", kind: "question", turnId: null, clientMessageId: "client", createdAtMs: 1,
        payload: { toolName: "AskUserQuestion", input: { questions: [{ header: "Database", question: "Which database?", multiSelect: false,
          options: [{ label: "SQLite", description: "Local database" }, { label: "Postgres", description: "Server database" }] }] } } } }] }),
    disclosures: () => setValue({ ...page, hasMore: false, binding: { ...page.binding, timelineEpoch: "disclosures" },
      rows: page.rows.map((r, i) => i === 0 ? { ...r, item: { ...r.item, body: { type: "reasoning", text: "Retained reasoning" } } } : i === 1 ? { ...r, item: { ...r.item, body: { type: "tool", toolCallId: "qa-tool", name: "Bash", state: "completed", input: { command: "printf example" }, output: "Restored tool output" } } } : r) }),
    reset: () => setValue({ ...page, binding: { ...page.binding, timelineEpoch: "new-epoch" },
      rows: [row(1)], liveText: [] }),
    toolBurst: (count = 1000) => setValue({ ...page, hasMore: false,
      binding: { ...page.binding, timelineEpoch: "tool-burst" },
      rows: Array.from({ length: count }, (_, i) => ({ ...row(i + 1000),
        item: { ...row(i + 1000).item, turnId: "tools", clientMessageId: "tools",
          body: { type: "tool", toolCallId: "call-" + i, name: "Bash", state: "completed",
            input: { command: "tool-command-" + i }, output: "tool-output-" + i } } })),
      liveText: [], pendingRequests: [], finalCursor: { epoch: "qa", sequence: 999 + count } }),
    updateTool: (index, state, output) => setValue(p => {
      const previous = p.rows.find(r => r.item.body.type === "tool" && r.item.body.toolCallId === "call-" + index);
      const sequence = p.finalCursor.sequence + 1;
      return { ...p, rows: [...p.rows, { ...previous, cursor: { epoch: "qa", sequence },
        item: { ...previous.item, body: { ...previous.item.body, state, output } } }],
        finalCursor: { epoch: "qa", sequence } };
    }),
    afterTools: () => setValue(p => ({ ...p,
      rows: [...p.rows, ...Array.from({ length: 200 }, (_, i) => row(p.finalCursor.sequence + i + 1))],
      finalCursor: { epoch: "qa", sequence: p.finalCursor.sequence + 200 } })),
  };
  const session = { page: value, activeTurn: { turnId: "active", clientMessageId: "active" }, loadingOlder, phase: "ready", reconnecting: false,
    draftIdentity: { agentId: "qa", backendProfileId: "local", interactionSessionId: "qa" },
    sending: false, retryTurnAvailable: false, interrupting: false, queuedMessages: [],
    loadOlder: async () => { setLoadingOlder(true); await Promise.resolve();
      setValue(p => ({ ...p, hasMore: p.rows[0].cursor.sequence > 872, rows: [...Array.from({ length: 128 }, (_, i) => row(p.rows[0].cursor.sequence - 128 + i)), ...p.rows] }));
      setLoadingOlder(false); },
    retryConnection: noop, send: async () => {}, retryTurn: async () => {}, editRetryableTurn: noop,
    answerPending: async () => {}, interrupt: async () => {}, dismissActionError: noop,
    queueMessage: noop, steerOrQueue: async () => "queued", dequeueMessage: noop };
  return <div id="pane" style={{height: 600, width: 720, display: new URLSearchParams(location.search).has("hidden") ? "none" : undefined}}><AgentChatSurface session={session} renderPending={pending => <AgentPendingRequestCard pending={pending} busy={false} onAnswer={noop} />} /></div>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

const server = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  resolve: { alias: { "@": `${root}src` } },
  plugins: [tailwind(), {
    name: "chat-virtualization-fixture",
    enforce: "pre",
    resolveId(id, importer) {
      if (id.endsWith("/__chat_qa.tsx")) return `${root}src/__chat_qa.tsx`;
      if (id.endsWith("/agents/chat/ChatComposer")) return "\0qa-composer";
      if (id === "react-markdown" && importer?.endsWith("/SafeMarkdown.tsx")) return "\0qa-markdown";
    },
    load(id) {
      if (id === `${root}src/__chat_qa.tsx`) return fixture;
      if (id === "\0qa-composer") return "export const ChatComposer = () => null;";
      if (id === "\0qa-markdown") return `
        import Markdown from "react-markdown";
        export default function MeasuredMarkdown(props) {
          window.markdownCalls = (window.markdownCalls ?? 0) + 1;
          return Markdown(props);
        }
      `;
    },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] === "/__chat_qa") {
          res.setHeader("Content-Type", "text/html");
          res.end('<link rel="icon" href="data:,"><div id="root"></div><script type="module" src="/__chat_qa.tsx"></script>');
        } else next();
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  browser = await (process.env.AGENT_CHAT_QA_BROWSER === "webkit" ? webkit : chromium).launch({ headless: true, executablePath: process.env.AGENT_CHAT_QA_EXECUTABLE });
  const tab = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  tab.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  tab.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  await tab.goto(`${server.resolvedUrls.local[0]}__chat_qa?long-list=1`);
  const longScroller = tab.getByRole("log").locator(":scope > div").first();
  await expect(tab.getByText("2000", { exact: true })).toBeVisible();
  const longMetrics = await tab.locator("#pane").evaluate(el => ({
    elements: el.querySelectorAll("*").length,
    listItems: el.querySelectorAll("li").length,
  }));
  console.log(JSON.stringify({ longList: longMetrics }));
  if (process.env.AGENT_CHAT_QA_SCREENSHOT) await tab.screenshot({ path: process.env.AGENT_CHAT_QA_SCREENSHOT.replace(/\.png$/, "-long-list.png") });
  assert.ok(longMetrics.listItems < 100, `Expected a viewport of 2000 list items, got ${longMetrics.listItems}`);
  await longScroller.evaluate(el => { el.scrollTop = 0; });
  await expect(tab.getByText("1", { exact: true })).toBeVisible();
  await expect(tab.getByText("2000", { exact: true })).toHaveCount(0);
  await longScroller.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
  await expect.poll(() => tab.locator("li").count()).toBeGreaterThan(0);
  assert.ok(await tab.locator("li").count() < 100);
  const listAnchor = () => longScroller.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll("li")].find(row => row.getBoundingClientRect().bottom > top);
    return row ? { index: row.getAttribute("aria-posinset"), y: row.getBoundingClientRect().top - top } : null;
  });
  await expect.poll(listAnchor).not.toBeNull();
  const beforeAppend = await listAnchor();
  await tab.evaluate(() => window.chatQa.rewriteList("Message 1000\n\n" + Array.from({ length: 2010 }, (_, i) => (i + 1) + ". List item **" + (i + 1) + "**").join("\n")));
  await expect.poll(listAnchor).toEqual(beforeAppend);
  await tab.locator("#pane").evaluate(el => { el.style.display = "none"; });
  await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await tab.locator("#pane").evaluate(el => { el.style.display = "block"; });
  await expect.poll(listAnchor).toEqual(beforeAppend);
  await tab.getByRole("button", { name: /latest|최신/ }).click();
  await expect(tab.getByText("2010", { exact: true })).toBeVisible();
  await expect.poll(() => longScroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
  await tab.evaluate(() => window.chatQa.rewriteList(Array.from({ length: 2000 }, (_, i) => (i + 1) + ". List item **" + (i + 1) + "** " + "Variable width content. ".repeat(i % 7)).join("\n")));
  await expect(tab.getByText("2000", { exact: true })).toBeVisible();
  await tab.locator("#pane").evaluate(el => { el.style.width = "320px"; });
  await expect.poll(() => longScroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
  await longScroller.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
  await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const variableAnchor = await listAnchor();
  await expect.poll(listAnchor).toEqual(variableAnchor);
  assert.ok(await tab.locator("li").count() < 100);
  await tab.getByRole("button", { name: /latest|최신/ }).click();
  await expect(tab.getByText("2000", { exact: true })).toBeVisible();

  await tab.goto(`${server.resolvedUrls.local[0]}__chat_qa?small=1`);
  await expect(tab.getByText("Message 1119", { exact: true })).toBeVisible();
  const smallScroller = tab.getByRole("log").locator(":scope > div").first();
  const smallDistanceFromEnd = () => smallScroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(smallDistanceFromEnd).toBeLessThan(2);
  const smallMetrics = await tab.evaluate(() => ({
    retained: window.chatQa.retained(),
    parsed: window.markdownCalls,
    mounted: document.querySelectorAll("[data-agent-chat-row-anchors]").length,
    elements: document.getElementById("pane").querySelectorAll("*").length,
  }));
  console.log(JSON.stringify({ smallHistory: smallMetrics }));
  assert.ok(smallMetrics.parsed < 40, `Expected bounded Markdown parsing for 120 long answers, got ${smallMetrics.parsed}`);
  assert.ok(smallMetrics.mounted < 32, `Expected bounded small history DOM, got ${smallMetrics.mounted}`);
  await expect(tab.getByText("Message 1000", { exact: true })).toHaveCount(0);
  await smallScroller.evaluate(el => { el.scrollTop = 0; });
  await expect(tab.getByText("Message 1000", { exact: true })).toBeVisible();
  await expect(tab.getByText("Message 1119", { exact: true })).toHaveCount(0);
  await tab.getByRole("button", { name: /latest|최신/ }).click();
  await expect.poll(smallDistanceFromEnd).toBeLessThan(2);
  // Grow across the former cutoff without replacing the geometry owner.
  for (let i = 0; i < 10; i++) {
    await tab.evaluate(() => window.chatQa.append());
    await expect(tab.getByText(`Message ${1120 + i}`, { exact: true })).toBeVisible();
    await expect.poll(smallDistanceFromEnd).toBeLessThan(2);
  }
  await expect(tab.getByText("Message 1129", { exact: true })).toBeVisible();
  assert.ok(await tab.locator("[data-agent-chat-row-anchors]").count() < 32);
  await tab.evaluate(() => window.chatQa.pending());
  await tab.getByRole("radio", { name: "SQLite", exact: true }).check();
  await tab.evaluate(() => document.activeElement.blur());
  await smallScroller.evaluate(el => { el.scrollTop = 0; });
  await expect(tab.getByText("Message 1000", { exact: true })).toBeVisible();
  await tab.locator("#pane").evaluate(el => { el.style.display = "none"; });
  await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await tab.locator("#pane").evaluate(el => { el.style.display = "block"; });
  await tab.getByRole("button", { name: /latest|최신/ }).click();
  await expect(tab.getByRole("radio", { name: "SQLite", exact: true })).toBeChecked();

  await tab.goto(`${server.resolvedUrls.local[0]}__chat_qa`);
  await tab.getByRole("log").waitFor();
  const settle = () => tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const rows = tab.locator("[data-agent-chat-row-anchors]");
  await rows.first().waitFor();
  const mounted = await rows.count();
  console.log(JSON.stringify({ retained: await tab.evaluate(() => window.chatQa.retained()), mounted }));
  assert.ok(mounted < 128, `Expected bounded mounted history, got ${mounted}`);
  const scroller = tab.getByRole("log").locator(":scope > div").first();
  const distanceFromEnd = () => scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  await expect.poll(distanceFromEnd).toBeLessThan(2);
  await expect(tab.getByText("Message 1999", { exact: true })).toBeVisible();
  await tab.evaluate(() => window.chatQa.append());
  await expect.poll(distanceFromEnd).toBeLessThan(2);
  await expect(tab.getByText(/Message 2000/)).toBeVisible();
  for (let i = 0; i < 3; i++) {
    await tab.evaluate(() => window.chatQa.stream());
    await settle();
    await expect.poll(distanceFromEnd).toBeLessThan(2);
  }
  await tab.locator("#pane").evaluate(el => { el.style.height = "350px"; });
  await expect.poll(distanceFromEnd).toBeLessThan(2);
  await tab.locator("#pane").evaluate(el => { el.style.height = "600px"; el.style.width = "420px"; });
  await expect.poll(distanceFromEnd).toBeLessThan(2);
  await settle();
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
  await settle();
  const visibleAnchor = () => scroller.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll("[data-agent-chat-row-anchors]")].find(row => row.getBoundingClientRect().bottom > top && row.getBoundingClientRect().top < top + el.clientHeight);
    return row ? { key: row.dataset.agentChatRowAnchors, y: row.getBoundingClientRect().top - top } : null;
  });
  await expect.poll(visibleAnchor).not.toBeNull();
  const reading = await visibleAnchor();
  await tab.evaluate(() => window.chatQa.stream());
  await settle();
  await expect.poll(visibleAnchor).toEqual(reading);
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await expect(tab.getByText(/Message 1000/)).toBeVisible();
  const beforePrepend = await visibleAnchor();
  await tab.getByRole("button").filter({ hasText: /earlier|이전/ }).click();
  await expect.poll(() => tab.evaluate(() => window.chatQa.retained())).toBe(1129);
  await expect.poll(() => tab.locator(`[data-agent-chat-row-anchors="${beforePrepend.key}"]`).evaluate(el => el.getBoundingClientRect().top)).toBeCloseTo(beforePrepend.y, 0);
  assert.ok(await rows.count() < 128);
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await expect(tab.getByText(/Message 872/)).toBeVisible();
  const beforeFinalPrepend = await visibleAnchor();
  await tab.getByRole("button").filter({ hasText: /earlier|이전/ }).click();
  await expect.poll(() => tab.evaluate(() => window.chatQa.retained())).toBe(1257);
  await expect.poll(() => tab.locator(`[data-agent-chat-row-anchors="${beforeFinalPrepend.key}"]`).evaluate(el => el.getBoundingClientRect().top)).toBeCloseTo(beforeFinalPrepend.y, 0);
  await tab.getByRole("button", { name: /latest|최신/ }).click();
  await expect.poll(distanceFromEnd).toBeLessThan(2);
  await tab.evaluate(() => window.chatQa.reset());
  await expect(tab.getByText("Message 1", { exact: true })).toBeVisible();
  await tab.evaluate(() => window.chatQa.disclosures());
  await settle();
  await scroller.evaluate(el => { el.scrollTop = 0; });
  const disclosure = tab.locator("details").first();
  await disclosure.locator("summary").click();
  await expect(disclosure).toHaveAttribute("open", "");
  await disclosure.locator("summary").focus();
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await settle();
  await expect(disclosure.locator("summary")).toBeFocused();
  await tab.evaluate(() => document.activeElement.blur());
  await settle();
  await expect(tab.getByText("Retained reasoning", { exact: true })).toHaveCount(0);
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await expect(tab.getByText("Retained reasoning", { exact: true })).toBeVisible();
  const tool = tab.locator('[data-agent-chat-row-anchors="qa:1001"]');
  await tool.locator("summary").first().click();
  await tool.locator("details details > summary").click();
  await expect(tab.getByText(/Restored tool output/)).toBeVisible();
  await tab.evaluate(() => document.activeElement.blur());
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(tab.getByText(/Restored tool output/)).toHaveCount(0);
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await expect(tab.getByText(/Restored tool output/)).toBeVisible();
  await tab.evaluate(() => window.chatQa.pending());
  await tab.getByRole("radio", { name: "SQLite", exact: true }).check();
  await tab.evaluate(() => document.activeElement.blur());
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await expect(tab.getByText(/Message 1000/)).toBeVisible();
  await tab.getByRole("button", { name: /latest|최신/ }).click();
  await expect(tab.getByRole("radio", { name: "SQLite", exact: true })).toBeChecked();
  await expect.poll(distanceFromEnd).toBeLessThan(2);
  await settle();
  await expect(tab.getByText("Message 1999", { exact: true })).toBeVisible();

  if (process.env.AGENT_CHAT_QA_SCREENSHOT) await tab.screenshot({ path: process.env.AGENT_CHAT_QA_SCREENSHOT });
  await tab.goto(`${server.resolvedUrls.local[0]}__chat_qa?hidden=1`);
  await expect.poll(() => tab.evaluate(() => window.chatQa?.retained())).toBe(1000);
  await tab.locator("#pane").evaluate(el => { el.style.display = "block"; });
  await expect(tab.getByText("Message 1999", { exact: true })).toBeVisible();
  await expect.poll(distanceFromEnd).toBeLessThan(2);
  await settle();
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
  await settle();
  await expect.poll(visibleAnchor).not.toBeNull();
  const beforeHide = await visibleAnchor();
  await tab.locator("#pane").evaluate(el => { el.style.display = "none"; });
  await settle();
  await tab.locator("#pane").evaluate(el => { el.style.display = "block"; });
  await expect.poll(visibleAnchor).toEqual(beforeHide);
  await tab.evaluate(() => window.chatQa.toolBurst());
  const burst = tab.locator('details[class~="group/burst"]');
  await burst.locator(":scope > summary").click();
  await burst.locator("details").first().waitFor({ state: "attached" });
  const burstMetrics = await burst.evaluate(el => ({
    calls: 1000,
    mounted: el.querySelectorAll("details").length,
    elements: el.querySelectorAll("*").length,
  }));
  console.log(JSON.stringify({ toolBurst: burstMetrics }));
  assert.ok(burstMetrics.mounted < 80, `Expected bounded tool rows, got ${burstMetrics.mounted}`);
  const toolViewport = burst.getByRole("region");
  const command = (index) => burst.getByText(`tool-command-${index}`, { exact: true });
  await command(0).click();
  await expect(burst.getByText(/tool-output-0/)).toBeVisible();
  await expect.poll(() => burst.evaluate(el => {
    const first = el.querySelector('[data-index="0"]');
    const next = el.querySelector('[data-index="1"]');
    return next.getBoundingClientRect().top - first.getBoundingClientRect().bottom;
  })).toBeGreaterThanOrEqual(-1);

  await toolViewport.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
  const visibleTool = () => toolViewport.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll("[data-index]")].find(row =>
      row.getBoundingClientRect().bottom > top + 1 && row.getBoundingClientRect().top < top + el.clientHeight);
    return row ? { index: Number(row.dataset.index), y: row.getBoundingClientRect().top - top } : null;
  });
  await expect.poll(visibleTool).not.toBeNull();
  const middle = await visibleTool();
  assert.ok(middle.index > 100 && middle.index < 900);
  await command(middle.index).locator("..").focus();
  await toolViewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(command(999)).toBeVisible();
  await expect(command(middle.index).locator("..")).toBeFocused();
  await tab.evaluate(() => document.activeElement.blur());
  await expect(command(middle.index)).toHaveCount(0);
  assert.ok(await burst.locator("details").count() < 80);
  await command(999).click();
  await toolViewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(burst.getByText(/tool-output-999/)).toBeVisible();
  await tab.evaluate(() => window.chatQa.updateTool(999, "running", "Live tool result"));
  await expect(burst.getByText(/Live tool result/)).toBeVisible();
  await tab.evaluate(() => window.chatQa.updateTool(999, "failed", "Failed tool result"));
  await expect(burst.getByText(/Failed tool result/)).toBeVisible();
  await command(999).click();
  await expect(burst.getByText(/Failed tool result/)).toHaveCount(0);
  await tab.evaluate(() => window.chatQa.updateTool(999, "failed", "Latest tool failure"));
  await expect(burst.getByText(/Latest tool failure/)).toHaveCount(0);

  await toolViewport.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
  await settle();
  const beforeCollapse = await visibleTool();
  await burst.locator(":scope > summary").click();
  await expect(toolViewport).toHaveCount(0);
  await burst.locator(":scope > summary").click();
  await expect.poll(visibleTool).toEqual(beforeCollapse);
  await tab.locator("#pane").evaluate(el => { el.style.display = "none"; });
  await settle();
  await tab.locator("#pane").evaluate(el => { el.style.display = "block"; });
  await expect.poll(visibleTool).toEqual(beforeCollapse);
  await tab.evaluate(() => document.activeElement.blur());
  await tab.evaluate(() => window.chatQa.afterTools());
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(toolViewport).toHaveCount(0);
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await expect.poll(visibleTool).toEqual(beforeCollapse);
  await toolViewport.evaluate(el => { el.scrollTop = 0; });
  await expect(burst.getByText(/tool-output-0/)).toBeVisible();
  await command(0).locator("..").focus();
  // Native tab navigation advances into overscan and brings later calls into view.
  for (let i = 0; i < 45; i++) {
    await tab.keyboard.press("Tab");
    await expect(command(i + 1).locator("..")).toBeFocused();
  }
  for (let i = 44; i >= 0; i--) {
    await tab.keyboard.press("Shift+Tab");
    await expect(command(i).locator("..")).toBeFocused();
  }
  await tab.evaluate(() => document.activeElement.blur());
  await toolViewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(command(999)).toBeVisible();
  await expect(burst.getByText(/Latest tool failure/)).toHaveCount(0);
  await command(999).click();
  await toolViewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(burst.getByText(/Latest tool failure/)).toBeVisible();
  await burst.getByText(/Latest tool failure/).scrollIntoViewIfNeeded();
  await expect(burst.getByText(/Latest tool failure/)).toBeInViewport();
  if (process.env.AGENT_CHAT_QA_SCREENSHOT) await tab.screenshot({ path: process.env.AGENT_CHAT_QA_SCREENSHOT.replace(/\.png$/, "-tools.png") });
  console.log("PASS: tool burst DOM bound, variable heights, keyboard/focus, live failures, disclosure and viewport restoration");
  await tab.evaluate(() => window.chatQa.reset());
  await expect(burst).toHaveCount(0);
  await tab.evaluate(() => window.chatQa.toolBurst(40));
  await burst.locator(":scope > summary").click();
  await expect(burst.locator("details")).toHaveCount(40);
  await command(0).click();
  await expect(burst.getByText(/tool-output-0/)).toBeVisible();
  await tab.evaluate(() => window.chatQa.toolBurst(41));
  await expect(toolViewport).toBeVisible();
  await expect(burst.getByText(/tool-output-0/)).toBeVisible();
  await tab.evaluate(() => window.chatQa.updateTool(40, "failed", "New tool failure"));
  await toolViewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(burst.getByText(/New tool failure/)).toBeVisible();
  console.log("PASS: small burst growth retains disclosures and newly mounted failures open");
  assert.deepEqual(errors, []);
  console.log("PASS: bounded DOM, pagination anchors, live tail, resize, disclosure/focus, pending answers and visibility transitions");
} finally {
  await browser?.close();
  await server.close();
}
