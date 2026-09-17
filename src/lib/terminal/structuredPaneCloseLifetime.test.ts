import type { DockviewApi, IDockviewPanelProps } from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dockviewRegistry } from "@/lib/workspace/dock/dockRegistry";
import { settleCloseIntentObservers } from "@/lib/workspace/layout/closeIntentObservers";
import {
	exactPaneBindingSnapshot,
	persistedLayoutRevision,
} from "@/lib/workspace/layout/layoutCloseIdentity";
import {
	clearPaneCloseIntent,
	persistPaneCloseIntent,
	type PaneCloseIntentV1,
} from "@/lib/workspace/pane/paneCloseIntent";
import { hmuxPaneBinding } from "@/test/terminalRecordFixtures";
import { observeStructuredPaneClose } from "./structuredPaneCloseLifetime";

vi.mock("@/store", () => ({
	useStore: { getState: () => ({ spaces: [{ id: "desktop" }] }) },
}));
const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	dockviewRegistry.clear();
	localStorage.clear();
});
function fixture(panelId = "term:a") {
	const binding = hmuxPaneBinding("a");
	const paneApi = { id: panelId } as IDockviewPanelProps["api"];
	const panel = { api: paneApi, params: { sessionId: "a", binding } };
	const originalLayout = { panels: { [panelId]: { params: panel.params } } };
	const removedLayout = { panels: {} };
	const intent: PaneCloseIntentV1 = {
		schemaVersion: 1,
		operationId: "close",
		desktopId: "desktop",
		panelId,
		expectedLayoutRevision: persistedLayoutRevision(originalLayout),
		removedLayoutRevision: persistedLayoutRevision(removedLayout),
		expectedBinding: exactPaneBindingSnapshot(panel.params),
		originalLayout,
		removedLayout,
		phase: "departure_started",
	};
	const api = {
		getPanel: vi.fn((id: string) => (id === panelId ? panel : undefined)),
	};
	dockviewRegistry.set("desktop", api as unknown as DockviewApi);
	const retire = vi.fn().mockResolvedValue(undefined),
		resume = vi.fn();
	const observe = (
		overrides: Partial<Parameters<typeof observeStructuredPaneClose>[0]> = {},
	) => {
		disposers.push(
			observeStructuredPaneClose({
				desktopId: "desktop",
				paneApi,
				binding,
				retire,
				resume,
				...overrides,
			}),
		);
	};
	return { panel, api, paneApi, binding, intent, retire, resume, observe };
}
describe("structured pane close journal subscription", () => {
	it("synchronously retires once and waits for native confirmation", async () => {
		const f = fixture();
		let confirm!: () => void;
		f.retire.mockReturnValue(
			new Promise<void>((resolve) => {
				confirm = resolve;
			}),
		);
		f.observe();
		persistPaneCloseIntent(f.intent);
		let settled = false;
		const closing = settleCloseIntentObservers("desktop").then(() => {
			settled = true;
		});
		expect(f.retire).toHaveBeenCalledOnce();
		await Promise.resolve();
		expect(settled).toBe(false);
		confirm();
		await closing;
		await settleCloseIntentObservers("desktop");
		expect(f.retire).toHaveBeenCalledOnce();
	});
	it("rejects departure admission when native retirement fails", async () => {
		const f = fixture();
		f.retire.mockRejectedValue(new Error("detach unconfirmed"));
		f.observe();
		persistPaneCloseIntent(f.intent);
		await expect(settleCloseIntentObservers("desktop")).rejects.toThrow(
			"detach unconfirmed",
		);
		expect(f.resume).not.toHaveBeenCalled();
	});
	it("retires a late view from the existing journal without another close notification", () => {
		const f = fixture();
		persistPaneCloseIntent(f.intent);
		f.observe();
		expect(f.retire).toHaveBeenCalledOnce();
	});
	it("does not retire a sibling pane of the same session", async () => {
		const f = fixture();
		f.observe();
		const originalLayout = {
			panels: { "term:sibling": { params: f.panel.params } },
		};
		persistPaneCloseIntent({
			...f.intent,
			panelId: "term:sibling",
			originalLayout,
			expectedLayoutRevision: persistedLayoutRevision(originalLayout),
		});
		await settleCloseIntentObservers("desktop");
		expect(f.retire).not.toHaveBeenCalled();
	});
	it("does not retire a replacement binding from an older journal", async () => {
		const f = fixture();
		persistPaneCloseIntent(f.intent);
		f.panel.params = { sessionId: "new", binding: hmuxPaneBinding("new") };
		f.observe({ binding: f.panel.params.binding });
		await settleCloseIntentObservers("desktop");
		expect(f.retire).not.toHaveBeenCalled();
	});
	it("does not resume a removed panel when its journal clears", async () => {
		const f = fixture();
		f.observe();
		persistPaneCloseIntent(f.intent);
		await settleCloseIntentObservers("desktop");
		f.api.getPanel.mockReturnValue(undefined);
		clearPaneCloseIntent(f.intent);
		expect(f.resume).not.toHaveBeenCalled();
	});
	it("resumes a preserved mounted generation once when its journal clears", async () => {
		const f = fixture();
		f.observe();
		persistPaneCloseIntent(f.intent);
		await settleCloseIntentObservers("desktop");
		clearPaneCloseIntent(f.intent);
		await settleCloseIntentObservers("desktop");
		expect(f.resume).toHaveBeenCalledOnce();
	});
});
