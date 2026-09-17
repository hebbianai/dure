import {
	type BrowserControllerLease,
	type BrowserControlProjection,
	type BrowserFrame,
	type BrowserObservation,
	type BrowserPageIdentity,
	type BrowserResourceIdentity,
	sameBrowserPage,
} from "@/lib/browser/browserResourceContract";
import type {
	BrowserPaneAction,
	createDureBrowserClient,
} from "@/lib/ipc/dureBrowser";

type Client = ReturnType<typeof createDureBrowserClient>;
export interface BrowserPaneView {
	/** Local intent delivery, separate from the Host's runtime in-flight fact. */
	readonly submitting?: boolean;
	readonly control?: BrowserControlProjection;
	readonly observation?: BrowserObservation;
	/** This view's choice can precede the complete page observation. */
	readonly selectedPageId?: string;
	readonly followingCurrent?: boolean;
	readonly page?: BrowserPageIdentity;
	readonly frame?: { readonly capture: BrowserFrame; readonly src: string };
	readonly error?: Error;
}

type Input = {
	kind: "input";
	lease: BrowserControllerLease;
	page: BrowserPageIdentity;
	action: BrowserPaneAction;
	operation: string;
	selectionVersion: number;
	resolve: ((data: unknown) => void)[];
	reject: ((error: Error) => void)[];
};
type Job =
	| Input
	| {
			kind: "release";
			lease: BrowserControllerLease;
			resolve: (() => void)[];
			reject: ((error: Error) => void)[];
	  }
	| {
			kind: "handoff";
			controllerId: string;
			expected?: BrowserControllerLease | null;
			selectionVersion: number;
			resolve: (() => void)[];
			reject: ((error: Error) => void)[];
	  };

function failure(code: string): Error {
	return new Error(code);
}
function error(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
const sameLease = (
	a: BrowserControllerLease | null | undefined,
	b: BrowserControllerLease,
) => a?.controller_id === b.controller_id && a.epoch === b.epoch;

function coalesceInput(previous: BrowserPaneAction, next: BrowserPaneAction) {
	if (previous.kind === "mouse" && next.kind === "mouse") {
		const a = previous.action;
		const b = next.action;
		if (a.kind === "move" && b.kind === "move") return next;
		if (
			a.kind === "wheel" &&
			b.kind === "wheel" &&
			a.x === b.x &&
			a.y === b.y
		) {
			const delta_x = a.delta_x + b.delta_x;
			const delta_y = a.delta_y + b.delta_y;
			// Keep reversals ordered and each proposal within the pointer contract.
			if (
				Math.sign(a.delta_x) === Math.sign(b.delta_x) &&
				Math.sign(a.delta_y) === Math.sign(b.delta_y) &&
				[delta_x, delta_y].every(
					(value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000,
				)
			)
				return { ...next, action: { ...b, delta_x, delta_y } };
		}
	}
	if (
		previous.kind === "environment" &&
		previous.action.kind === "viewport" &&
		next.kind === "environment" &&
		next.action.kind === "viewport"
	)
		return next;
	return undefined;
}

async function decodeBrowserFrame(frame: BrowserFrame): Promise<string> {
	const src = `data:${frame.mimeType};base64,${frame.base64}`;
	const image = new Image();
	image.src = src;
	await image.decode();
	if (!image.naturalWidth || !image.naturalHeight)
		throw failure("browser_frame_decode_failed");
	return src;
}

/** A view's ordered input intents and latest rendered observation. Runtime
 * authority comes exclusively from the client/Host projections. */
export class BrowserPaneSession {
	private view: BrowserPaneView = {};
	private readError?: { stage: "observe" | "frame"; error: Error };
	private inputError?: Error;
	private readonly listeners = new Set<() => void>();
	private readonly queue: Job[] = [];
	private refreshing?: Promise<void>;
	private draining?: Promise<void>;
	private releasing?: Promise<void>;
	private disposed = false;
	private selectionVersion = 0;
	/** The return intent may resume following only if no newer viewer choice exists. */
	private returningSelection?: {
		lease: BrowserControllerLease;
		version: number;
	};
	/** Absence follows Host's current target; a page ID pins this viewer only. */
	private selectedPage?: { id: string };
	/** A completed page transition invalidates snapshots taken before its receipt. */
	private minimumObservationRevision = 0n;

	constructor(
		readonly client: Client,
		readonly resource: BrowserResourceIdentity,
		readonly controllerId: string,
		pageId?: string,
		private readonly decode = decodeBrowserFrame,
	) {
		this.selectedPage = pageId ? { id: pageId } : undefined;
	}

	read = (): BrowserPaneView => this.view;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private publish(view: BrowserPaneView) {
		if (this.disposed) return;
		this.view = { ...view, error: this.inputError ?? this.readError?.error };
		for (const listener of this.listeners) listener();
	}
	private observe(observation: BrowserObservation) {
		if (BigInt(observation.control.revision) < this.minimumObservationRevision)
			return;
		if (
			this.view.observation &&
			BigInt(observation.control.revision) <
				BigInt(this.view.observation.control.revision)
		)
			return;
		const previousController = this.view.control?.controller;
		const control =
			this.view.control &&
			BigInt(this.view.control.revision) > BigInt(observation.control.revision)
				? this.view.control
				: observation.control;
		if (observation.observation_error) {
			this.readError = {
				stage: "observe",
				error: failure(observation.observation_error),
			};
			// Failed reads carry current control but no page inventory. They
			// revoke rendered input without proving the inspected tab closed.
			this.publish({
				...this.view,
				control,
				observation,
				selectedPageId: this.selectedPage?.id,
				followingCurrent: this.selectedPage === undefined,
				page: undefined,
				frame: undefined,
			});
			this.controllerChanged(previousController);
			return;
		}
		if (this.readError?.stage === "observe") this.readError = undefined;
		const inspected = observation.pages.find(
			(row) => row.page.page_id === this.selectedPage?.id,
		)?.page;
		if (this.selectedPage && !inspected) this.selectedPage = undefined;
		const followingCurrent = this.selectedPage === undefined;
		const page = followingCurrent
			? observation.pages.find(
					(row) =>
						control.current_page &&
						sameBrowserPage(row.page, control.current_page),
				)?.page
			: inspected;
		if (this.selectedPage && inspected)
			this.selectedPage = { id: inspected.page_id };
		this.publish({
			...this.view,
			control,
			observation,
			selectedPageId: this.selectedPage?.id ?? page?.page_id,
			followingCurrent,
			page,
			frame:
				page &&
				this.view.frame &&
				sameBrowserPage(page, this.view.frame.capture.page)
					? this.view.frame
					: undefined,
		});
		this.controllerChanged(previousController);
	}
	private control(control: BrowserControlProjection) {
		if (
			!this.view.control ||
			BigInt(control.revision) >= BigInt(this.view.control.revision)
		) {
			const previousController = this.view.control?.controller;
			this.publish({ ...this.view, control });
			this.controllerChanged(previousController);
		}
	}
	private controllerChanged(
		previous: BrowserControllerLease | null | undefined,
	) {
		if (this.disposed) return;
		const control = this.view.control;
		const lease = control?.controller;
		const returning = this.returningSelection;
		if (returning && !sameLease(lease, returning.lease))
			this.returningSelection = undefined;
		if (
			previous?.controller_id === this.controllerId &&
			lease?.controller_id !== this.controllerId
		) {
			if (
				!returning ||
				!sameLease(previous, returning.lease) ||
				returning.version === this.selectionVersion
			)
				this.selectPage(undefined);
			return;
		}
		const page = this.view.page;
		if (
			lease?.controller_id === this.controllerId &&
			!sameLease(previous, lease) &&
			control?.phase === "ready" &&
			!control.requested_controller &&
			this.selectedPage &&
			page &&
			(!control.current_page || !sameBrowserPage(page, control.current_page))
		) {
			// Only the observed grant admits this intent. Re-observing that lease
			// does not replay a failed selection or allocate another operation.
			void this.input({ kind: "select_page" }, page).catch(() => {});
		}
	}
	selectPage(pageId: string | undefined) {
		++this.selectionVersion;
		this.selectedPage = pageId ? { id: pageId } : undefined;
		if (this.view.observation) this.observe(this.view.observation);
	}
	refresh(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		this.refreshing ??= this.refreshFrame().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}
	private async refreshFrame() {
		let stage: "observe" | "frame" = "observe";
		try {
			this.observe(await this.client.observe(this.resource));
			const page = this.view.page;
			if (!page || this.disposed) return;
			stage = "frame";
			const capture = await this.client.frame(page);
			const src = await this.decode(capture);
			if (this.view.page && sameBrowserPage(this.view.page, capture.page)) {
				this.readError = undefined;
				this.publish({ ...this.view, frame: { capture, src } });
			}
		} catch (caught) {
			this.readError = { stage, error: error(caught) };
			this.publish(this.view);
		}
	}

	handoff(
		controllerId: string,
		expected?: BrowserControllerLease | null,
	): Promise<void> {
		if (this.disposed) return Promise.reject(failure("browser_view_closed"));
		return new Promise((resolve, reject) => {
			this.queue.push({
				kind: "handoff",
				controllerId,
				expected,
				selectionVersion: this.selectionVersion,
				resolve: [resolve],
				reject: [reject],
			});
			this.startDrain();
		});
	}

	input(action: BrowserPaneAction, page = this.view.page): Promise<unknown> {
		const control = this.view.control;
		const lease = control?.controller;
		if (
			this.disposed ||
			!page ||
			!lease ||
			lease.controller_id !== this.controllerId ||
			control.phase !== "ready" ||
			control.requested_controller
		)
			return Promise.reject(failure("browser_controller_changed"));
		return new Promise((resolve, reject) => {
			const previous = this.queue[this.queue.length - 1];
			const positioned = this.queue[this.queue.length - 2];
			// Wheel events include a pointer position. Repeating that same queued
			// move between wheels defeats coalescing and accumulates old gestures.
			if (
				action.kind === "mouse" &&
				action.action.kind === "move" &&
				previous?.kind === "input" &&
				previous.action.kind === "mouse" &&
				previous.action.action.kind === "wheel" &&
				previous.action.action.x === undefined &&
				previous.action.action.y === undefined &&
				positioned?.kind === "input" &&
				positioned.action.kind === "mouse" &&
				positioned.action.action.kind === "move" &&
				positioned.action.action.x === action.action.x &&
				positioned.action.action.y === action.action.y &&
				[positioned, previous].every(
					(item) =>
						sameLease(item.lease, lease) &&
						sameBrowserPage(item.page, page) &&
						item.selectionVersion === this.selectionVersion,
				)
			) {
				previous.resolve.push(resolve);
				previous.reject.push(reject);
				return;
			}
			const combined =
				previous?.kind === "input"
					? coalesceInput(previous.action, action)
					: undefined;
			if (
				previous?.kind === "input" &&
				combined &&
				sameLease(previous.lease, lease) &&
				sameBrowserPage(previous.page, page) &&
				previous.selectionVersion === this.selectionVersion
			) {
				previous.action = combined;
				previous.resolve.push(resolve);
				previous.reject.push(reject);
			} else {
				this.queue.push({
					kind: "input",
					lease,
					page,
					action,
					operation: crypto.randomUUID(),
					selectionVersion: this.selectionVersion,
					resolve: [resolve],
					reject: [reject],
				});
			}
			this.startDrain();
		});
	}
	private startDrain() {
		if (this.draining || this.disposed || !this.queue.length) return;
		this.draining = this.drain().finally(() => {
			this.draining = undefined;
			if (!this.queue.length) this.publish({ ...this.view, submitting: false });
			this.startDrain();
		});
		this.publish({ ...this.view, submitting: true });
	}
	private async drain() {
		while (this.queue.length && !this.disposed) {
			const item = this.queue.shift();
			if (!item) return;
			try {
				if (item.kind === "release") {
					await this.releaseHeld(item.lease);
					for (const resolve of item.resolve) resolve();
					continue;
				}
				if (item.kind === "handoff") {
					const observed = await this.client.control(this.resource);
					this.control(observed);
					if (
						item.expected !== undefined &&
						(item.expected === null
							? observed.controller !== null
							: !sameLease(observed.controller, item.expected))
					)
						throw failure("browser_controller_changed");
					if (
						observed.controller?.controller_id === this.controllerId &&
						item.controllerId !== this.controllerId
					)
						this.returningSelection = {
							lease: observed.controller,
							version: item.selectionVersion,
						};
					this.control(
						await this.client.requestControl(
							this.resource,
							item.controllerId,
							observed.controller,
							crypto.randomUUID(),
						),
					);
					for (const resolve of item.resolve) resolve();
					continue;
				}
				const current = this.view.control;
				if (
					!current ||
					!sameLease(current.controller, item.lease) ||
					current.phase !== "ready" ||
					current.requested_controller
				)
					throw failure("browser_controller_changed");
				const result = await this.client.action(
					this.controllerId,
					{
						lease: item.lease,
						page: item.page,
						operation_id: item.operation,
						command_sequence: current.next_command_sequence,
					},
					item.action,
				);
				this.control(result.control);
				if (
					result.response.success &&
					(result.createdPage || result.replacedPage)
				) {
					const revision = BigInt(result.control.revision);
					if (revision > this.minimumObservationRevision)
						this.minimumObservationRevision = revision;
				}
				if (
					result.response.success &&
					result.replacedPage &&
					!sameBrowserPage(result.replacedPage, item.page) &&
					this.view.page &&
					sameBrowserPage(this.view.page, item.page) &&
					item.selectionVersion === this.selectionVersion
				) {
					this.publish({ ...this.view, page: undefined, frame: undefined });
				}
				if (
					result.response.success &&
					result.createdPage &&
					item.selectionVersion === this.selectionVersion
				) {
					this.selectedPage = {
						id: result.createdPage.page_id,
					};
					// A completed creation may lack its follow-up observation. Keep
					// its selection while an older in-flight refresh finishes; that
					// old frame must not accept input as the newly created page.
					this.publish({
						...this.view,
						selectedPageId: result.createdPage.page_id,
						followingCurrent: false,
						page: undefined,
						frame: undefined,
					});
				}
				if (result.observation) this.observe(result.observation);
				if (!result.response.success) throw failure("browser_action_failed");
				this.inputError = undefined;
				this.publish(this.view);
				for (const resolve of item.resolve) resolve(result.response.data);
			} catch (caught) {
				const failed = error(caught);
				this.inputError = failed;
				this.publish(this.view);
				for (const reject of item.reject) reject(failed);
				for (const pending of this.queue.splice(0))
					for (const reject of pending.reject) reject(failed);
			}
		}
	}

	/** Flush an already submitted key-down before reading held contacts. Closing
	 * a view releases only its controller's input; the browser remains running. */
	release(): Promise<void> {
		const known = this.view.control?.controller;
		if (this.disposed || !known || known.controller_id !== this.controllerId)
			return Promise.resolve();
		this.releasing ??= new Promise<void>((resolve, reject) => {
			this.queue.push({
				kind: "release",
				lease: known,
				resolve: [resolve],
				reject: [reject],
			});
			this.startDrain();
		}).finally(() => {
			this.releasing = undefined;
		});
		return this.releasing;
	}
	private async releaseHeld(known: BrowserControllerLease): Promise<void> {
		let control = await this.client.control(this.resource);
		this.control(control);
		if (
			known.controller_id !== this.controllerId ||
			!sameLease(control.controller, known)
		)
			return;
		const release = async (
			page: BrowserPageIdentity,
			action: BrowserPaneAction,
		) => {
			const lease = control.controller;
			if (!lease || !sameLease(lease, known)) return;
			const result = await this.client.action(
				this.controllerId,
				{
					lease,
					page,
					operation_id: crypto.randomUUID(),
					command_sequence: control.next_command_sequence,
				},
				action,
			);
			control = result.control;
			this.control(control);
			if (result.observation) this.observe(result.observation);
			if (!result.response.success) throw failure("browser_action_failed");
		};
		for (const key of control.keyboard?.keys ?? []) {
			if (control.keyboard)
				await release(control.keyboard.page, { kind: "key_up", key });
		}
		const contact = control.pointer;
		if (contact)
			for (const [button, mask] of [
				["left", 1],
				["right", 2],
				["middle", 4],
				["back", 8],
				["forward", 16],
			] as const) {
				if (contact.buttons & mask)
					await release(contact.page, {
						kind: "mouse",
						action: { kind: "up", button },
					});
			}
	}
	dispose(releaseInputs = true) {
		if (this.disposed) return Promise.resolve();
		const known = this.view.control?.controller;
		this.disposed = true;
		for (const item of this.queue.splice(0))
			for (const reject of item.reject) reject(failure("browser_view_closed"));
		this.listeners.clear();
		return releaseInputs && known
			? Promise.resolve(this.draining).then(() => this.releaseHeld(known))
			: Promise.resolve();
	}
}
