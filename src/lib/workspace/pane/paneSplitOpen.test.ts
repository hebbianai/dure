import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createLocalTerminalOn: vi.fn(),
	openRemoteSshTerminalOn: vi.fn(),
}));

vi.mock("@/lib/workspace/dock", () => ({
	createLocalTerminalOn: mocks.createLocalTerminalOn,
	openRemoteSshTerminalOn: mocks.openRemoteSshTerminalOn,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/dockRegistry")
	>()),
	getDockview: vi.fn(),
}));

import type { DockviewApi } from "dockview-react";
import { openSplitTerminalOn } from "@/lib/workspace/pane/paneSplit";
import { useStore } from "@/store";

const api = {} as DockviewApi;

beforeEach(() => {
	mocks.createLocalTerminalOn.mockReset();
	mocks.openRemoteSshTerminalOn.mockReset();
	useStore.setState({
		sshHosts: [
			{
				id: "host-1",
				name: "remote",
				host: "example.test",
				port: 22,
				user: "tester",
				auth: "auto",
			},
		],
	});
});

describe("openSplitTerminalOn", () => {
	it.each(["local", "ssh"] as const)(
		"returns the actual %s creation completion",
		async (kind) => {
			let finish!: () => void;
			const creating = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const create =
				kind === "local"
					? mocks.createLocalTerminalOn
					: mocks.openRemoteSshTerminalOn;
			create.mockReturnValueOnce(creating);
			const target =
				kind === "local"
					? { kind, cwd: "/repo" }
					: { kind, hostId: "host-1", cwd: "/repo" };
			const result = openSplitTerminalOn(api, target);
			expect(result).toBe(creating);
			const settled = vi.fn();
			void result.then(settled);
			await Promise.resolve();
			expect(settled).not.toHaveBeenCalled();
			finish();
			await result;
			expect(settled).toHaveBeenCalledOnce();
		},
	);
	it("routes an ssh split through the remote hmux shell, never legacy", () => {
		openSplitTerminalOn(
			api,
			{ kind: "ssh", hostId: "host-1", cwd: "/srv/repo" },
			{ direction: "right" },
		);

		expect(mocks.openRemoteSshTerminalOn).toHaveBeenCalledWith(
			api,
			"host-1",
			"remote",
			"/srv/repo",
			{ direction: "right" },
		);
		expect(mocks.createLocalTerminalOn).not.toHaveBeenCalled();
	});

	it("still opens visibly when the ssh host record is gone", () => {
		openSplitTerminalOn(api, { kind: "ssh", hostId: "host-gone", cwd: "/x" });

		expect(mocks.openRemoteSshTerminalOn).toHaveBeenCalledWith(
			api,
			"host-gone",
			"ssh",
			"/x",
			undefined,
		);
	});

	it("routes a local split through the local terminal open", () => {
		openSplitTerminalOn(api, { kind: "local", cwd: "/repo" });

		expect(mocks.createLocalTerminalOn).toHaveBeenCalledWith(
			api,
			"/repo",
			undefined,
		);
		expect(mocks.openRemoteSshTerminalOn).not.toHaveBeenCalled();
	});
});
