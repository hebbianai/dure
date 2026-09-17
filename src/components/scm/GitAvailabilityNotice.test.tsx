// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GitAvailabilityNotice } from "./GitAvailabilityNotice";
import { t } from "@/lib/i18n";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

it("opens the official download page and lets the user explicitly recheck", async () => {
	openUrl.mockResolvedValue(undefined);
	const recheck = vi.fn();
	render(
		<GitAvailabilityNotice state={{ status: "missing" }} recheck={recheck} />,
	);
	fireEvent.click(
		screen.getByRole("button", { name: t("panels.git.availability.install") }),
	);
	await waitFor(() =>
		expect(openUrl).toHaveBeenCalledWith("https://git-scm.com/downloads"),
	);
	fireEvent.click(
		screen.getByRole("button", { name: t("panels.git.availability.recheck") }),
	);
	expect(recheck).toHaveBeenCalledOnce();
});

it("keeps a remote failure unknown and explains which host needs attention", () => {
	render(
		<GitAvailabilityNotice
			state={{ status: "unknown", detail: "connection lost" }}
			hostName="Build host"
			recheck={vi.fn()}
		/>,
	);
	expect(screen.getByText("connection lost")).toBeTruthy();
	expect(
		screen.getByText(
			t("panels.git.availability.remote", { host: "Build host" }),
		),
	).toBeTruthy();
	expect(
		screen.queryByRole("button", {
			name: t("panels.git.availability.install"),
		}),
	).toBeNull();
});
