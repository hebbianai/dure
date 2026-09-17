import { relaunch } from "@tauri-apps/plugin-process";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { t } from "@/lib/i18n";
import {
	upsertUpdateNotice,
	type UpdateNotice,
} from "@/lib/updates/updateNotice";
import { formatBytes } from "@/lib/usage/systemResources";
import { withPreparedAppRestart } from "@/lib/workspace/window/appRestart";

const restartErrors: Record<string, string> = {
	app_restart_draft_conflict: "platform.updater.draftConflict",
	app_restart_documents_changed: "platform.updater.documentsChanged",
	app_restart_window_unresponsive: "platform.updater.windowUnresponsive",
	app_restart_windows_changed: "platform.updater.windowChanged",
	app_restart_window_reloaded: "platform.updater.windowChanged",
	app_restart_cancelled: "platform.updater.preparationCancelled",
	app_restart_preparation_missing: "platform.updater.preparationCancelled",
	app_restart_already_preparing: "platform.updater.restartUnavailable",
	app_restart_lock_unavailable: "platform.updater.restartUnavailable",
	app_restart_owner_missing: "platform.updater.restartUnavailable",
};

/** Owns one signed update resource until replacement or process exit. */
export class AppUpdateSession {
	private stage:
		| "available"
		| "downloaded"
		| "installed"
		| "restart-requested" = "available";
	private busy = false;
	private progress: UpdateNotice["progress"];
	private progressLabel = "common.updating";
	readonly revision: string;

	constructor(
		private readonly sourceRef: string,
		private readonly update: Update,
		private readonly actionStarted: () => void,
	) {
		this.revision = JSON.stringify([update.currentVersion, update.version]);
	}

	get blocksChecks(): boolean {
		return this.busy || this.stage !== "available";
	}
	close(): Promise<void> {
		return this.update.close();
	}

	publish(): void {
		const ready = this.stage === "downloaded";
		const restartOnly =
			this.stage === "installed" || this.stage === "restart-requested";
		const actionLabel = restartOnly
			? "platform.updater.restart"
			: ready
				? "platform.updater.installRestart"
				: "platform.updater.download";
		upsertUpdateNotice({
			sourceRef: this.sourceRef,
			revision: this.revision,
			importance: "application",
			title: t(
				ready || restartOnly
					? "platform.updater.readyToRestart"
					: "platform.updater.updateAvailable",
			),
			description: t("platform.updater.versionReady", {
				version: this.update.version,
			}),
			impact: t(
				ready || restartOnly
					? "platform.updater.restartImpact"
					: "platform.updater.downloadImpact",
			),
			details: [
				`${this.update.currentVersion} → ${this.update.version}`,
				this.update.body?.trim(),
			]
				.filter(Boolean)
				.join("\n\n"),
			...(this.progress ? { progress: this.progress } : {}),
			primaryAction: {
				label: t(actionLabel),
				progressLabel: t(this.progressLabel),
				disabled: this.stage === "restart-requested",
				completion: "retain",
				run: () => this.run(),
			},
		});
	}

	private report(key: string): void {
		this.progressLabel = key;
		this.progress = { label: t(key) };
		this.publish();
	}

	private async run(): Promise<void> {
		if (this.busy || this.stage === "restart-requested") return;
		this.actionStarted();
		this.busy = true;
		let failure = "platform.updater.downloadFailed";
		try {
			if (this.stage === "available") {
				let downloaded = 0;
				let total: number | undefined;
				let lastBucket: number | undefined;
				let firstChunk = true;
				this.report("platform.updater.downloading");
				await this.update.download((event: DownloadEvent) => {
					if (event.event === "Finished") {
						this.report("platform.updater.verifying");
						return;
					}
					if (event.event === "Started") {
						downloaded = 0;
						total = event.data.contentLength;
						lastBucket = undefined;
						firstChunk = true;
					} else downloaded += event.data.chunkLength;
					const knownTotal =
						total !== undefined &&
						Number.isFinite(total) &&
						total > 0 &&
						downloaded <= total;
					const bucket =
						knownTotal && total !== undefined
							? Math.floor((downloaded / total) * 100)
							: Math.floor(downloaded / (1024 * 1024));
					// Publish meaningful byte changes, not thousands of chunk renders or announcements.
					if (
						event.event === "Progress" &&
						!firstChunk &&
						bucket === lastBucket
					)
						return;
					if (event.event === "Progress") firstChunk = false;
					lastBucket = bucket;
					this.progress = {
						label: t(
							knownTotal
								? "platform.updater.downloadBytesTotal"
								: "platform.updater.downloadBytes",
							{
								downloaded: formatBytes(downloaded),
								total: formatBytes(total ?? 0),
							},
						),
						...(knownTotal && total !== undefined
							? { percent: Math.floor((downloaded / total) * 100) }
							: {}),
					};
					this.publish();
				});
				// Finished is a transport event; only download() resolution proves signature verification.
				this.stage = "downloaded";
				this.progress = undefined;
				this.publish();
				return;
			}
			failure = "platform.updater.prepareFailed";
			this.report("platform.updater.preparing");
			await withPreparedAppRestart(async (verifyPrepared) => {
				if (this.stage === "downloaded") {
					failure = "platform.updater.installFailed";
					this.report("platform.updater.installing");
					await this.update.install();
					this.stage = "installed";
				}
				failure = "platform.updater.prepareFailed";
				await verifyPrepared();
				failure = "platform.updater.restartFailed";
				this.report("platform.updater.restarting");
				await relaunch();
				this.stage = "restart-requested";
				this.publish();
			});
		} catch (error) {
			this.progress = undefined;
			this.publish();
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(
				t(failure, {
					error: restartErrors[reason] ? t(restartErrors[reason]) : reason,
				}),
			);
		} finally {
			this.busy = false;
		}
	}
}
