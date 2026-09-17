// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store", async () => {
	const { create } = await import("zustand");
	const { createSshHostsStoreSlice } = await import(
		"@/lib/ssh/sshHostsStoreSlice"
	);
	return { useStore: create(createSshHostsStoreSlice) };
});
vi.mock("@/lib/i18n", () => ({
	t: (key: string, params?: { destination?: string }) =>
		params?.destination ?? key,
}));

import { useStore } from "@/store";
import { SshRegistrationDialog } from "./SshRegistrationDialog";

const candidate = {
	name: "qa@192.0.2.1:22",
	host: "192.0.2.1",
	port: 22,
	user: "qa",
	auth: "auto" as const,
};

describe("SSH registration decision", () => {
	afterEach(() => {
		act(() => {
			for (const decision of useStore.getState().sshRegistrationDecisions)
				decision.answer(false);
		});
		cleanup();
		vi.useRealTimers();
	});

	it("offers an accessible choice and resolves acceptance without writing hosts", async () => {
		render(<SshRegistrationDialog />);
		expect(screen.queryByRole("dialog")).toBeNull();
		let result!: Promise<boolean>;
		act(() => {
			result = useStore
				.getState()
				.requestSshRegistrationDecision("accept", candidate, 30_000);
		});
		expect(
			screen.getByRole("dialog").getAttribute("aria-describedby"),
		).toBeTruthy();
		expect(screen.getByText(candidate.name)).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "ssh.registrationPrompt.save" }),
		);
		await expect(result).resolves.toBe(true);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(useStore.getState().sshHosts).toEqual([]);
	});

	it.each(["button", "escape"])(
		"declines using %s and preserves the next pending choice",
		async (method) => {
			render(<SshRegistrationDialog />);
			let first!: Promise<boolean>;
			let second!: Promise<boolean>;
			act(() => {
				first = useStore
					.getState()
					.requestSshRegistrationDecision("one", candidate, 30_000);
				second = useStore
					.getState()
					.requestSshRegistrationDecision(
						"two",
						{ ...candidate, name: "second" },
						30_000,
					);
			});
			if (method === "button")
				fireEvent.click(
					screen.getByRole("button", { name: "ssh.registrationPrompt.useSsh" }),
				);
			else fireEvent.keyDown(document, { key: "Escape" });
			await expect(first).resolves.toBe(false);
			expect(screen.getByText("second")).toBeTruthy();
			fireEvent.click(
				screen.getByRole("button", { name: "ssh.registrationPrompt.useSsh" }),
			);
			await expect(second).resolves.toBe(false);
			expect(screen.queryByRole("dialog")).toBeNull();
		},
	);

	it("removes an unanswered dialog when its native-admitted lifetime elapses", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		render(<SshRegistrationDialog />);
		let result!: Promise<boolean>;
		act(() => {
			result = useStore
				.getState()
				.requestSshRegistrationDecision("expire", candidate, 30_000);
		});
		expect(screen.getByRole("dialog")).toBeTruthy();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		await expect(result).resolves.toBe(false);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
