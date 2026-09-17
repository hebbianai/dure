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
		target: { value: "/project" },
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
