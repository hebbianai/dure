import { afterEach, describe, expect, it, vi } from "vitest";
import {
	dismissUpdateNotice,
	performUpdateNoticeAction,
	resetUpdateNotices,
	updateNoticeSnapshot,
	upsertUpdateNotice,
} from "@/lib/updates/updateNotice";

function notice(revision: string, run: () => void | Promise<void> = vi.fn()) {
	return {
		sourceRef: "source.fixture",
		revision,
		title: "Update available",
		description: `Revision ${revision}`,
		impact: "No session interruption",
		primaryAction: {
			label: "Update",
			progressLabel: "Updating…",
			completion: "resolve" as const,
			run,
		},
	};
}

describe("update notice projection", () => {
	afterEach(resetUpdateNotices);

	it("keeps a dismissed revision badged and resurfaces a replacement revision", () => {
		upsertUpdateNotice(notice("v1"));
		dismissUpdateNotice("source.fixture");

		expect(updateNoticeSnapshot()).toMatchObject({
			unresolvedCount: 1,
			notices: [{ revision: "v1", dismissed: true }],
		});

		upsertUpdateNotice(notice("v1"));
		expect(updateNoticeSnapshot().notices[0]?.dismissed).toBe(true);

		upsertUpdateNotice(notice("v2"));
		expect(updateNoticeSnapshot()).toMatchObject({
			unresolvedCount: 1,
			notices: [{ revision: "v2", dismissed: false, phase: "ready" }],
		});
	});

	it("does not let an older action completion resolve a replacement revision", async () => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		upsertUpdateNotice(notice("v1", () => pending));
		const action = performUpdateNoticeAction("source.fixture");
		upsertUpdateNotice(notice("v2"));

		finish();
		await action;

		expect(updateNoticeSnapshot()).toMatchObject({
			unresolvedCount: 1,
			notices: [{ revision: "v2" }],
		});
	});
});
