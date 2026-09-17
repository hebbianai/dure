// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Markdown from "react-markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMarkdown } from "@/components/agents/chat/ChatMarkdown";
import { WorkspaceRuntimeProvider } from "@/components/workspace/WorkspaceRuntimeContext";
import { openExternalUrl } from "@/lib/platform/externalOpen";
import { TerminalPresentationRoleStore } from "@/lib/terminal/presentation/terminalPresentationRoleStore";

// Count real Markdown processing without replacing its parser or renderer.
vi.mock("react-markdown", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-markdown")>();
	return { ...actual, default: vi.fn(actual.default) };
});

vi.mock("@/lib/platform/externalOpen", () => ({
	openExternalUrl: vi.fn(),
}));

const longAnswer = Array.from(
	{ length: 40 },
	(_, index) =>
		`## Section ${index + 1}\n\n${"A long answer with **Markdown** and inline `code`. ".repeat(8)}\n\n`,
).join("");

function Transcript({ live, revision }: { live: string; revision: number }) {
	return (
		<div data-revision={revision}>
			<ChatMarkdown markdown={longAnswer} />
			<ChatMarkdown markdown={live} />
		</div>
	);
}

describe("ChatMarkdown", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("does not reprocess an unchanged long answer when its parent rerenders", () => {
		const view = render(<Transcript live="Starting" revision={0} />);

		for (let revision = 1; revision <= 20; revision++) {
			view.rerender(<Transcript live="Starting" revision={revision} />);
		}

		expect(Markdown).toHaveBeenCalledTimes(2);
		expect(screen.getByRole("heading", { name: "Section 40" })).toBeTruthy();
	});

	it("processes each changed streaming snapshot without reprocessing retained text", () => {
		const view = render(<Transcript live={longAnswer} revision={0} />);
		vi.mocked(Markdown).mockClear();
		let live = longAnswer;

		for (let revision = 1; revision <= 20; revision++) {
			live += `\n\nStreaming fragment ${revision}.`;
			view.rerender(<Transcript live={live} revision={revision} />);
			expect(screen.getByText(`Streaming fragment ${revision}.`)).toBeTruthy();
			view.rerender(<Transcript live={live} revision={revision + 100} />);
		}

		expect(Markdown).toHaveBeenCalledTimes(20);
		expect(
			vi
				.mocked(Markdown)
				.mock.calls.every(([props]) => props.children?.startsWith(longAnswer)),
		).toBe(true);
	});

	it("renders the latest Markdown and opens its current link after an update", () => {
		const view = render(
			<ChatMarkdown markdown="**Partial answer with [Docs](https://example.com/old)" />,
		);
		view.rerender(
			<ChatMarkdown markdown="**Complete answer** with [Docs](https://example.com/new)" />,
		);

		expect(screen.getByText("Complete answer").tagName).toBe("STRONG");
		expect(screen.queryByText(/Partial answer/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /Docs/ }));
		expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(
			"https://example.com/new",
		);
	});

	it("defers completed messages that arrive while hidden until the workspace is revealed", () => {
		const roles = new TerminalPresentationRoleStore();
		const content = (active: boolean, markdown: string) => (
			<WorkspaceRuntimeProvider
				desktopId="chat"
				active={active}
				presentationRoleStore={roles}
				commitLayout={() => true}
			>
				<ChatMarkdown markdown={markdown} />
			</WorkspaceRuntimeProvider>
		);
		const view = render(content(false, longAnswer));
		view.rerender(content(false, `${longAnswer}Final retained answer`));
		expect(Markdown).not.toHaveBeenCalled();
		view.rerender(content(true, `${longAnswer}Final retained answer`));
		expect(Markdown).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Final retained answer")).toBeTruthy();
	});
});
