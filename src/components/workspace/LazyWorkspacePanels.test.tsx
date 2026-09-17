// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/panels/BrowserPanel", () => ({
	BrowserPanel: () => <div>browser-loaded</div>,
}));
vi.mock("@/components/scm/DiffPanel", () => ({
	DiffPanel: () => <div>diff-loaded</div>,
}));
vi.mock("@/components/files/FileViewerPanel", () => ({
	FileViewerPanel: () => <div>file-loaded</div>,
}));
vi.mock("@/components/panels/GitPanel", () => ({
	GitPanel: () => <div>git-loaded</div>,
}));
vi.mock("@/components/panels/OnboardingPanel", () => ({
	OnboardingPanel: () => <div>onboarding-loaded</div>,
}));

import {
	LazyBrowserPanelLoader,
	LazyDiffPanelLoader,
	LazyFileViewerPanelLoader,
	LazyGitPanelLoader,
	LazyOnboardingPanelLoader,
} from "@/components/workspace/LazyWorkspacePanels";

const props = {} as IDockviewPanelProps;

afterEach(() => cleanup());

describe("lazy workspace panels", () => {
	it.each([
		[LazyBrowserPanelLoader, "browser-loaded"],
		[LazyDiffPanelLoader, "diff-loaded"],
		[LazyFileViewerPanelLoader, "file-loaded"],
		[LazyGitPanelLoader, "git-loaded"],
		[LazyOnboardingPanelLoader, "onboarding-loaded"],
	] as const)("loads a panel only through its suspense boundary", async (Loader, label) => {
		render(<Loader {...props} />);
		expect(await screen.findByText(label)).toBeTruthy();
	});

	it("keeps interactive terminal panels eager and optional panels behind imports", () => {
		const workspace = readFileSync(
			resolve(process.cwd(), "src/components/workspace/Workspace.tsx"),
			"utf8",
		);
		const loaders = readFileSync(
			resolve(
				process.cwd(),
				"src/components/workspace/LazyWorkspacePanels.tsx",
			),
			"utf8",
		);

		for (const eager of ["AgentPanel", "TerminalPanel", "SshPanel"]) {
			expect(workspace).toContain(`@/components/panels/${eager}`);
		}
		for (const optional of [
			"panels/BrowserPanel",
			"scm/DiffPanel",
			"files/FileViewerPanel",
			"panels/GitPanel",
			"panels/OnboardingPanel",
		]) {
			expect(workspace).not.toContain(`@/components/${optional}`);
			expect(loaders).toContain(`import("@/components/${optional}")`);
		}
	});
});
