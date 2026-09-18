// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import { MobileSimulatorProfiles } from "./MobileSimulatorProfiles";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
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
			value={value}
			disabled={disabled}
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
afterEach(cleanup);
it("restoring or selecting a saved profile never executes its command", () => {
	const device = { platform: "ios", id: "saved-device" } as const;
	const profile = {
		projectPath: "/project",
		buildCommand: "pnpm build",
		artifactPath: "Build.app",
		appId: "com.dure.qa",
		url: "qa://home",
		device,
	};
	const save = vi.fn();
	const run = vi.fn(async () => {});
	const select = vi.fn();
	render(
		<MobileSimulatorProfiles
			profiles={[profile]}
			target={device}
			busy={false}
			save={save}
			run={run}
			select={select}
		/>,
	);
	expect(run).not.toHaveBeenCalled();
	fireEvent.click(screen.getByText(t("panels.mobile.profiles")));
	fireEvent.change(screen.getByRole("combobox"), {
		target: {
			value: (screen.getAllByRole("option")[1] as HTMLOptionElement).value,
		},
	});
	expect(select).toHaveBeenCalledExactlyOnceWith(device);
	expect(run).not.toHaveBeenCalled();
	fireEvent.change(
		screen.getByRole("textbox", { name: t("panels.mobile.buildCommand") }),
		{ target: { value: "pnpm build:debug" } },
	);
	fireEvent.click(
		screen.getByRole("button", { name: t("panels.mobile.saveProfile") }),
	);
	expect(save).toHaveBeenCalledWith({
		...profile,
		buildCommand: "pnpm build:debug",
	});
	expect(run).not.toHaveBeenCalled();
	fireEvent.click(
		screen.getByRole("button", { name: t("panels.mobile.runProfile") }),
	);
	expect(run).toHaveBeenCalledExactlyOnceWith({
		...profile,
		buildCommand: "pnpm build:debug",
	});
});

it("loads the exact device and command when a project has multiple profiles", () => {
	const ios = { platform: "ios", id: "phone-one" } as const;
	const android = { platform: "android", id: "emulator-5554" } as const;
	const profile = {
		projectPath: "/project",
		buildCommand: "pnpm build:ios",
		artifactPath: "Build.app",
		appId: "com.dure.qa",
		url: "qa://home",
		device: ios,
	};
	const second = {
		...profile,
		buildCommand: "pnpm build:android",
		artifactPath: "app.apk",
		device: android,
	};
	const select = vi.fn();
	const run = vi.fn(async () => {});
	const save = vi.fn();
	render(
		<MobileSimulatorProfiles
			profiles={[profile, second]}
			target={ios}
			busy={false}
			save={save}
			run={run}
			select={select}
		/>,
	);
	fireEvent.click(screen.getByText(t("panels.mobile.profiles")));
	fireEvent.change(screen.getByRole("combobox"), {
		target: {
			value: (screen.getAllByRole("option")[2] as HTMLOptionElement).value,
		},
	});
	expect(select).toHaveBeenCalledExactlyOnceWith(android);
	expect(
		(
			screen.getByRole("textbox", {
				name: t("panels.mobile.buildCommand"),
			}) as HTMLInputElement
		).value,
	).toBe(second.buildCommand);
	expect(save).not.toHaveBeenCalled();
	expect(run).not.toHaveBeenCalled();
});
it("starts an empty draft without retaining old commands or changing saved profiles", () => {
	const device = { platform: "ios", id: "phone-one" } as const;
	const profile = {
		projectPath: "/project",
		buildCommand: "pnpm build",
		artifactPath: "Build.app",
		appId: "com.dure.qa",
		url: "qa://home",
		device,
	};
	const save = vi.fn();
	const run = vi.fn(async () => {});
	const select = vi.fn();
	render(
		<MobileSimulatorProfiles
			profiles={[profile]}
			target={device}
			busy={false}
			save={save}
			run={run}
			select={select}
		/>,
	);
	fireEvent.click(screen.getByText(t("panels.mobile.profiles")));
	fireEvent.change(screen.getByRole("combobox"), {
		target: {
			value: (screen.getAllByRole("option")[1] as HTMLOptionElement).value,
		},
	});
	select.mockClear();
	fireEvent.click(
		screen.getByRole("button", { name: t("panels.mobile.newProfile") }),
	);
	for (const input of screen.getAllByRole("textbox"))
		expect((input as HTMLInputElement).value).toBe("");
	expect(
		(
			screen.getByRole("button", {
				name: t("panels.mobile.runProfile"),
			}) as HTMLButtonElement
		).disabled,
	).toBe(true);
	expect(save).not.toHaveBeenCalled();
	expect(run).not.toHaveBeenCalled();
	expect(select).not.toHaveBeenCalled();
	fireEvent.change(screen.getByRole("combobox"), {
		target: {
			value: (screen.getAllByRole("option")[1] as HTMLOptionElement).value,
		},
	});
	expect(
		(
			screen.getByRole("textbox", {
				name: t("panels.mobile.buildCommand"),
			}) as HTMLInputElement
		).value,
	).toBe(profile.buildCommand);
});
