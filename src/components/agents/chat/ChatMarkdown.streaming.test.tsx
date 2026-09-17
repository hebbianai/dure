// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { StrictMode } from "react";
import Markdown from "react-markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMarkdown } from "@/components/agents/chat/ChatMarkdown";
import { WorkspaceRuntimeProvider } from "@/components/workspace/WorkspaceRuntimeContext";
import { openExternalUrl } from "@/lib/platform/externalOpen";
import { TerminalPresentationRoleStore } from "@/lib/terminal/presentation/terminalPresentationRoleStore";

vi.mock("react-markdown", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-markdown")>();
	return { ...actual, default: vi.fn(actual.default) };
});

vi.mock("@/lib/platform/externalOpen", () => ({ openExternalUrl: vi.fn() }));

const longAnswer = `## Answer\n\n${"A paragraph with **Markdown** and `code`.\n\n".repeat(250)}`;

describe("ChatMarkdown", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("coalesces continuous fragments without postponing the latest pending text", () => {
		const view = render(<ChatMarkdown markdown={longAnswer} streaming />);
		vi.mocked(Markdown).mockClear();
		for (let fragment = 1; fragment <= 12; fragment++) {
			view.rerender(
				<ChatMarkdown
					markdown={`${longAnswer}Fragment ${fragment}`}
					streaming
				/>,
			);
			act(() => vi.advanceTimersByTime(20));
		}
		expect(Markdown).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(10));
		expect(Markdown).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Fragment 12")).toBeTruthy();
		view.rerender(
			<ChatMarkdown markdown={`${longAnswer}Last fragment`} streaming />,
		);
		act(() => vi.advanceTimersByTime(250));
		expect(Markdown).toHaveBeenCalledTimes(2);
		expect(screen.getByText("Last fragment")).toBeTruthy();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels pending parsing while hidden and renders the latest snapshot immediately on reveal", () => {
		const roles = new TerminalPresentationRoleStore();
		const content = (active: boolean, markdown: string) => (
			<WorkspaceRuntimeProvider
				desktopId="chat"
				active={active}
				presentationRoleStore={roles}
				commitLayout={() => true}
			>
				<ChatMarkdown markdown={markdown} streaming />
			</WorkspaceRuntimeProvider>
		);
		const view = render(content(true, longAnswer));
		view.rerender(content(true, `${longAnswer}Pending before hide`));
		expect(vi.getTimerCount()).toBe(1);
		view.rerender(content(false, `${longAnswer}Pending before hide`));
		vi.mocked(Markdown).mockClear();
		expect(vi.getTimerCount()).toBe(0);
		for (let fragment = 1; fragment <= 20; fragment++) {
			view.rerender(content(false, `${longAnswer}Hidden fragment ${fragment}`));
			act(() => vi.advanceTimersByTime(50));
		}
		expect(Markdown).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		view.rerender(content(true, `${longAnswer}Hidden fragment 20`));
		expect(screen.getByText("Hidden fragment 20")).toBeTruthy();
		expect(Markdown).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		view.rerender(content(true, `${longAnswer}Visible again`));
		expect(screen.queryByText("Visible again")).toBeNull();
		act(() => vi.advanceTimersByTime(250));
		expect(screen.getByText("Visible again")).toBeTruthy();
	});

	it("defers short updates and completion while hidden, then reveals the exact final link", () => {
		const roles = new TerminalPresentationRoleStore();
		const content = (active: boolean, markdown: string, streaming = true) => (
			<WorkspaceRuntimeProvider
				desktopId="chat"
				active={active}
				frozen={!active}
				presentationRoleStore={roles}
				commitLayout={() => true}
			>
				<ChatMarkdown markdown={markdown} streaming={streaming} />
			</WorkspaceRuntimeProvider>
		);
		const view = render(content(true, "Visible start"));
		view.rerender(content(false, "Visible start"));
		vi.mocked(Markdown).mockClear();
		view.rerender(content(false, "Hidden short update"));
		const final = "**Finished** [Docs](https://example.com/hidden-final)";
		view.rerender(content(false, final, false));
		act(() => vi.advanceTimersByTime(500));
		expect(Markdown).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		view.rerender(content(true, final, false));
		expect(Markdown).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Finished").tagName).toBe("STRONG");
		fireEvent.click(screen.getByRole("button", { name: /Docs/ }));
		expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(
			"https://example.com/hidden-final",
		);
	});

	it("does no initial or replacement parsing in a hidden workspace", () => {
		const roles = new TerminalPresentationRoleStore();
		const content = (active: boolean, key: string, markdown: string) => (
			<WorkspaceRuntimeProvider
				desktopId="chat"
				active={active}
				presentationRoleStore={roles}
				commitLayout={() => true}
			>
				<ChatMarkdown key={key} markdown={markdown} streaming />
			</WorkspaceRuntimeProvider>
		);
		const view = render(content(false, "old", longAnswer));
		view.rerender(content(false, "new", `${longAnswer}Replacement`));
		view.rerender(content(false, "new", `${longAnswer}Latest replacement`));
		act(() => vi.advanceTimersByTime(500));
		expect(Markdown).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		view.rerender(content(true, "new", `${longAnswer}Latest replacement`));
		expect(Markdown).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Latest replacement")).toBeTruthy();
	});

	it("shows short replies immediately, including when a long head is cleared", () => {
		const view = render(<ChatMarkdown markdown="Start" streaming />);
		view.rerender(<ChatMarkdown markdown="**Next**" streaming />);
		expect(screen.getByText("Next").tagName).toBe("STRONG");
		view.rerender(<ChatMarkdown markdown={longAnswer} streaming />);
		view.rerender(<ChatMarkdown markdown="" streaming />);
		act(() => vi.advanceTimersByTime(300));
		expect(view.container.textContent).toBe("");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("flushes the exact final snapshot and its link before the batching deadline", () => {
		const view = render(<ChatMarkdown markdown={longAnswer} streaming />);
		view.rerender(
			<ChatMarkdown
				markdown={`${longAnswer}Discard this fragment`}
				streaming
			/>,
		);
		const finalAnswer = `${longAnswer}**Complete** [Docs](https://example.com/final)`;
		view.rerender(<ChatMarkdown markdown={finalAnswer} streaming={false} />);
		expect(screen.getByText("Complete").tagName).toBe("STRONG");
		expect(screen.queryByText("Discard this fragment")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /Docs/ }));
		expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(
			"https://example.com/final",
		);
		act(() => vi.advanceTimersByTime(500));
		expect(screen.queryByText("Discard this fragment")).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("replaces pending snapshots instead of assuming every update appends", () => {
		const view = render(<ChatMarkdown markdown={longAnswer} streaming />);
		view.rerender(
			<ChatMarkdown markdown={`${longAnswer}Old ending`} streaming />,
		);
		const replacement = longAnswer.replace("## Answer", "## Corrected answer");
		view.rerender(<ChatMarkdown markdown={replacement} streaming />);
		act(() => vi.advanceTimersByTime(250));
		expect(
			screen.getByRole("heading", { name: "Corrected answer" }),
		).toBeTruthy();
		expect(screen.queryByText("Old ending")).toBeNull();
	});

	it("cancels pending work on stream replacement and unmount under StrictMode", () => {
		const live = (key: string, markdown: string) => (
			<StrictMode>
				<ChatMarkdown key={key} markdown={markdown} streaming />
			</StrictMode>
		);
		const view = render(live("first", longAnswer));
		view.rerender(live("first", `${longAnswer}Stale stream`));
		view.rerender(live("second", `${longAnswer}New stream`));
		expect(screen.getByText("New stream")).toBeTruthy();
		act(() => vi.advanceTimersByTime(300));
		expect(screen.queryByText("Stale stream")).toBeNull();
		view.rerender(live("second", `${longAnswer}Pending on unmount`));
		view.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
