import { useState } from "react";
import {
	type GraphPositions,
	normalizeGraphLayouts,
} from "@/lib/automations/graphPresentation";
import { useStore } from "@/store";

export function useGraphLayout(key: string) {
	const [positions, setPositions] = useState<GraphPositions>(
		() =>
			normalizeGraphLayouts(useStore.getState().uiPrefs.automationLayouts)[
				key
			] ?? {},
	);
	function update(next: GraphPositions, commit = false) {
		setPositions(next);
		if (!commit) return;
		const store = useStore.getState();
		const layouts = normalizeGraphLayouts(store.uiPrefs.automationLayouts);
		delete layouts[key];
		store.setUiPrefs({
			automationLayouts: normalizeGraphLayouts({ ...layouts, [key]: next }),
		});
	}
	return { positions, update };
}
