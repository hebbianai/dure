import { describe, expect, it } from "vitest";
import {
	pluginSidebarContainerKey,
	selectPluginSidebarContainer,
} from "@/lib/plugins/pluginSidebarSelection";

const first = {
	plugin: { manifest: { id: "example.plugin" } },
	contributionId: "example.views",
	container: { id: "first" },
};
const second = { ...first, container: { id: "second" } };

describe("plugin sidebar selection", () => {
	it("keeps an available explicit selection", () => {
		expect(
			selectPluginSidebarContainer(
				[first, second],
				pluginSidebarContainerKey(second),
			),
		).toBe(second);
	});

	it("does not replace or resurrect a removed selection", () => {
		let selectedKey: string | null = pluginSidebarContainerKey(second);
		const fallback = selectPluginSidebarContainer([first], selectedKey);
		selectedKey = fallback ? pluginSidebarContainerKey(fallback) : null;

		expect(selectedKey).toBeNull();
		expect(
			selectPluginSidebarContainer([second, first], selectedKey),
		).toBeUndefined();
	});

	it("does not select the first installed plugin without an explicit route", () => {
		expect(selectPluginSidebarContainer([first, second], null)).toBeUndefined();
	});

	it("distinguishes equal container ids from separate view contributions", () => {
		const duplicate = {
			...first,
			contributionId: "example.alternate-views",
		};

		expect(pluginSidebarContainerKey(duplicate)).not.toBe(
			pluginSidebarContainerKey(first),
		);
		expect(
			selectPluginSidebarContainer(
				[first, duplicate],
				pluginSidebarContainerKey(duplicate),
			),
		).toBe(duplicate);
	});

	it("returns undefined for an empty catalog", () => {
		expect(selectPluginSidebarContainer([], "missing")).toBeUndefined();
	});
});
