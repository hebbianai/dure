// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { Suspense, startTransition, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useNamedPaneAction } from "@/components/workspace/useNamedPaneAction";
import {
	type CliPaneActionDependencies,
	dispatchCliPaneActionRequest,
} from "@/lib/cli/cliPaneActions";
import { registerPaneActions } from "@/lib/workspace/pane/paneActionRegistry";

const dispose: (() => void)[] = [];
afterEach(() => {
	cleanup();
	for (const unregister of dispose.splice(0)) unregister();
});

function mountStatus() {
	dispose.push(
		registerPaneActions({
			paneId: "pane-named",
			status: "attached",
			actions: {},
			owner: {},
		}),
	);
}

it("does not switch a replacement recipient through the actual named-action hook", async () => {
	mountStatus();
	const original = vi.fn(async () => {});
	const replacement = vi.fn(async () => {});
	const hook = renderHook(
		({ run, owner }) =>
			useNamedPaneAction("pane-named", "switch_runtime:chat", true, run, owner),
		{
			initialProps: { run: original, owner: "original" },
		},
	);
	const complete = vi.fn<CliPaneActionDependencies["complete"]>(async () => {});
	await dispatchCliPaneActionRequest(
		{
			reqId: "named-claim",
			action: "pane.act",
			params: { targetPanelId: "pane-named", actionId: "switch_runtime:chat" },
		},
		{
			async claim() {
				act(() => hook.rerender({ run: replacement, owner: "replacement" }));
				return true;
			},
			complete,
			isFallbackWindow: () => true,
			delay: async () => {},
		},
	);
	expect(replacement).not.toHaveBeenCalled();
	expect(original).not.toHaveBeenCalled();
	expect(complete.mock.calls[0][1]).toMatchObject({ ok: false });
});

it("keeps an unchanged callable usable across ordinary rerender during claim", async () => {
	mountStatus();
	const original = vi.fn(async () => {});
	const hook = renderHook(
		({ run }) =>
			useNamedPaneAction(
				"pane-named",
				"switch_runtime:chat",
				true,
				run,
				"unchanged",
			),
		{
			initialProps: { run: original },
		},
	);
	const complete = vi.fn<CliPaneActionDependencies["complete"]>(async () => {});
	await dispatchCliPaneActionRequest(
		{
			reqId: "named-unchanged",
			action: "pane.act",
			params: { targetPanelId: "pane-named", actionId: "switch_runtime:chat" },
		},
		{
			async claim() {
				act(() => hook.rerender({ run: original }));
				return true;
			},
			complete,
			isFallbackWindow: () => true,
			delay: async () => {},
		},
	);
	expect(original).toHaveBeenCalledOnce();
	expect(complete.mock.calls[0][1]).toMatchObject({ ok: true });
});

it("does not make an unrelated render revoke the same named action recipient", async () => {
	mountStatus();
	const send = vi.fn(async (_target: string) => {});
	const hook = renderHook(
		({ target, decoration }) => {
			useNamedPaneAction(
				"pane-named",
				"switch_runtime:chat",
				true,
				() => send(target),
				target,
			);
			return decoration;
		},
		{ initialProps: { target: "same-agent", decoration: "before" } },
	);
	const complete = vi.fn<CliPaneActionDependencies["complete"]>(async () => {});
	await dispatchCliPaneActionRequest(
		{
			reqId: "named-rerender",
			action: "pane.act",
			params: { targetPanelId: "pane-named", actionId: "switch_runtime:chat" },
		},
		{
			async claim() {
				act(() => hook.rerender({ target: "same-agent", decoration: "after" }));
				return true;
			},
			complete,
			isFallbackWindow: () => true,
			delay: async () => {},
		},
	);
	expect(send).toHaveBeenCalledExactlyOnceWith("same-agent");
	expect(complete.mock.calls[0][1]).toMatchObject({ ok: true });
});

it("does not revive an old request when the same owner key returns after replacement", async () => {
	mountStatus();
	const run = vi.fn(async () => {});
	const hook = renderHook(
		({ owner }) =>
			useNamedPaneAction("pane-named", "switch_runtime:chat", true, run, owner),
		{
			initialProps: { owner: "original" },
		},
	);
	const complete = vi.fn<CliPaneActionDependencies["complete"]>(async () => {});
	await dispatchCliPaneActionRequest(
		{
			reqId: "named-aba",
			action: "pane.act",
			params: { targetPanelId: "pane-named", actionId: "switch_runtime:chat" },
		},
		{
			async claim() {
				act(() => hook.rerender({ owner: "replacement" }));
				act(() => hook.rerender({ owner: "original" }));
				return true;
			},
			complete,
			isFallbackWindow: () => true,
			delay: async () => {},
		},
	);
	expect(run).not.toHaveBeenCalled();
	expect(complete.mock.calls[0][1]).toMatchObject({ ok: false });
});

it("does not expose an uncommitted suspended render as the action recipient", async () => {
	mountStatus();
	const original = vi.fn(async () => {});
	const replacement = vi.fn(async () => {});
	const suspended = new Promise<void>(() => {});
	type View = { owner: string; run: () => Promise<void>; suspend: boolean };
	let replace: (view: View) => void;
	function Surface({ owner, run, suspend }: View) {
		useNamedPaneAction("pane-named", "switch_runtime:chat", true, run, owner);
		if (suspend) throw suspended;
		return <span>{owner}</span>;
	}
	function Pane() {
		const [view, setView] = useState<View>({
			owner: "original",
			run: original,
			suspend: false,
		});
		replace = setView;
		return (
			<Suspense fallback={<span>pending</span>}>
				<Surface {...view} />
			</Suspense>
		);
	}
	render(<Pane />);
	const complete = vi.fn<CliPaneActionDependencies["complete"]>(async () => {});
	await dispatchCliPaneActionRequest(
		{
			reqId: "named-uncommitted",
			action: "pane.act",
			params: { targetPanelId: "pane-named", actionId: "switch_runtime:chat" },
		},
		{
			async claim() {
				await act(async () => {
					startTransition(() =>
						replace({ owner: "replacement", run: replacement, suspend: true }),
					);
				});
				return true;
			},
			complete,
			isFallbackWindow: () => true,
			delay: async () => {},
		},
	);
	expect(replacement).not.toHaveBeenCalled();
	expect(original).toHaveBeenCalledOnce();
	expect(complete.mock.calls[0][1]).toMatchObject({ ok: true });
});
