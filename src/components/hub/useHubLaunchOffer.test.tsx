// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHubLaunchOffer } from "@/components/hub/useHubLaunchOffer";
import { useStore } from "@/store";
import type { Project, Space, SshHostConfig } from "@/types";

const mocks = vi.hoisted(() => ({ isMainWindow: vi.fn(() => true) }));
vi.mock("@/lib/workspace/window/windows", () => ({
	isMainWindow: mocks.isMainWindow,
}));

function project(id: string, name: string): Project {
	return { id, name, path: `~/dev/${name}`, kind: "local", isRepo: true };
}

beforeEach(() => {
	mocks.isMainWindow.mockReturnValue(true);
	useStore.setState({
		uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "pro" },
		desktops: [{ id: "s1", name: "Main" }] as Space[],
		projects: [project("p1", "HebbianIDE")],
		sshHosts: [],
		installedAgents: ["claude"],
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("useHubLaunchOffer", () => {
	it("offers both SSH hosts with honest per-target capabilities and remote-only providers", () => {
		useStore.setState({
			projects: [
				project("local", "Local"),
				...["aws", "tailscale"].map((id) => ({
					id,
					name: id,
					kind: "ssh" as const,
					sshHostId: id,
					path: "/srv/qa",
					isRepo: true,
				})),
			],
			sshHosts: ["aws", "tailscale"].map((id) => ({
				id,
				name: id,
				host: `${id}.test`,
				port: 22,
				user: "qa",
				auth: "auto",
			})) as SshHostConfig[],
		});
		const send = vi.fn();
		renderHook(() => useHubLaunchOffer(send));
		const [targets, kinds] = send.mock.calls[0] ?? [];
		expect(targets).toEqual([
			expect.objectContaining({
				id: "s1 local",
				startable: true,
				worktree_supported: true,
				provider_installation: "reported",
			}),
			expect.objectContaining({
				id: "s1 aws",
				box_label: "aws",
				startable: true,
				worktree_supported: false,
				provider_installation: "check_on_start",
			}),
			expect.objectContaining({
				id: "s1 tailscale",
				box_label: "tailscale",
				startable: true,
				worktree_supported: false,
				provider_installation: "check_on_start",
			}),
		]);
		expect(kinds).toContainEqual(
			expect.objectContaining({ id: "qwen-code", installed: false }),
		);
	});

	it("hands the hub one seat per space-and-folder pair", () => {
		const send = vi.fn();
		renderHook(() => useHubLaunchOffer(send));

		expect(send).toHaveBeenCalledTimes(1);
		const [targets] = send.mock.calls[0] ?? [];
		expect(targets).toEqual([
			expect.objectContaining({
				id: "s1 p1",
				folder_label: "HebbianIDE",
				startable: true,
			}),
		]);
	});

	/**
	 * The store changes constantly and almost none of it moves this table.
	 * Without this the offer would be re-sent on every unrelated store write —
	 * an IPC per keystroke of agent activity.
	 */
	it("stays quiet when the store moves but the seats do not", () => {
		const send = vi.fn();
		const { rerender } = renderHook(() => useHubLaunchOffer(send));
		send.mockClear();

		act(() => {
			useStore.setState({ projects: [project("p1", "HebbianIDE")] });
		});
		rerender();

		expect(send).not.toHaveBeenCalled();
	});

	it("sends again once a folder is actually added", () => {
		const send = vi.fn();
		renderHook(() => useHubLaunchOffer(send));
		send.mockClear();

		act(() => {
			useStore.setState({
				projects: [project("p1", "HebbianIDE"), project("p2", "dure")],
			});
		});

		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0]).toHaveLength(2);
	});

	/**
	 * A popout window renders `App` too. Both halves of this feature live on
	 * one window on purpose: the other half answers a start request, and every
	 * window answering means an agent started per open window.
	 */
	it("says nothing from a popout window", () => {
		mocks.isMainWindow.mockReturnValue(false);
		const send = vi.fn();
		renderHook(() => useHubLaunchOffer(send));

		expect(send).not.toHaveBeenCalled();
	});
});

it("replaces the phone catalog when Basic hides an installed Pro provider", () => {
	useStore.setState({ installedAgents: ["gemini"] });
	const send = vi.fn();
	renderHook(() => useHubLaunchOffer(send));
	expect(send.mock.lastCall?.[1]).toContainEqual(
		expect.objectContaining({ id: "gemini" }),
	);
	act(() =>
		useStore.setState({
			uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "basic" },
		}),
	);
	expect(
		send.mock.lastCall?.[1].map((kind: { id: string }) => kind.id),
	).toEqual(["claude", "codex", "kimi"]);
});
