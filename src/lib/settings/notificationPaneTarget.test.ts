import { describe, expect, it } from "vitest";
import { resolveNotificationPaneTarget } from "@/lib/settings/notificationPaneTarget";

function layout(...panelIds: string[]) {
	return {
		panels: Object.fromEntries(panelIds.map((id) => [id, { params: {} }])),
	};
}

function mounted(desktopId: string, ...panelIds: string[]) {
	return [
		desktopId,
		{ getPanel: (id: string) => (panelIds.includes(id) ? { id } : undefined) },
	] as const;
}

describe("resolveNotificationPaneTarget", () => {
	it("prefers the live Dockview owner over a stale persisted layout", () => {
		expect(
			resolveNotificationPaneTarget(
				"agent:codex",
				"desktop-a",
				{ "desktop-a": layout("agent:codex") },
				[mounted("desktop-b", "agent:codex")],
			),
		).toEqual({ desktopId: "desktop-b", panelId: "agent:codex" });
	});

	it("falls back to the sole persisted owner when the pane is not mounted", () => {
		expect(
			resolveNotificationPaneTarget(
				"agent:codex",
				"desktop-a",
				{ "desktop-b": layout("agent:codex") },
				[],
			),
		).toEqual({ desktopId: "desktop-b", panelId: "agent:codex" });
	});

	it("uses the active owner when stale duplication makes more than one match", () => {
		expect(
			resolveNotificationPaneTarget("agent:codex", "desktop-b", {}, [
				mounted("desktop-a", "agent:codex"),
				mounted("desktop-b", "agent:codex"),
			]),
		).toEqual({ desktopId: "desktop-b", panelId: "agent:codex" });
	});

	it("refuses an ambiguous non-active target", () => {
		expect(
			resolveNotificationPaneTarget(
				"agent:codex",
				"desktop-c",
				{ "desktop-c": layout("agent:codex") },
				[
					mounted("desktop-a", "agent:codex"),
					mounted("desktop-b", "agent:codex"),
				],
			),
		).toBeUndefined();
	});
});
