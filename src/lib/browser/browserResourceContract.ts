import { asRecord } from "@/lib/payloadGuards";
import type { BrowserResourceIdentity } from "../../../cli/lib/contracts/browser-workspace-target.mjs";

export type { BrowserResourceIdentity } from "../../../cli/lib/contracts/browser-workspace-target.mjs";

/** Wire projections of hmux-session-protocol/browser_resource. Counters stay
 * decimal strings so a controller epoch never loses precision in JavaScript. */
export interface BrowserPageIdentity {
	readonly resource: BrowserResourceIdentity;
	readonly page_id: string;
	readonly document_revision: string;
}

export interface BrowserControllerLease {
	readonly resource: BrowserResourceIdentity;
	readonly controller_id: string;
	readonly epoch: string;
}

export interface BrowserActionAuthority {
	readonly lease: BrowserControllerLease;
	readonly page: BrowserPageIdentity;
	readonly operation_id: string;
	readonly command_sequence: string;
}

export interface BrowserControlProjection {
	readonly resource: BrowserResourceIdentity;
	readonly revision: string;
	readonly phase: "ready" | "outcome_unknown" | "retiring" | "closed";
	readonly controller: BrowserControllerLease | null;
	readonly requested_controller: string | null;
	readonly in_flight: string | null;
	readonly next_command_sequence: string;
	readonly current_page?: BrowserPageIdentity;
	readonly pointer?: {
		readonly page: BrowserPageIdentity;
		readonly buttons: number;
	};
	readonly keyboard?: {
		readonly page: BrowserPageIdentity;
		readonly keys: readonly string[];
	};
	readonly touch?: {
		readonly page: BrowserPageIdentity;
	};
	readonly dialog_response?: string;
}

export interface BrowserObservation {
	readonly control: BrowserControlProjection;
	readonly pages: readonly {
		readonly page: BrowserPageIdentity;
		readonly url: string;
		readonly title: string;
		readonly profile_id: string | null;
	}[];
	readonly observation_error?: string;
}

export interface BrowserFrame {
	readonly page: BrowserPageIdentity;
	readonly mimeType: "image/png" | "image/jpeg";
	readonly base64: string;
	readonly viewport: {
		readonly width: number;
		readonly height: number;
		readonly pixel_ratio: number;
	};
}

export function parseBrowserFrame(value: unknown): BrowserFrame | undefined {
	const raw = asRecord(value);
	const page = parseBrowserPage(raw?.page);
	const viewport = parseBrowserViewport(raw?.viewport);
	if (
		!raw ||
		!page ||
		!viewport ||
		(raw.mimeType !== "image/png" && raw.mimeType !== "image/jpeg") ||
		typeof raw.base64 !== "string" ||
		!raw.base64
	)
		return undefined;
	return { page, mimeType: raw.mimeType, base64: raw.base64, viewport };
}

export function parseBrowserViewport(
	value: unknown,
): BrowserFrame["viewport"] | undefined {
	const viewport = asRecord(value);
	const positive = (v: unknown): v is number =>
		typeof v === "number" && Number.isFinite(v) && v > 0;
	if (
		!viewport ||
		!positive(viewport.width) ||
		!positive(viewport.height) ||
		!positive(viewport.pixel_ratio) ||
		viewport.width > 65_535 ||
		viewport.height > 65_535
	)
		return undefined;
	return {
		width: viewport.width,
		height: viewport.height,
		pixel_ratio: viewport.pixel_ratio,
	};
}

function identifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value)
	);
}

function counter(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[1-9][0-9]{0,19}$/.test(value) &&
		BigInt(value) <= 18446744073709551615n
	);
}

export function sameBrowserResource(
	a: BrowserResourceIdentity,
	b: BrowserResourceIdentity,
): boolean {
	return (
		a.resource_id === b.resource_id &&
		a.generation === b.generation &&
		a.workspace_id === b.workspace_id
	);
}

export function sameBrowserPage(
	a: BrowserPageIdentity,
	b: BrowserPageIdentity,
): boolean {
	return (
		sameBrowserResource(a.resource, b.resource) &&
		a.page_id === b.page_id &&
		a.document_revision === b.document_revision
	);
}

export function parseBrowserResource(
	value: unknown,
): BrowserResourceIdentity | undefined {
	const raw = asRecord(value);
	if (
		!raw ||
		!identifier(raw.resource_id) ||
		!identifier(raw.generation) ||
		!identifier(raw.workspace_id)
	)
		return undefined;
	return {
		resource_id: raw.resource_id,
		generation: raw.generation,
		workspace_id: raw.workspace_id,
	};
}

export function parseBrowserPage(
	value: unknown,
): BrowserPageIdentity | undefined {
	const raw = asRecord(value);
	const resource = parseBrowserResource(raw?.resource);
	if (
		!raw ||
		!resource ||
		!identifier(raw.page_id) ||
		!counter(raw.document_revision)
	)
		return undefined;
	return {
		resource,
		page_id: raw.page_id,
		document_revision: raw.document_revision,
	};
}

function parseLease(value: unknown): BrowserControllerLease | undefined {
	const raw = asRecord(value);
	const resource = parseBrowserResource(raw?.resource);
	if (
		!raw ||
		!resource ||
		!identifier(raw.controller_id) ||
		!counter(raw.epoch)
	)
		return undefined;
	return { resource, controller_id: raw.controller_id, epoch: raw.epoch };
}

export function parseBrowserControl(
	value: unknown,
): BrowserControlProjection | undefined {
	const raw = asRecord(value);
	const resource = parseBrowserResource(raw?.resource);
	if (
		!raw ||
		!resource ||
		!counter(raw.revision) ||
		!counter(raw.next_command_sequence)
	)
		return undefined;
	const phase = raw.phase;
	if (
		phase !== "ready" &&
		phase !== "outcome_unknown" &&
		phase !== "retiring" &&
		phase !== "closed"
	)
		return undefined;
	const controller =
		raw.controller === null ? null : parseLease(raw.controller);
	if (
		controller === undefined ||
		(controller && !sameBrowserResource(controller.resource, resource))
	)
		return undefined;
	if (
		raw.requested_controller !== null &&
		!identifier(raw.requested_controller)
	)
		return undefined;
	if (raw.in_flight !== null && !identifier(raw.in_flight)) return undefined;
	const currentPage =
		raw.current_page == null ? undefined : parseBrowserPage(raw.current_page);
	if (
		raw.current_page != null &&
		(!currentPage || !sameBrowserResource(currentPage.resource, resource))
	)
		return undefined;
	const result: BrowserControlProjection = {
		resource,
		revision: raw.revision,
		phase,
		controller,
		requested_controller: raw.requested_controller,
		in_flight: raw.in_flight,
		next_command_sequence: raw.next_command_sequence,
		...(currentPage ? { current_page: currentPage } : {}),
	};
	const pointer = asRecord(raw.pointer);
	const pointerPage = parseBrowserPage(pointer?.page);
	if (
		raw.pointer !== undefined &&
		(!pointer ||
			!pointerPage ||
			!sameBrowserResource(pointerPage.resource, resource) ||
			!Number.isInteger(pointer.buttons) ||
			Number(pointer.buttons) < 0 ||
			Number(pointer.buttons) > 31)
	)
		return undefined;
	const keyboard = asRecord(raw.keyboard);
	const keyboardPage = parseBrowserPage(keyboard?.page);
	const keys = keyboard?.keys;
	if (
		raw.keyboard !== undefined &&
		(!keyboard ||
			!keyboardPage ||
			!sameBrowserResource(keyboardPage.resource, resource) ||
			!Array.isArray(keys) ||
			!keys.every((key) => typeof key === "string" && key.length > 0))
	)
		return undefined;
	const touch = asRecord(raw.touch);
	const touchPage = parseBrowserPage(touch?.page);
	if (
		raw.touch !== undefined &&
		(!touch || !touchPage || !sameBrowserResource(touchPage.resource, resource))
	)
		return undefined;
	if (raw.dialog_response !== undefined && !identifier(raw.dialog_response))
		return undefined;
	return {
		...result,
		...(pointer && pointerPage
			? { pointer: { page: pointerPage, buttons: Number(pointer.buttons) } }
			: {}),
		...(keyboard && keyboardPage && Array.isArray(keys)
			? { keyboard: { page: keyboardPage, keys: keys as string[] } }
			: {}),
		...(touch && touchPage ? { touch: { page: touchPage } } : {}),
		...(identifier(raw.dialog_response)
			? { dialog_response: raw.dialog_response }
			: {}),
	};
}

export function parseBrowserObservation(
	value: unknown,
): BrowserObservation | undefined {
	const raw = asRecord(value);
	const control = parseBrowserControl(raw?.control);
	if (!raw || !control || !Array.isArray(raw.pages) || raw.pages.length > 128)
		return undefined;
	const pages: BrowserObservation["pages"][number][] = [];
	for (const value of raw.pages) {
		const row = asRecord(value);
		const page = parseBrowserPage(row?.page);
		if (
			!row ||
			!page ||
			!sameBrowserResource(page.resource, control.resource) ||
			typeof row.url !== "string" ||
			typeof row.title !== "string" ||
			(row.profile_id !== null && !identifier(row.profile_id))
		)
			return undefined;
		if (pages.some((existing) => existing.page.page_id === page.page_id))
			return undefined;
		pages.push({
			page,
			url: row.url,
			title: row.title,
			profile_id: row.profile_id,
		});
	}
	if (raw.observation_error !== undefined && !identifier(raw.observation_error))
		return undefined;
	return {
		control,
		pages,
		...(identifier(raw.observation_error)
			? { observation_error: raw.observation_error }
			: {}),
	};
}
