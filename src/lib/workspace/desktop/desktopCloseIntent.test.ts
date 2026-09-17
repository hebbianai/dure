import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	desktopCloseIntentStorageKey,
	desktopClosePaneIdentities,
	markDesktopCloseDepartureProcessed,
	markDesktopClosePaneProcessed,
	markDesktopClosePaneStarted,
	persistDesktopCloseIntent,
	replayDesktopCloseIntents,
} from "@/lib/workspace/desktop/desktopCloseIntent";
import { exactLayoutRevision } from "@/lib/workspace/layout/layoutCloseIdentity";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";

const desktopIds = [
	"desktop-replay",
	"desktop-retry",
	"desktop-invalid",
	"desktop-mismatch",
];
const originalLocalStorage = localStorage;

function persistFor(desktopId: string) {
	const layout = useStore.getState().layouts[desktopId];
	return persistDesktopCloseIntent({
		operationId: `operation-${desktopId}`,
		desktopId,
		expectedLayoutRevision: exactLayoutRevision(layout),
		expectedPanes: desktopClosePaneIdentities(layout),
	});
}

beforeEach(() => {
	const values = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			get length() {
				return values.size;
			},
			clear: () => values.clear(),
			getItem: (key: string) => values.get(key) ?? null,
			key: (index: number) => [...values.keys()][index] ?? null,
			removeItem: (key: string) => values.delete(key),
			setItem: (key: string, value: string) => values.set(key, value),
		} satisfies Storage,
	});
});

afterAll(() => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: originalLocalStorage,
	});
});

afterEach(() => {
	vi.clearAllMocks();
	useStore.setState({ spaces: [] });
	for (const desktopId of desktopIds) {
		localStorage.removeItem(desktopCloseIntentStorageKey(desktopId));
	}
});

describe("replayDesktopCloseIntents", () => {
	it("finishes an exact durable close and clears its intent", () => {
		const desktopId = "desktop-replay";
		const removeSpace = vi.fn();
		useStore.setState({
			spaces: [{ id: desktopId, name: "replay" }],
			layouts: { [desktopId]: { panels: {} } },
			removeSpace,
		});
		markDesktopCloseDepartureProcessed(persistFor(desktopId));

		replayDesktopCloseIntents();

		expect(removeSpace).toHaveBeenCalledWith(desktopId);
		expect(
			localStorage.getItem(desktopCloseIntentStorageKey(desktopId)),
		).toBeNull();
	});

	it("retains the intent when replayed desktop removal faults", () => {
		const desktopId = "desktop-retry";
		useStore.setState({
			spaces: [{ id: desktopId, name: "retry" }],
			layouts: { [desktopId]: { panels: {} } },
			removeSpace: vi.fn(() => {
				throw new Error("fault-injected replay persistence failure");
			}),
		});
		markDesktopCloseDepartureProcessed(persistFor(desktopId));

		replayDesktopCloseIntents();

		expect(
			localStorage.getItem(desktopCloseIntentStorageKey(desktopId)),
		).not.toBeNull();
	});

	it("does not remove a desktop when a crash preceded Hmux departure processing", () => {
		const desktopId = "desktop-replay";
		const removeSpace = vi.fn();
		useStore.setState({
			spaces: [{ id: desktopId, name: "prepared" }],
			layouts: { [desktopId]: { panels: {} } },
			removeSpace,
		});
		persistFor(desktopId);

		replayDesktopCloseIntents();

		expect(removeSpace).not.toHaveBeenCalled();
		expect(
			localStorage.getItem(desktopCloseIntentStorageKey(desktopId)),
		).toBeNull();
	});

	it("does not treat malformed storage as close authority", () => {
		const desktopId = "desktop-invalid";
		const removeSpace = vi.fn();
		useStore.setState({
			spaces: [{ id: desktopId, name: "invalid" }],
			removeSpace,
		});
		localStorage.setItem(desktopCloseIntentStorageKey(desktopId), "{");

		replayDesktopCloseIntents();

		expect(removeSpace).not.toHaveBeenCalled();
		expect(localStorage.getItem(desktopCloseIntentStorageKey(desktopId))).toBe(
			"{",
		);
	});

	it("does not let one storage key authorize another desktop close", () => {
		const desktopId = "desktop-mismatch";
		const removeSpace = vi.fn();
		useStore.setState({
			spaces: [{ id: desktopId, name: "mismatch" }],
			removeSpace,
		});
		localStorage.setItem(
			desktopCloseIntentStorageKey("desktop-invalid"),
			JSON.stringify({
				schemaVersion: 1,
				operationId: "mismatch-operation",
				desktopId,
				expectedLayoutRevision: "{}",
				expectedPanes: [],
				phase: "departure_processed",
			}),
		);

		replayDesktopCloseIntents();

		expect(removeSpace).not.toHaveBeenCalled();
	});

	it("preserves a desktop whose pane was retargeted after departure", () => {
		const desktopId = "desktop-replay";
		const original = {
			panels: {
				"term:session": {
					params: {
						sessionId: "old",
						binding: hmuxStandaloneBinding("old", "workspace"),
					},
				},
			},
		};
		const replacement = {
			panels: {
				"term:session": {
					params: {
						sessionId: "new",
						binding: hmuxStandaloneBinding("new", "workspace"),
					},
				},
			},
		};
		const removeSpace = vi.fn();
		useStore.setState({
			spaces: [{ id: desktopId, name: "retargeted" }],
			layouts: { [desktopId]: original },
			removeSpace,
		});
		markDesktopCloseDepartureProcessed(persistFor(desktopId));
		useStore.setState({ layouts: { [desktopId]: replacement } });

		replayDesktopCloseIntents();

		expect(removeSpace).not.toHaveBeenCalled();
		expect(useStore.getState().layouts[desktopId]).toEqual(replacement);
		expect(
			localStorage.getItem(desktopCloseIntentStorageKey(desktopId)),
		).toBeNull();
	});

	it("replays pane progress without deleting a retargeted sibling", () => {
		const desktopId = "desktop-replay";
		const first = {
			sessionId: "first",
			binding: hmuxStandaloneBinding("first", "workspace"),
		};
		const second = {
			sessionId: "second",
			binding: hmuxStandaloneBinding("second", "workspace"),
		};
		const original = {
			panels: {
				"term:first": { params: first },
				"term:second": { params: second },
			},
		};
		const replacement = {
			panels: {
				"term:first": { params: first },
				"term:second": {
					params: {
						sessionId: "replacement",
						binding: hmuxStandaloneBinding(
							"replacement",
							"workspace",
						),
					},
				},
			},
		};
		useStore.setState({
			spaces: [{ id: desktopId, name: "partial" }],
			layouts: { [desktopId]: original },
			removeSpace: vi.fn(),
		});
		let intent = persistDesktopCloseIntent({
			operationId: "partial-operation",
			desktopId,
			expectedLayoutRevision: exactLayoutRevision(original),
			expectedPanes: desktopClosePaneIdentities(
				original,
				new Set(["term:first", "term:second"]),
			),
		});
		intent = markDesktopClosePaneStarted(intent, "term:first");
		intent = markDesktopClosePaneProcessed(intent, "term:first");
		markDesktopClosePaneStarted(intent, "term:second");
		useStore.setState({ layouts: { [desktopId]: replacement } });

		replayDesktopCloseIntents();

		const replayed = useStore.getState().layouts[desktopId] as {
			panels: Record<string, { params: { sessionId: string } }>;
		};
		expect(replayed.panels).not.toHaveProperty("term:first");
		expect(replayed.panels["term:second"]?.params.sessionId).toBe(
			"replacement",
		);
	});

	it("refuses oversized and duplicate-pane journal authority", () => {
		const desktopId = "desktop-invalid";
		const layout = {
			panels: {
				"term:one": {
					params: {
						sessionId: "one",
						binding: hmuxStandaloneBinding("one", "workspace"),
					},
				},
			},
		};
		const removeSpace = vi.fn();
		useStore.setState({
			spaces: [{ id: desktopId, name: "invalid" }],
			layouts: { [desktopId]: layout },
			removeSpace,
		});
		const key = desktopCloseIntentStorageKey(desktopId);
		localStorage.setItem(key, "x".repeat(2 * 1024 * 1024 + 1));

		replayDesktopCloseIntents();
		expect(removeSpace).not.toHaveBeenCalled();

		const intent = markDesktopCloseDepartureProcessed(
			persistFor(desktopId),
		);
		localStorage.setItem(
			key,
			JSON.stringify({
				...intent,
				expectedPanes: [
					intent.expectedPanes[0],
					intent.expectedPanes[0],
				],
			}),
		);
		replayDesktopCloseIntents();

		expect(removeSpace).not.toHaveBeenCalled();
		expect(localStorage.getItem(key)).not.toBeNull();
	});
});
