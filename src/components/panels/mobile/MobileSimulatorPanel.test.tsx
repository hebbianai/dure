// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import {
	type MobileDeviceTarget,
	mobileSimulator,
} from "@/lib/ipc/mobileSimulator";
import type { MobileRunProfile } from "@/lib/mobileSimulator/profile";
import { MobileSimulatorPanel } from "./MobileSimulatorPanel";

vi.mock("@/lib/ipc/mobileSimulator", () => ({
	mobileSimulator: {
		list: vi.fn(),
		capture: vi.fn(),
		act: vi.fn(),
		liveStart: vi.fn(),
		liveFrame: vi.fn(),
		liveStop: vi.fn(),
	},
}));
vi.mock("@/lib/workspace/pane/paneTitleOverrideStore", () => ({
	applyAutomaticPaneTitle: vi.fn(),
}));
vi.mock("@/components/ui/select-field", () => ({
	SelectField: ({
		children,
		value,
		onValueChange,
		disabled,
		"aria-label": label,
	}: {
		children: React.ReactNode;
		value: string;
		onValueChange: (value: string) => void;
		disabled: boolean;
		"aria-label": string;
	}) => (
		<select
			aria-label={label}
			disabled={disabled}
			value={value}
			onChange={(event) => onValueChange(event.target.value)}
		>
			{children}
		</select>
	),
	SelectOption: ({
		children,
		value,
	}: {
		children: React.ReactNode;
		value: string;
	}) => <option value={value}>{children}</option>,
}));
const ios = {
	platform: "ios",
	id: "11111111-2222-3333-4444-555555555555",
} as const;
const android = { platform: "android", id: "emulator-5554" } as const;
const catalog = {
	devices: [
		{ ...ios, name: "Phone", runtime: "iOS", state: "shutdown" },
		{ ...android, name: "Pixel", runtime: "Android", state: "ready" },
	],
	unavailable: [],
};
function fixture(
	device?: MobileDeviceTarget,
	visible = true,
	profiles: MobileRunProfile[] = [],
) {
	let changed = () => {};
	const api = {
		isVisible: visible,
		updateParameters: vi.fn(),
		onDidVisibilityChange: vi.fn((callback: () => void) => {
			changed = callback;
			return { dispose: vi.fn() };
		}),
	};
	const view = render(
		<MobileSimulatorPanel
			{...({
				api,
				params: { device, profiles },
			} as unknown as IDockviewPanelProps<{
				device?: MobileDeviceTarget;
			}>)}
		/>,
	);
	return {
		...view,
		api,
		visibility: (next: boolean) =>
			act(() => {
				api.isVisible = next;
				changed();
			}),
	};
}
beforeEach(() => {
	vi.mocked(mobileSimulator.list).mockResolvedValue(catalog);
	vi.mocked(mobileSimulator.capture).mockResolvedValue({
		dataUrl: "data:image/png;base64,YQ==",
		width: 400,
		height: 800,
	});
	vi.mocked(mobileSimulator.act).mockResolvedValue();
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});
it("restores selection without booting and boots only the selected device on request", async () => {
	fixture(ios);
	fireEvent.click(
		await screen.findByRole("button", { name: t("panels.mobile.boot") }),
	);
	await waitFor(() =>
		expect(mobileSimulator.act).toHaveBeenCalledExactlyOnceWith(ios, {
			kind: "boot",
		}),
	);
	expect(mobileSimulator.capture).not.toHaveBeenCalled();
});
it("persists exact selection and directs Android input to it", async () => {
	const { api } = fixture();
	await waitFor(() => expect(mobileSimulator.list).toHaveBeenCalled());
	fireEvent.change(screen.getByRole("combobox"), {
		target: { value: `android:${android.id}` },
	});
	await screen.findByRole("img");
	expect(api.updateParameters).toHaveBeenCalledWith({
		device: android,
		iosLandscape: false,
	});
	expect(mobileSimulator.act).not.toHaveBeenCalled();
	expect(
		screen.queryByRole("button", { name: t("panels.mobile.paste") }),
	).toBeNull();
	fireEvent.click(
		screen.getByRole("button", { name: t("panels.mobile.home") }),
	);
	await waitFor(() =>
		expect(mobileSimulator.act).toHaveBeenCalledExactlyOnceWith(android, {
			kind: "button",
			button: "home",
		}),
	);
});

it("sends a multiline Unicode draft through the explicit iOS paste button", async () => {
	vi.mocked(mobileSimulator.list).mockResolvedValue({
		...catalog,
		devices: catalog.devices.map((device) => ({ ...device, state: "ready" })),
	});
	vi.mocked(mobileSimulator.liveStart).mockResolvedValue("qa-live");
	vi.mocked(mobileSimulator.liveFrame).mockResolvedValue({
		dataUrl: "data:image/png;base64,YQ==",
		width: 400,
		height: 800,
	});
	vi.mocked(mobileSimulator.liveStop).mockResolvedValue();
	fixture(ios);
	await screen.findByRole("img");
	expect(
		screen.queryByRole("button", { name: t("panels.mobile.paste") }),
	).toBeNull();
	fireEvent.click(
		screen.getByRole("checkbox", { name: t("panels.mobile.live") }),
	);
	const text = "한글 🙂\nsecond\tline";
	fireEvent.change(
		await screen.findByRole("textbox", { name: t("panels.mobile.pasteText") }),
		{ target: { value: text } },
	);
	fireEvent.click(
		screen.getByRole("button", { name: t("panels.mobile.paste") }),
	);
	await waitFor(() =>
		expect(mobileSimulator.act).toHaveBeenCalledExactlyOnceWith(ios, {
			kind: "paste",
			text,
		}),
	);
});
it("does no SDK work while hidden and drops the in-flight frame when hidden", async () => {
	let resolve: (frame: {
		dataUrl: string;
		width: number;
		height: number;
	}) => void = () => {};
	vi.mocked(mobileSimulator.capture).mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	const view = fixture(android, false);
	expect(mobileSimulator.list).not.toHaveBeenCalled();
	view.visibility(true);
	await waitFor(() => expect(mobileSimulator.capture).toHaveBeenCalled());
	view.visibility(false);
	await act(async () =>
		resolve({ dataUrl: "data:image/png;base64,YQ==", width: 400, height: 800 }),
	);
	expect(screen.queryByRole("img")).toBeNull();
});
it("shows an absent restored device without selecting or controlling another", async () => {
	fixture({ ...ios, id: "missing" });
	await screen.findByText(t("panels.mobile.deviceGone"));
	expect(mobileSimulator.act).not.toHaveBeenCalled();
	expect(mobileSimulator.capture).not.toHaveBeenCalled();
});
it("keeps native failures visible", async () => {
	vi.mocked(mobileSimulator.act).mockRejectedValue("Device disconnected");
	fixture(android);
	fireEvent.click(
		await screen.findByRole("button", { name: t("panels.mobile.home") }),
	);
	expect((await screen.findByRole("alert")).textContent).toContain(
		"Device disconnected",
	);
});
it("refreshes observed device state after a partial failure without losing the original error", async () => {
	vi.mocked(mobileSimulator.act).mockImplementation(async () => {
		vi.mocked(mobileSimulator.list).mockResolvedValue({
			...catalog,
			devices: catalog.devices.map((device) => ({ ...device, state: "ready" })),
		});
		throw new Error("bootstatus timed out");
	});
	fixture(ios);
	fireEvent.click(
		await screen.findByRole("button", { name: t("panels.mobile.boot") }),
	);
	expect((await screen.findByRole("alert")).textContent).toContain(
		"bootstatus timed out",
	);
	await screen.findByRole("img");
	expect(
		screen.queryByRole("button", { name: t("panels.mobile.boot") }),
	).toBeNull();
	expect(mobileSimulator.act).toHaveBeenCalledTimes(1);
});

it("removes only the selected device profile and persists its siblings", async () => {
	const profile = {
		projectPath: "/project",
		buildCommand: "build",
		artifactPath: "Build.app",
		appId: "com.dure.qa",
		url: "",
		device: ios,
	};
	const otherPlatform = { ...profile, device: android };
	const otherPhone = { ...profile, device: { ...ios, id: "another-phone" } };
	const { api } = fixture(ios, true, [profile, otherPlatform, otherPhone]);
	await waitFor(() => expect(mobileSimulator.list).toHaveBeenCalled());
	fireEvent.click(screen.getByText(t("panels.mobile.profiles")));
	const combo = screen.getByRole("combobox", {
		name: t("panels.mobile.profiles"),
	});
	fireEvent.change(combo, {
		target: {
			value: (combo.querySelectorAll("option")[1] as HTMLOptionElement).value,
		},
	});
	fireEvent.click(screen.getByRole("button", { name: t("common.remove") }));
	expect(api.updateParameters).toHaveBeenLastCalledWith({
		profiles: [otherPlatform, otherPhone],
	});
	expect(screen.queryByRole("button", { name: t("common.remove") })).toBeNull();
	expect(mobileSimulator.act).not.toHaveBeenCalled();
});
