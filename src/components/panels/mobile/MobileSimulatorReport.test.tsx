// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { deliverCaptureToAgent } from "@/lib/agents/captureDraftDelivery";
import { t } from "@/lib/i18n";
import { mobileSimulator } from "@/lib/ipc/mobileSimulator";
import type { MobileReportControls } from "@/lib/mobileSimulator/controlActions";
import { MobileSimulatorReport } from "./MobileSimulatorReport";

vi.mock("@/lib/ipc/system", () => ({
	saveTempImage: vi.fn(async () => "/tmp/report.png"),
}));
vi.mock("@/lib/ipc/mobileSimulator", () => ({
	mobileSimulator: { capture: vi.fn(), report: vi.fn() },
}));
vi.mock("@/lib/agents/captureDraftDelivery", () => ({
	deliverCaptureToAgent: vi.fn(),
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
vi.mock("@/store", () => ({
	useStore: (read: (value: unknown) => unknown) =>
		read({ agents: [{ id: "chosen-agent", name: "Chosen agent" }] }),
}));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});
it("shares the editable report with agent controls and refuses replaced or already delivered packets", async () => {
	const target = { platform: "ios", id: "owned" } as const;
	vi.mocked(mobileSimulator.report).mockResolvedValue({
		device: { ...target, name: "QA", runtime: "iOS", state: "ready" },
		appId: "com.dure.qa",
		logs: "evidence",
		logError: null,
		recentActions: [],
	});
	vi.mocked(mobileSimulator.capture).mockResolvedValue({
		dataUrl: "data:image/png;base64,YQ==",
		width: 400,
		height: 800,
	});
	const ref = createRef<MobileReportControls>();
	render(
		<MobileSimulatorReport
			capture={() => mobileSimulator.capture(target)}
			target={target}
			busy={false}
			ref={ref}
		/>,
	);
	let first = "";
	let current = "";
	await act(async () => {
		first = (await ref.current!.prepare("com.dure.qa")).reportId;
	});
	await act(async () => {
		current = (await ref.current!.prepare("com.dure.qa")).reportId;
	});
	expect(current).not.toBe(first);
	await expect(ref.current!.draft(first, "chosen-agent")).rejects.toThrow(
		t("panels.mobile.reportChanged"),
	);
	await expect(ref.current!.draft(current, "missing-agent")).rejects.toThrow(
		t("common.sendToAgent"),
	);
	expect(deliverCaptureToAgent).not.toHaveBeenCalled();
	fireEvent.change(
		screen.getByRole("textbox", { name: t("panels.mobile.report") }),
		{ target: { value: "human edited notes" } },
	);
	await act(async () => {
		await ref.current!.draft(current, "chosen-agent");
	});
	expect(deliverCaptureToAgent).toHaveBeenCalledWith(
		"chosen-agent",
		"human edited notes",
		expect.any(Array),
	);
	await expect(ref.current!.draft(current, "chosen-agent")).rejects.toThrow(
		t("panels.mobile.reportChanged"),
	);
	expect(deliverCaptureToAgent).toHaveBeenCalledTimes(1);
});
it("collects only the explicit app, offers editable evidence and never sends it automatically", async () => {
	const target = { platform: "android", id: "qa" } as const;
	vi.mocked(mobileSimulator.report).mockResolvedValue({
		device: { ...target, name: "QA", runtime: "Android", state: "ready" },
		appId: "com.dure.qa",
		logs: "app log",
		logError: null,
		recentActions: [],
	});
	vi.mocked(mobileSimulator.capture).mockResolvedValue({
		dataUrl: "data:image/png;base64,YQ==",
		width: 400,
		height: 800,
	});
	render(
		<MobileSimulatorReport
			capture={() => mobileSimulator.capture(target)}
			target={target}
			busy={false}
		/>,
	);
	fireEvent.click(screen.getByText(t("panels.mobile.report")));
	fireEvent.change(
		screen.getByRole("textbox", { name: t("panels.mobile.appId") }),
		{ target: { value: "com.dure.qa" } },
	);
	fireEvent.click(
		screen.getByRole("button", { name: t("panels.mobile.prepareReport") }),
	);
	await waitFor(() =>
		expect(mobileSimulator.report).toHaveBeenCalledWith(target, "com.dure.qa"),
	);
	const review = await screen.findByRole("textbox", {
		name: t("panels.mobile.report"),
	});
	expect((review as HTMLTextAreaElement).value).toContain("app log");
	fireEvent.change(review, { target: { value: "redacted notes" } });
	expect((review as HTMLTextAreaElement).value).toBe("redacted notes");
	expect(deliverCaptureToAgent).not.toHaveBeenCalled();
	fireEvent.change(
		screen.getByRole("combobox", { name: t("common.sendToAgent") }),
		{ target: { value: "chosen-agent" } },
	);
	fireEvent.click(
		screen.getByRole("button", { name: t("common.typeIntoPrompt") }),
	);
	await waitFor(() =>
		expect(deliverCaptureToAgent).toHaveBeenCalledExactlyOnceWith(
			"chosen-agent",
			"redacted notes",
			[
				{
					kind: "bytes",
					file: { fileName: "mobile-screen.png", dataB64: "YQ==" },
				},
			],
		),
	);
	expect(await screen.findByRole("status")).toBeTruthy();
});
