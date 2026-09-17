// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffWindowRoot } from "@/components/scm/DiffWindow";

const mocks = vi.hoisted(() => ({
	useDurableWindowClose: vi.fn(),
}));

vi.mock("@/store", () => ({
	useStore: (selector: (state: unknown) => unknown) =>
		selector({ agents: [], sessionCwd: {} }),
}));
vi.mock("@/components/workspace/SecondaryWindowShell", () => ({
	SecondaryWindowShell: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	useSecondaryWindowBoot: () => "en",
	windowChromeDragHandler: () => vi.fn(),
}));
vi.mock("@/lib/workspace/window/useDurableWindowClose", () => ({
	useDurableWindowClose: mocks.useDurableWindowClose,
}));
vi.mock("@/lib/scm/review/diffReviewTarget", () => ({
	newDiffReviewId: () => "review-1",
}));
vi.mock("@/lib/scm/review/diffReviewRetention", () => ({
	startDiffReviewTargetRetention: () => vi.fn(),
}));
vi.mock("@/lib/i18n", () => ({ t: (key: string) => key }));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("DiffWindowRoot", () => {
	it("installs the durable close transaction for its persisted store realm", () => {
		render(<DiffWindowRoot agentId="missing-agent" />);

		expect(mocks.useDurableWindowClose).toHaveBeenCalledOnce();
	});
});
