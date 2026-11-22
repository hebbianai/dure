// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentProjectMove } from "@/components/agents/AgentProjectMove";
import { t } from "@/lib/i18n";

const f = vi.hoisted(() => ({
	prepare: vi.fn(),
	preview: vi.fn(),
	apply: vi.fn(),
	status: vi.fn(),
	repair: vi.fn(),
}));
// The dialog runs every step through the port its surface passes; the pane's
// local port and the large window's bridge port are covered by their own tests.
const port = { prepare: f.prepare };
vi.mock("@/components/ui/select-field", () => ({
	SelectField: ({
		value,
		onValueChange,
		children,
		disabled,
		...props
	}: {
		value: string;
		onValueChange(value: string): void;
		children: React.ReactNode;
		disabled: boolean;
		"aria-label": string;
	}) => (
		<select
			aria-label={props["aria-label"]}
			value={value}
			disabled={disabled}
			onChange={(e) => onValueChange(e.target.value)}
		>
			<option value="" />
			{children}
		</select>
	),
	SelectOption: ({
		value,
		children,
	}: {
		value: string;
		children: React.ReactNode;
	}) => <option value={value}>{children}</option>,
}));
const plan = {
	workspaceMove: {
		sourceWorkspace: { rootPath: "/old" },
		targetProject: { projectId: "new" },
		targetWorkspace: { rootPath: "/new" },
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	f.prepare.mockResolvedValue({
		projects: [{ id: "new", displayName: "New" }],
		complete: true,
		preview: f.preview,
		apply: f.apply,
		status: f.status,
		repair: f.repair,
	});
	f.preview.mockResolvedValue(plan);
	f.apply.mockResolvedValue(undefined);
	f.repair.mockResolvedValue(undefined);
});
afterEach(cleanup);
async function preview() {
	render(<AgentProjectMove port={port} />);
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.projectMove.title") }),
	);
	await screen.findByRole("option", { name: "New" });
	fireEvent.change(screen.getByRole("combobox"), { target: { value: "new" } });
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.projectMove.preview") }),
	);
	await screen.findByText("/new");
}
describe("project move confirmation", () => {
	it("requires a separate confirmation after displaying the exact folders", async () => {
		await preview();
		expect(f.apply).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.projectMove.confirm") }),
		);
		await waitFor(() => expect(f.apply).toHaveBeenCalledWith(plan));
	});
	it("retains an uncertain plan and offers repair only after an exact status check", async () => {
		f.apply.mockRejectedValue(new Error("response lost"));
		f.status.mockResolvedValue("repair_required");
		await preview();
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.projectMove.confirm") }),
		);
		await screen.findByText(t("agents.projectMove.unconfirmed"));
		expect(f.preview).toHaveBeenCalledOnce();
		expect(
			screen.queryByRole("button", { name: t("agents.projectMove.repair") }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.projectMove.status") }),
		);
		fireEvent.click(
			await screen.findByRole("button", {
				name: t("agents.projectMove.repair"),
			}),
		);
		await waitFor(() => expect(f.repair).toHaveBeenCalledWith(plan));
	});
});

it("recovers durable repair controls after the pane remounts without another preview", async () => {
	await preview();
	cleanup();
	f.prepare.mockResolvedValue({
		projects: [],
		complete: true,
		recoveredPlan: plan,
		recoveredStatus: "repair_required",
		preview: f.preview,
		apply: f.apply,
		status: f.status,
		repair: f.repair,
	});
	render(<AgentProjectMove port={port} />);
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.projectMove.title") }),
	);
	fireEvent.click(
		await screen.findByRole("button", { name: t("agents.projectMove.repair") }),
	);
	await waitFor(() => expect(f.repair).toHaveBeenCalledWith(plan));
	expect(f.preview).toHaveBeenCalledOnce();
});
it("says a working conversation must finish before it can move", async () => {
	f.preview.mockRejectedValueOnce(
		Object.assign(new Error("busy"), { code: "agent_runtime_source_busy" }),
	);
	render(<AgentProjectMove port={port} />);
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.projectMove.title") }),
	);
	await screen.findByRole("option", { name: "New" });
	fireEvent.change(screen.getByRole("combobox"), { target: { value: "new" } });
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.projectMove.preview") }),
	);
	await screen.findByText(t("agents.projectMove.sourceBusy"));
	expect(screen.queryByText(t("agents.projectMove.failed"))).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: t("common.retry") }));
	await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(2));
	expect(screen.queryByText(t("agents.projectMove.sourceBusy"))).toBeNull();
	expect(f.apply).not.toHaveBeenCalled();
});

it("refreshes a locally stale preparation without closing the dialog", async () => {
	f.preview.mockRejectedValueOnce(
		Object.assign(new Error("client_project_move_preview_stale"), {
			code: "client_project_move_preview_stale",
			submitted: false,
		}),
	);
	render(<AgentProjectMove port={port} />);
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.projectMove.title") }),
	);
	await screen.findByRole("option", { name: "New" });
	fireEvent.change(screen.getByRole("combobox"), { target: { value: "new" } });
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.projectMove.preview") }),
	);
	fireEvent.click(
		await screen.findByRole("button", { name: t("common.retry") }),
	);
	await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(2));
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.projectMove.preview") }),
	);
	await screen.findByText("/new");
	expect(f.apply).not.toHaveBeenCalled();
});

it("keeps Retry usable after a local repair refusal", async () => {
	f.prepare.mockResolvedValue({
		projects: [],
		complete: true,
		recoveredPlan: plan,
		recoveredStatus: "repair_required",
		preview: f.preview,
		apply: f.apply,
		status: f.status,
		repair: f.repair,
	});
	f.repair.mockRejectedValueOnce(
		Object.assign(new Error("client_project_move_pending_input"), {
			code: "client_project_move_pending_input",
			submitted: false,
		}),
	);
	render(<AgentProjectMove port={port} />);
	fireEvent.click(
		screen.getByRole("button", { name: t("agents.projectMove.title") }),
	);
	fireEvent.click(
		await screen.findByRole("button", { name: t("agents.projectMove.repair") }),
	);
	const retry = await screen.findByRole("button", { name: t("common.retry") });
	expect((retry as HTMLButtonElement).disabled).toBe(false);
	fireEvent.click(retry);
	await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(2));
	expect(f.apply).not.toHaveBeenCalled();
	expect(f.preview).not.toHaveBeenCalled();
});

it.each(["apply", "status", "repair"])(
	"prepares a fresh move after confirmed %s without remounting the Chat pane",
	async (completion) => {
		if (completion !== "apply")
			f.apply.mockRejectedValueOnce(new Error("response lost"));
		f.status.mockResolvedValue(
			completion === "repair" ? "repair_required" : "completed",
		);
		await preview();
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.projectMove.confirm") }),
		);
		if (completion !== "apply") {
			await screen.findByText(t("agents.projectMove.unconfirmed"));
			fireEvent.click(
				screen.getByRole("button", { name: t("agents.projectMove.status") }),
			);
			if (completion === "repair")
				fireEvent.click(
					await screen.findByRole("button", {
						name: t("agents.projectMove.repair"),
					}),
				);
		}
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.projectMove.title") }),
		);
		await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(2));
		expect(screen.queryByText("/new")).toBeNull();
		expect(
			screen.getByRole("button", { name: t("agents.projectMove.preview") }),
		).toBeTruthy();
	},
);
