// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SourceControlWindowRoot } from "./SourceControlWindow";

const patch =
	'files changed\ndiff --git "a/sp ace.ts" "b/sp ace.ts"\n--- "a/sp ace.ts"\n+++ "b/sp ace.ts"\n@@ -1 +1 @@\n-const old = 1;\n+const next = 2;\n';
vi.mock("@/lib/scm/history/git", () => ({
	gitExec: vi.fn(async (_project, args: string[]) => ({
		code: 0,
		stdout: args.includes("--no-patch") ? "" : patch,
		stderr: "",
	})),
}));
vi.mock("@/lib/scm/scmDetailRelay", () => ({
	consumeFreshScmDetail: () => ({
		kind: "commit",
		ref: "abc123",
		project: { name: "Repo", path: "/repo", kind: "local" },
	}),
	onScmDetail: () => () => {},
}));
vi.mock("@/lib/scm/focusCtxBroadcast", () => ({
	useBroadcastFocusCtx: () => null,
}));
vi.mock("@/components/scm/SourceControlPane", () => ({
	SourceControlPane: () => null,
}));
vi.mock("@/components/scm/ActiveBranchFeed", () => ({
	ActiveBranchFeed: () => null,
}));
vi.mock("@/components/workspace/SecondaryWindowShell", () => ({
	useSecondaryWindowBoot: () => "en",
	SecondaryWindowShell: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
}));
vi.mock("@/components/editor/LazyCodeEditor", () => ({
	LazyCodeEditor: ({
		value,
		fileName,
	}: {
		value: string;
		fileName: string;
	}) => (
		<pre data-testid="detail-editor" data-file-name={fileName}>
			{value}
		</pre>
	),
}));
afterEach(cleanup);

it("renders the resolved filename and original patch in relayed commit detail", async () => {
	render(<SourceControlWindowRoot />);
	expect(await screen.findByRole("button", { name: "sp ace.ts" })).toBeTruthy();
	expect(screen.getByText("files changed")).toBeTruthy();
	const editor = screen.getByTestId("detail-editor");
	expect(editor.dataset.fileName).toBe("sp ace.ts");
	expect(editor.textContent).toBe(patch.slice(patch.indexOf("diff --git")));
});
