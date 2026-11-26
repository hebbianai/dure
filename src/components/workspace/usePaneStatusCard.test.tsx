// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePaneStatusCard } from "@/components/workspace/usePaneStatusCard";
import { WorkspaceRuntimeProvider } from "@/components/workspace/WorkspaceRuntimeContext";
import { TerminalPresentationRoleStore } from "@/lib/terminal/presentation/terminalPresentationRoleStore";

/** jsdom lays nothing out: each pane box reports the size a test gives it,
 * and the test delivers ResizeObserver callbacks itself. */
const boxSizes = new WeakMap<Element, { width: number; height: number }>();
const observers = new Set<FakeResizeObserver>();

class FakeResizeObserver {
	readonly targets = new Set<Element>();
	constructor(private readonly callback: () => void) {
		observers.add(this);
	}
	observe(target: Element) {
		this.targets.add(target);
	}
	unobserve(target: Element) {
		this.targets.delete(target);
	}
	disconnect() {
		this.targets.clear();
		observers.delete(this);
	}
	deliver() {
		this.callback();
	}
}

function resize(element: Element, width: number, height: number) {
	boxSizes.set(element, { width, height });
	act(() => {
		for (const observer of [...observers]) {
			if (observer.targets.has(element)) observer.deliver();
		}
	});
}

function Pane() {
	const card = usePaneStatusCard<HTMLDivElement>();
	return (
		<div ref={card.ref} data-testid="pane">
			{card.shown ? "card" : "live"}
		</div>
	);
}

function Space({
	active,
	frozen = false,
}: {
	active: boolean;
	frozen?: boolean;
}) {
	return (
		<WorkspaceRuntimeProvider
			desktopId="desktop-1"
			active={active}
			frozen={frozen}
			presentationRoleStore={new TerminalPresentationRoleStore()}
			commitLayout={() => true}
		>
			<Pane />
		</WorkspaceRuntimeProvider>
	);
}

const descriptors = {
	clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
	clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
	ResizeObserver: Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver"),
};

beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return boxSizes.get(this)?.width ?? 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return boxSizes.get(this)?.height ?? 0;
		},
	});
	Object.defineProperty(globalThis, "ResizeObserver", {
		configurable: true,
		writable: true,
		value: FakeResizeObserver,
	});
});

afterEach(() => {
	cleanup();
	observers.clear();
	for (const [key, descriptor] of Object.entries(descriptors)) {
		const target = key === "ResizeObserver" ? globalThis : HTMLElement.prototype;
		if (descriptor) Object.defineProperty(target, key, descriptor);
		else Reflect.deleteProperty(target, key);
	}
});

describe("usePaneStatusCard", () => {
	it("turns an on-screen pane into a card below the readable size and back once it is larger", () => {
		render(<Space active />);
		const pane = screen.getByTestId("pane");
		expect(pane.textContent).toBe("live");

		resize(pane, 300, 600);
		expect(pane.textContent).toBe("card");
		// Inside the hysteresis band the card stays.
		resize(pane, 400, 600);
		expect(pane.textContent).toBe("card");
		resize(pane, 800, 600);
		expect(pane.textContent).toBe("live");
	});

	it("keeps the mode through a zero size, such as a hidden tab", () => {
		render(<Space active />);
		const pane = screen.getByTestId("pane");
		resize(pane, 300, 600);
		resize(pane, 0, 0);
		expect(pane.textContent).toBe("card");
	});

	it.each([
		["warm", false],
		["frozen", true],
	])("never toggles in a %s Space that is not on screen", (_tier, frozen) => {
		const view = render(<Space active={false} frozen={frozen} />);
		const pane = screen.getByTestId("pane");
		boxSizes.set(pane, { width: 200, height: 150 });
		// No observer runs off screen, so a measurement there cannot release
		// a warm terminal.
		expect(observers.size).toBe(0);
		resize(pane, 120, 100);
		expect(pane.textContent).toBe("live");

		// Coming on screen reads the size once.
		view.rerender(<Space active />);
		expect(pane.textContent).toBe("card");
	});

	it("keeps a card while its Space goes off screen and returns", () => {
		const view = render(<Space active />);
		const pane = screen.getByTestId("pane");
		resize(pane, 300, 600);
		view.rerender(<Space active={false} />);
		boxSizes.set(pane, { width: 1200, height: 900 });
		expect(pane.textContent).toBe("card");
		view.rerender(<Space active />);
		expect(pane.textContent).toBe("live");
	});
});
