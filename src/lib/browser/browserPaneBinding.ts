import {
	type BrowserResourceIdentity,
	parseBrowserResource,
	sameBrowserResource,
} from "@/lib/browser/browserResourceContract";
import {
	type DureBackendRouteAuthorityV1,
	parseDureBackendRouteAuthority,
	sameDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackendRoute";
import { isDureDomainIdV1 } from "@/lib/ipc/dureProtocolIdentity";
import { asRecord } from "@/lib/payloadGuards";

/** Mounted content declares its purpose; saved-layout ingress handles legacy IDs. */
export function readBrowserPanePurpose(pane: {
	component?: string;
	params: Record<string, unknown>;
}): "workspace" | "resource" | undefined {
	if (pane.component !== "browser") return;
	const purpose = pane.params.browserPurpose;
	return purpose === "workspace" || purpose === "resource"
		? purpose
		: undefined;
}

export interface BrowserPaneBinding {
	readonly authority: DureBackendRouteAuthorityV1;
	readonly workspaceId: string;
	readonly resource?: BrowserResourceIdentity;
	/** Last presented page; follow mode resolves its next target from Host. */
	readonly pageId?: string;
	readonly followCurrent?: boolean;
}
export interface BrowserPaneCreation {
	readonly authority: DureBackendRouteAuthorityV1;
	/** New creates use null. Older scoped operations are recovered by receipt only. */
	readonly workspaceId: string | null;
	readonly operationId: string;
}

export function sameBrowserPaneBinding(
	left: BrowserPaneBinding | undefined,
	right: BrowserPaneBinding | undefined,
): boolean {
	if (left === right) return true;
	return (
		!!left &&
		!!right &&
		sameDureBackendRouteAuthority(left.authority, right.authority) &&
		left.workspaceId === right.workspaceId &&
		left.pageId === right.pageId &&
		left.followCurrent === right.followCurrent &&
		(left.resource === right.resource ||
			(!!left.resource &&
				!!right.resource &&
				sameBrowserResource(left.resource, right.resource)))
	);
}

export function sameBrowserPaneCreation(
	left: BrowserPaneCreation | undefined,
	right: BrowserPaneCreation | undefined,
): boolean {
	if (left === right) return true;
	return (
		!!left &&
		!!right &&
		left.workspaceId === right.workspaceId &&
		left.operationId === right.operationId &&
		sameDureBackendRouteAuthority(left.authority, right.authority)
	);
}

/** Parse persisted presentation state once. A pending mutation retains its
 * exact route and operation; malformed state cannot become a fresh create. */
export function readBrowserPaneBinding(params: {
	browserBinding?: unknown;
	browserCreation?: unknown;
}): {
	binding?: BrowserPaneBinding;
	creation?: BrowserPaneCreation;
	error?: unknown;
} {
	try {
		let binding: BrowserPaneBinding | undefined;
		let creation: BrowserPaneCreation | undefined;
		if (params.browserBinding != null) {
			const raw = asRecord(params.browserBinding);
			const authority = parseDureBackendRouteAuthority(raw?.authority);
			const resource = parseBrowserResource(raw?.resource);
			const workspaceId = raw?.workspaceId ?? resource?.workspace_id;
			if (
				!raw ||
				!authority ||
				!isDureDomainIdV1(workspaceId) ||
				(raw.resource !== undefined && !resource) ||
				(resource && resource.workspace_id !== workspaceId) ||
				(raw.pageId !== undefined && !isDureDomainIdV1(raw.pageId)) ||
				(raw.followCurrent !== undefined &&
					typeof raw.followCurrent !== "boolean")
			)
				throw new Error("browser_saved_binding_invalid");
			binding = {
				authority,
				workspaceId,
				resource,
				pageId: raw.pageId as string | undefined,
				...(raw.followCurrent === undefined
					? {}
					: { followCurrent: raw.followCurrent as boolean }),
			};
		}
		if (params.browserCreation != null) {
			const raw = asRecord(params.browserCreation);
			const authority = parseDureBackendRouteAuthority(raw?.authority);
			if (
				!raw ||
				!authority ||
				(raw.workspaceId !== null && !isDureDomainIdV1(raw.workspaceId)) ||
				!isDureDomainIdV1(raw.operationId)
			)
				throw new Error("browser_saved_creation_invalid");
			creation = {
				authority,
				workspaceId: raw.workspaceId,
				operationId: raw.operationId,
			};
		}
		return { binding, creation };
	} catch (error) {
		return { error };
	}
}
