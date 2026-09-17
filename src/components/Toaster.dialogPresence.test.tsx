// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityRail } from "@/components/sidebar/ActivityRail";
import { Toaster } from "@/components/Toaster";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { setLang, t } from "@/lib/i18n";
import {
	dismissUpdateNotice,
	resetUpdateNotices,
	resurfaceUpdateNotices,
	upsertUpdateNotice,
} from "@/lib/updates/updateNotice";

function WindowWithDialogs({ open = false, nested = false }) {
	return (
		<>
			<ActivityRail onOpenSettings={() => {}} />
			<Dialog open={open}>
				<DialogContent aria-describedby={undefined}>
					<DialogTitle>Outer dialog</DialogTitle>
					<Dialog open={nested}>
						<DialogContent aria-describedby={undefined}>
							<DialogTitle>Inner dialog</DialogTitle>
						</DialogContent>
					</Dialog>
				</DialogContent>
			</Dialog>
			<Toaster />
		</>
	);
}

describe("dialog surface presence and update notices", () => {
	beforeEach(() => {
		setLang("en");
		for (const title of ["First update", "Second update"]) {
			upsertUpdateNotice({
				sourceRef: title,
				revision: "1",
				title,
				description: "An available fixture update",
				impact: "No application changes",
				primaryAction: {
					label: "Review update",
					progressLabel: "Reviewing",
					completion: "retain",
					run: () => {},
				},
			});
			dismissUpdateNotice(title);
		}
	});

	afterEach(() => {
		cleanup();
		resetUpdateNotices();
		setLang("ko");
	});

	it("lets the rail resurface updates while a closed dialog stays mounted", () => {
		render(<WindowWithDialogs />);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByText("First update")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", {
				name: t("sidebar.rail.updatesNeedAction", { count: 2 }),
			}),
		);
		expect(screen.getByRole("heading", { name: "First update" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Next update" }));
		expect(screen.getByRole("heading", { name: "Second update" })).toBeTruthy();
	});

	it("releases suppression on close without unmounting the dialog wrapper", () => {
		act(resurfaceUpdateNotices);
		const window = render(<WindowWithDialogs open />);
		expect(screen.getByRole("dialog", { name: "Outer dialog" })).toBeTruthy();
		expect(screen.queryByText("First update")).toBeNull();
		window.rerender(<WindowWithDialogs />);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.getByRole("heading", { name: "First update" })).toBeTruthy();
	});

	it("keeps notices out of nested modals until the last surface closes", () => {
		act(resurfaceUpdateNotices);
		const window = render(<WindowWithDialogs open nested />);
		expect(screen.getByRole("dialog", { name: "Inner dialog" })).toBeTruthy();
		expect(screen.queryByText("First update")).toBeNull();
		window.rerender(<WindowWithDialogs open />);
		expect(screen.getByRole("dialog", { name: "Outer dialog" })).toBeTruthy();
		expect(screen.queryByText("First update")).toBeNull();
		window.rerender(<WindowWithDialogs />);
		expect(screen.getByRole("heading", { name: "First update" })).toBeTruthy();
	});
});
