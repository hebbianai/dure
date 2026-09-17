// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/types";

const mocks = vi.hoisted(() => ({
	homeDir: vi.fn(),
	inspectLocalProject: vi.fn(),
	addAgentBody: vi.fn(),
	ensureProjectForPath: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	homeDir: mocks.homeDir,
}));
vi.mock("@/lib/spaces/projectAdd", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/spaces/projectAdd")>()),
	inspectLocalProject: mocks.inspectLocalProject,
}));
vi.mock("@/components/agents/addAgent/AddAgentBody", () => ({
	AddAgentBody: (props: Record<string, unknown>) => {
		mocks.addAgentBody(props);
		return <div>agent form</div>;
	},
}));

import { WorktreeAgentDialog } from "@/components/agents/WorktreeAgentDialog";
import { useStore } from "@/store";

const home: Project = {
	id: "location-home",
	name: "jwan",
	path: "/Users/jwan",
	kind: "local",
	isRepo: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.homeDir.mockResolvedValue(home.path);
	mocks.inspectLocalProject.mockResolvedValue(home);
	useStore.setState({
		projects: [],
		ensureProjectForPath: mocks.ensureProjectForPath,
	});
});

afterEach(cleanup);

describe("WorktreeAgentDialog default location", () => {
	it("offers Home without registering a project just by opening the dialog", async () => {
		render(
			<WorktreeAgentDialog
				desktopId="desktop-1"
				onClose={vi.fn()}
			/>,
		);

		await waitFor(() =>
			expect(mocks.addAgentBody).toHaveBeenLastCalledWith(
				expect.objectContaining({ defaultProject: home }),
			),
		);
		expect(mocks.ensureProjectForPath).not.toHaveBeenCalled();
	});
});
