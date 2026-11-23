// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	announce: undefined as ((payload: unknown) => void) | undefined,
	mounts: [] as string[],
	reopens: [] as string[],
	boot: vi.fn((_title: string) => "en"),
	useDurableWindowClose: vi.fn(),
}));

vi.mock("@/store", () => ({
	useStore: (selector: (state: unknown) => unknown) =>
		selector({
			agents: [{ id: "agent-1", name: "worker", displayName: "Docs pass", sessionId: "s-1" }],
		}),
}));
vi.mock("@/components/workspace/SecondaryWindowShell", () => ({
	SecondaryWindowShell: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	useSecondaryWindowBoot: mocks.boot,
	windowChromeDragHandler: () => vi.fn(),
}));
vi.mock("@/lib/workspace/window/useDurableWindowClose", () => ({
	useDurableWindowClose: mocks.useDurableWindowClose,
}));
vi.mock("@/lib/platform/tauriBridge", () => ({
	listenWhenReady: vi.fn(
		async (_event: string, handler: (event: { payload: unknown }) => void) => {
			mocks.announce = (payload) => handler({ payload });
			return () => {
				mocks.announce = undefined;
			};
		},
	),
}));
vi.mock("@/lib/files/fileReopenEvents", () => ({
	publishFileReopen: (target: { path: string }) => mocks.reopens.push(target.path),
}));
vi.mock("@/components/files/FileViewerPanel", async () => {
	const { useContext, useEffect } = await import("react");
	const { FileDocumentIOContext } = await import("@/components/files/fileDocumentIOContext");
	const { presentedFileDocumentIO } = await import("@/lib/files/fileDocumentIO");
	return {
		FileViewerPanel: ({ params }: { params: { path: string } }) => {
			const streaming = useContext(FileDocumentIOContext) === presentedFileDocumentIO;
			useEffect(() => {
				mocks.mounts.push(params.path);
			}, [params.path]);
			return (
				<div data-testid="viewer" data-streaming={String(streaming)}>
					{params.path}
				</div>
			);
		},
	};
});
vi.mock("@/lib/i18n", () => ({
	t: (key: string, vars?: Record<string, string>) =>
		vars ? `${key} ${JSON.stringify(vars)}` : key,
}));

import { FilePresentationWindowRoot } from "@/components/files/FilePresentationWindow";

beforeEach(() => {
	localStorage.clear();
	mocks.mounts.length = 0;
	mocks.reopens.length = 0;
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

async function announce(payload: unknown) {
	await act(async () => mocks.announce?.(payload));
}

describe("FilePresentationWindowRoot", () => {
	it("shows the empty state until a file is presented", async () => {
		render(<FilePresentationWindowRoot />);
		await act(async () => {});
		expect(screen.getByText("panels.filePresentation.empty")).toBeTruthy();
		expect(screen.queryByTestId("viewer")).toBeNull();
		expect(mocks.useDurableWindowClose).toHaveBeenCalled();
	});

	it("opens the stored presentation and names its file and presenter", async () => {
		localStorage.setItem(
			"dure:file-presentation",
			JSON.stringify({
				id: "p-1",
				file: { source: "local", path: "/work/shot.png" },
				presenterAgentId: "agent-1",
			}),
		);
		render(<FilePresentationWindowRoot />);
		await act(async () => {});
		expect(screen.getByTestId("viewer").textContent).toBe("/work/shot.png");
		// The window's viewer reads through the streaming presented-file IO.
		expect(screen.getByTestId("viewer").dataset.streaming).toBe("true");
		expect(screen.getByText("shot.png")).toBeTruthy();
		expect(
			screen.getByText('panels.filePresentation.presentedBy {"name":"Docs pass"}'),
		).toBeTruthy();
		expect(mocks.boot).toHaveBeenLastCalledWith(
			'panels.filePresentation.windowTitle {"file":"shot.png","name":"Docs pass"}',
		);
	});

	it("replaces the file on a new presentation and reloads a re-presented file", async () => {
		render(<FilePresentationWindowRoot />);
		await act(async () => {});
		await announce({ id: "p-1", file: { source: "local", path: "/work/a.png" } });
		expect(screen.getByTestId("viewer").textContent).toBe("/work/a.png");
		await announce({ id: "p-2", file: { source: "local", path: "/work/b.mp4" } });
		expect(screen.getByTestId("viewer").textContent).toBe("/work/b.mp4");
		expect(screen.queryByText(/presentedBy/)).toBeNull();
		expect(mocks.mounts).toEqual(["/work/a.png", "/work/b.mp4"]);
		expect(mocks.reopens).toEqual([]);

		await announce({ id: "p-2", file: { source: "local", path: "/work/b.mp4" } });
		expect(mocks.reopens).toEqual([]);
		await announce({ id: "p-3", file: { source: "local", path: "/work/b.mp4" } });
		expect(mocks.reopens).toEqual(["/work/b.mp4"]);
		expect(mocks.mounts).toEqual(["/work/a.png", "/work/b.mp4"]);
	});

	it("ignores an announcement that is not a local file", async () => {
		render(<FilePresentationWindowRoot />);
		await act(async () => {});
		await announce({ id: "p-1", file: { source: "ssh", path: "/srv/a.png" } });
		expect(screen.queryByTestId("viewer")).toBeNull();
	});
});
