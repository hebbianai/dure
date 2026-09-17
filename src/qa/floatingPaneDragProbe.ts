import { qaLog } from "@/lib/qa/qaLog";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";

const FIXTURE_SPACE_NAME = "Floating pane drag QA";
const FIXTURE_PANE_TITLE = "Floating drag fixture";
const FIXTURE_BOUNDS = { x: 180, y: 120, width: 560, height: 420 } as const;
const FIXTURE_TIMEOUT_MS = 30_000;

const sleep = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function serializedPosition(api: ReturnType<typeof getDockview>) {
	return api?.toJSON().floatingGroups?.[0]?.position ?? null;
}

/**
 * Builds one deterministic floating pane inside the real Tauri WebView. The
 * native-input smoke owns the Space and the pane; this probe only projects it
 * into Dockview's public floating-group path and records serialized bounds.
 */
export async function runFloatingPaneDragProbe(): Promise<void> {
	const deadline = Date.now() + FIXTURE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const state = useStore.getState();
		const fixtureSpace = state.spaces.find(
			(space) => space.name === FIXTURE_SPACE_NAME,
		);
		const api = fixtureSpace ? getDockview(fixtureSpace.id) : undefined;
		const panel =
			fixtureSpace?.id === state.activeSpaceId && api?.panels.length === 1
				? api.panels[0]
				: undefined;
		if (!api || !panel || panel.group.api.location.type !== "grid") {
			await sleep(50);
			continue;
		}

		panel.api.setTitle(FIXTURE_PANE_TITLE);
		api.addFloatingGroup(panel, FIXTURE_BOUNDS);
		const logBounds = (phase: "ready" | "layout") => {
			qaLog("floatingPaneDrag", {
				phase,
				panelId: panel.id,
				position: serializedPosition(api),
			});
		};
		const layoutChange = api.onDidLayoutChange(() => logBounds("layout"));
		window.addEventListener("beforeunload", () => layoutChange.dispose(), {
			once: true,
		});
		logBounds("ready");
		return;
	}
	qaLog("floatingPaneDrag", {
		phase: "failed",
		error: `fixture was not ready within ${FIXTURE_TIMEOUT_MS}ms`,
	});
}
