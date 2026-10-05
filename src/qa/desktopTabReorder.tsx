import { useEffect } from "react";
import { DesktopBar } from "@/components/workspace/DesktopBar";
import { homeDir } from "@/lib/ipc";
import { qaLog } from "@/lib/qa/qaLog";
import { DEFAULT_UI_PREFS, useStore } from "@/store";

const proof = new URLSearchParams(location.search).get("qaDesktopTabReorder");
// Background WebViews may suspend animation frames; React still commits DOM.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

/** Background WKWebView evidence with actual DOM geometry and event propagation. */
export function DesktopTabReorderQaRoot() {
	useEffect(() => {
		if (!proof) return;
		const run = async () => {
			const home = await homeDir();
			if (
				!home.includes("/dure-desktop-tab-reorder.") ||
				!home.endsWith("/home")
			) {
				throw new Error("Tab reorder QA requires its disposable HOME");
			}
			await useStore.persist.rehydrate();
			const checks: string[] = [];
			for (const scenario of ["release-position", "tab-gap", "strip-end"]) {
				useStore.setState({
					spaces: ["first", "second", "third"].map((id) => ({ id, name: id })),
					activeSpaceId: "first",
					uiPrefs: { ...DEFAULT_UI_PREFS, tabOrder: "manual" },
				});
				await settle();
				const strip = document.querySelector<HTMLElement>('[role="tablist"]')!;
				const tabs = [...strip.querySelectorAll<HTMLElement>('[role="tab"]')];
				if (tabs.length !== 3)
					throw new Error("Expected three real Space tabs");
				const transfer = new DataTransfer();
				const drag = (target: HTMLElement, type: string, x: number) => {
					const bounds = target.getBoundingClientRect();
					target.dispatchEvent(
						new DragEvent(type, {
							bubbles: true,
							cancelable: true,
							dataTransfer: transfer,
							clientX: x,
							clientY: bounds.top + bounds.height / 2,
						}),
					);
				};
				const third = tabs[2].getBoundingClientRect();
				drag(tabs[0], "dragstart", tabs[0].getBoundingClientRect().left + 10);
				const x =
					scenario === "release-position"
						? third.right - 2
						: scenario === "tab-gap"
							? (tabs[1].getBoundingClientRect().right + third.left) / 2
							: third.right + 20;
				const target = scenario === "release-position" ? tabs[2] : strip;
				drag(
					target,
					"dragover",
					scenario === "release-position" ? third.left + 2 : x,
				);
				await settle();
				drag(target, "drop", x);
				transfer.dropEffect = "move";
				drag(tabs[0], "dragend", x);
				await settle();
				const expected =
					scenario === "tab-gap" ? "second,first,third" : "second,third,first";
				const actual = useStore
					.getState()
					.spaces.map(({ id }) => id)
					.join(",");
				if (actual !== expected)
					throw new Error(`${scenario}: expected ${expected}, got ${actual}`);
				if (useStore.getState().activeSpaceId !== "first")
					throw new Error("Reordering changed the selected Space");
				checks.push(scenario);
			}
			qaLog("desktop-tab-reorder", {
				proof,
				result: "passed",
				checks,
				input: "synthetic-dom-drag",
				activeSpacePreserved: true,
			});
		};
		void run().catch((error: unknown) =>
			qaLog("desktop-tab-reorder", {
				proof,
				result: "failed",
				error: String(error),
			}),
		);
	}, []);
	return (
		<div style={{ width: 800, display: "flex" }}>
			<DesktopBar />
		</div>
	);
}
