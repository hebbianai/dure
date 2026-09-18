// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FocusContext } from "@/lib/workspace/focusContext";
import type { ExecResult } from "@/lib/ipc/hmuxContracts";

const mocks = vi.hoisted(() => ({
  focus: { cwd: "/one", source: "local", label: "One" } as FocusContext | null,
  execute: vi.fn(), open: vi.fn(), save: vi.fn(),
}));
vi.mock("@/components/search/useSearchPaneState", () => ({ useSearchPaneState: () => ({ focus: mocks.focus, currentSpaceId: () => "desk" }) }));
vi.mock("@/lib/workspace/workspaceCommand", () => ({ runWorkspaceCommand: mocks.execute }));
vi.mock("@/lib/files/fileViewerPane", () => ({ openFileViewer: mocks.open }));
vi.mock("@/lib/ipc", () => ({ saveTempFile: mocks.save }));
import { SearchPane } from "./SearchPane";
import { t } from "@/lib/i18n";
import { focusByKeyboard } from "@/test/keyboardFocus";
import { OVERFLOW_REVEAL_DELAY_MS } from "@/components/ui/overflow-reveal-text";

function deferred() {
  let resolve!: (result: ExecResult) => void;
  const promise = new Promise<ExecResult>((done) => { resolve = done; });
  return { promise, resolve };
}
function search(query = "needle") {
  const input = screen.getByPlaceholderText(t("search.pane.title"));
  fireEvent.change(input, { target: { value: query } });
  fireEvent.keyDown(input, { key: "Enter" });
  return input;
}
const matches = { stdout: "./old.ts:1:needle\n", stderr: "", code: 0 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.focus = { cwd: "/one", source: "local", label: "One" };
  mocks.execute.mockResolvedValue(matches);
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const optionLabels = [
  "search.options.matchCase",
  "search.options.wholeWord",
  "search.replace.preserveCase",
] as const;

it.each(optionLabels)("announces the selected state of %s when toggled", (label) => {
  render(<SearchPane />);
  fireEvent.click(screen.getByRole("button", { name: t("search.replace.action") }));
  const option = screen.getByRole("button", { name: t(label) });

  expect(option.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(option);
  expect(option.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(option);
  expect(option.getAttribute("aria-pressed")).toBe("false");
});

it.each(optionLabels)("shows the shared hint for %s on focus", (label) => {
  render(<SearchPane />);
  fireEvent.click(screen.getByRole("button", { name: t("search.replace.action") }));
  const option = screen.getByRole("button", { name: t(label) });

  focusByKeyboard(option);
  expect(screen.getByRole("tooltip").textContent).toBe(t(label));
  expect(option.getAttribute("title")).toBe("");
  act(() => option.blur());
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("reveals the full highlighted match on hover without changing the opened file", async () => {
  mocks.execute.mockResolvedValue({ stdout: "./old.ts:1:a long needle with hidden trailing text\n", stderr: "", code: 0 });
  render(<SearchPane />);
  search();
  const row = await findMatchRow("old.ts:1");
  const highlight = screen.getByText("needle", { selector: "span" });
  const content = highlight.parentElement!;
  const viewport = content.parentElement!;
  Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 });
  Object.defineProperty(content, "scrollWidth", { configurable: true, value: 320 });
  vi.useFakeTimers();
  fireEvent.pointerEnter(viewport, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(OVERFLOW_REVEAL_DELAY_MS));
  expect(content.style.transform).toBe("translateX(-220px)");
  expect(content.textContent).toBe("a long needle with hidden trailing text");
  fireEvent.click(highlight);
  expect(mocks.open).toHaveBeenCalledWith("desk", { path: "/one/old.ts", source: "local", hostId: undefined });
  expect(row.contains(highlight)).toBe(true);
});

it.each(["escape", "empty"])("clearing by %s invalidates a pending search", async (method) => {
  const pending = deferred();
  mocks.execute.mockReturnValue(pending.promise);
  render(<SearchPane />);
  const input = search();
  if (method === "escape") fireEvent.keyDown(input, { key: "Escape" });
  else fireEvent.change(input, { target: { value: "" } });
  await act(async () => pending.resolve(matches));
  expect(matchRow("old.ts:1")).toBeNull();
});

/** 결과 행은 `data-match="file:line"`으로 짚는다 — OS 툴팁 title은 2026-09-09에
 *  걷어냈다. */
const matchRow = (id: string) =>
  document.querySelector<HTMLElement>(`[data-match="${id}"]`);
const findMatchRow = (id: string) =>
  waitFor(() => {
    const el = matchRow(id);
    if (!el) throw new Error(`match row missing: ${id}`);
    return el;
  });

it("does not display previous-folder results after target change and late completion", async () => {
  const pending = deferred();
  mocks.execute.mockReturnValue(pending.promise);
  const view = render(<SearchPane />);
  search();
  mocks.focus = { cwd: "/two", source: "local", label: "Two" };
  view.rerender(<SearchPane />);
  await act(async () => pending.resolve(matches));
  expect(matchRow("old.ts:1")).toBeNull();
});

it("replaces the displayed snapshot query even while a new query is only a draft", async () => {
  render(<SearchPane />);
  const input = search();
  await findMatchRow("old.ts:1");
  fireEvent.change(input, { target: { value: "different" } });
  fireEvent.click(screen.getByRole("button", { name: t("search.replace.action") }));
  fireEvent.change(screen.getByPlaceholderText(t("search.replace.action")), { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: t("search.replace.all") }));
  fireEvent.click(screen.getByText(t("search.replace.action"), { selector: "button" }));
  await act(async () => {});
  const replace = mocks.execute.mock.calls.find(([, command]) => command.includes("perl -pi"));
  expect(replace?.[0]).toMatchObject({ cwd: "/one", source: "local" });
  expect(replace?.[1]).toContain("s{needle}{new}");
});

it("opens and exports the displayed result using its captured path and query", async () => {
  mocks.save.mockResolvedValue("/tmp/search-results.md");
  render(<SearchPane />);
  const input = search();
  fireEvent.click(await findMatchRow("old.ts:1"));
  expect(mocks.open).toHaveBeenCalledWith("desk", { path: "/one/old.ts", source: "local", hostId: undefined });
  fireEvent.change(input, { target: { value: "draft" } });
  fireEvent.click(screen.getByText(t("search.results.openInEditor")));
  await act(async () => {});
  const text = new TextDecoder().decode(Uint8Array.from(atob(mocks.save.mock.calls[0][0].dataB64), (char) => char.charCodeAt(0)));
  expect(text).toContain('"needle" — /one');
  expect(text).toContain("## old.ts");
  expect(mocks.open).toHaveBeenLastCalledWith("desk", { path: "/tmp/search-results.md", source: "local" });
});

it("disarms replacement when its target changes", async () => {
  const view = render(<SearchPane />);
  search();
  await findMatchRow("old.ts:1");
  fireEvent.click(screen.getByRole("button", { name: t("search.replace.action") }));
  fireEvent.click(screen.getByRole("button", { name: t("search.replace.all") }));
  mocks.focus = { cwd: "/two", source: "ssh", hostId: "remote", label: "Two" };
  view.rerender(<SearchPane />);
  expect(screen.queryByText(t("search.replace.action"), { selector: "button" })).toBeNull();
  expect(matchRow("old.ts:1")).toBeNull();
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});
