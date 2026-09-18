import {
	downloadBrowserImage,
	parseBrowserImageArtifact,
} from "@/lib/browser/browserArtifact";
import {
	type BrowserProfileRecord,
	isBrowserProfileLabel,
	parseBrowserProfile,
	parseBrowserProfiles,
} from "@/lib/browser/browserProfileContract";
import {
	type BrowserActionAuthority,
	type BrowserControllerLease,
	type BrowserPageIdentity,
	type BrowserResourceIdentity,
	parseBrowserControl,
	parseBrowserFrame,
	parseBrowserObservation,
	parseBrowserPage,
	parseBrowserResource,
	parseBrowserViewport,
	sameBrowserPage,
	sameBrowserResource,
} from "@/lib/browser/browserResourceContract";
import { t } from "@/lib/i18n";
import {
	createDureBackendRequester,
	type DureBackendInvoke,
	DureBackendRequestError,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { isDureDomainIdV1 } from "@/lib/ipc/dureProtocolIdentity";
import { asRecord } from "@/lib/payloadGuards";
import {
	browserWorkspaceSelectionResult,
	parseBrowserWorkspaceCatalogTarget,
} from "../../../cli/lib/contracts/browser-workspace-target.mjs";

export function browserRequestFailureMessage(error: unknown): string {
	if (
		error instanceof Error &&
		error.message === "browser_saved_resource_missing"
	)
		return t("ipc.browser.unavailable");
	if (error instanceof DureBackendRequestError) {
		switch (error.code) {
			case "backend_transport_authority_changed":
			case "browser_backend_changed":
				return t("ipc.browser.connectionChanged");
			case "browser_resource_unavailable":
				return t("ipc.browser.unavailable");
			case "browser_desktop_response_invalid":
				return t("ipc.browser.invalidResponse");
			case "browser_pro_development_only":
				return t("ipc.browser.developmentRequired");
			case "browser_engine_not_installed":
			case "browser_chromium_not_installed":
				return t("ipc.browser.runtimeRequired");
			case "browser_engine_platform_unavailable":
				return t("ipc.browser.platformUnavailable");
		}
		if (error.code.startsWith("browser_installation_"))
			return t("ipc.browser.installationFailed");
	}
	return t("ipc.browser.requestFailed");
}

const runtimeConfigurationFailures = new Set([
	"browser_engine_not_installed",
	"browser_chromium_not_installed",
	"browser_installation_invalid",
	"browser_engine_unreadable",
	"browser_engine_pin_mismatch",
	"browser_engine_installation_invalid",
]);

export function canInstallBrowserRuntime(error: unknown): boolean {
	return (
		error instanceof DureBackendRequestError &&
		(runtimeConfigurationFailures.has(error.code) ||
			error.code.startsWith("browser_installation_"))
	);
}

/** These Create failures precede service resource admission. Other terminal
 * errors may leave a resource behind and cannot discard its pending operation. */
export function isUnstartedBrowserCreation(error: unknown): boolean {
	return (
		error instanceof DureBackendRequestError &&
		error.failure.kind === "operation" &&
		error.failure.disposition === "terminal" &&
		(runtimeConfigurationFailures.has(error.code) ||
			error.code === "browser_engine_platform_unavailable" ||
			error.code === "browser_pro_development_only")
	);
}

export type BrowserPaneAction =
	| { readonly kind: "evaluate"; readonly script: string }
	| {
			readonly kind: "profile_set" | "profile_clone";
			readonly profile_id: string;
	  }
	| {
			readonly kind: "environment";
			readonly action: {
				readonly kind: "viewport";
				readonly width: number;
				readonly height: number;
				readonly scale: number;
				readonly mobile: boolean;
			};
	  }
	| { readonly kind: "navigate" | "new_page"; readonly url: string }
	| {
			readonly kind:
				| "back"
				| "forward"
				| "reload"
				| "select_page"
				| "close_page";
	  }
	| { readonly kind: "insert_text"; readonly text: string }
	| { readonly kind: "press" | "key_down" | "key_up"; readonly key: string }
	| {
			readonly kind: "mouse";
			readonly action:
				| { readonly kind: "move"; readonly x: number; readonly y: number }
				| {
						readonly kind: "down" | "up";
						readonly button: "left" | "middle" | "right" | "back" | "forward";
						readonly x?: number;
						readonly y?: number;
				  }
				| {
						readonly kind: "wheel";
						readonly x?: number;
						readonly y?: number;
						readonly delta_x: number;
						readonly delta_y: number;
				  };
	  };

function invalid(): never {
	throw new DureBackendRequestError(
		"browser_desktop_response_invalid",
		t("ipc.browser.invalidResponse"),
		{ kind: "contract" },
	);
}

/** One exact backend route for the lifetime of an attached browser resource.
 * The Host owns controller changes and action admission. This client never
 * acquires a lease, retries input, or substitutes a newer page implicitly. */
export function createDureBrowserClient(
	authority: DureBackendRouteAuthorityV1,
	invokeCommand?: DureBackendInvoke,
) {
	const request = createDureBackendRequester({
		invokeCommand,
		invalidResponseCode: "browser_desktop_response_invalid",
		invalidResponseMessage: "ipc.browser.invalidResponse",
		backendChangedCode: "browser_backend_changed",
		backendChangedMessage: "ipc.browser.connectionChanged",
		requestFailedCode: "browser_request_failed",
		requestFailedMessage: "ipc.browser.requestFailed",
	});
	async function send(body: Record<string, unknown>) {
		const { result } = await request("browser.resource", body, {
			kind: "exact",
			authority,
		});
		const operationId =
			body.operation_id ?? asRecord(body.authority)?.operation_id;
		const missingReceipt =
			body.kind === "receipt" &&
			result.receipt === null &&
			result.result_available === false &&
			result.result === null &&
			result.operation_id === undefined;
		if (
			operationId !== undefined &&
			body.kind !== "artifact" &&
			result.operation_id !== operationId &&
			!missingReceipt
		)
			invalid();
		return result;
	}
	async function payload(body: Record<string, unknown>) {
		const reply = await send(body);
		const result = asRecord(reply.result);
		if (!result) invalid();
		return result;
	}
	function control(value: unknown, resource: BrowserResourceIdentity) {
		const parsed = parseBrowserControl(value);
		if (!parsed || !sameBrowserResource(parsed.resource, resource)) invalid();
		return parsed;
	}
	function createdBrowser(reply: Record<string, unknown>, operationId: string) {
		if (reply.replayed === true && reply.result === null) {
			const receipt = asRecord(reply.receipt);
			const failure = asRecord(reply.error);
			if (
				reply.result_available !== true ||
				receipt?.operationId !== operationId ||
				receipt.operationKind !== "browser.resource" ||
				receipt.state !== "failed" ||
				typeof failure?.code !== "string" ||
				!failure.code ||
				receipt.terminalCode !== failure.code
			)
				invalid();
			throw new DureBackendRequestError(
				failure.code,
				t("ipc.browser.requestFailed"),
				{ kind: "operation", disposition: "terminal" },
			);
		}
		const result = asRecord(reply.result);
		if (!result) invalid();
		const created = parseBrowserControl(result.control);
		if (!created) invalid();
		return created;
	}
	return {
		async runtimeInstallation(start = false) {
			const result = await payload({
				kind: start ? "runtime_install" : "runtime_status",
			});
			const state = result.state;
			if (
				state !== "ready" &&
				state !== "missing" &&
				state !== "installing" &&
				state !== "failed" &&
				state !== "unsupported"
			)
				invalid();
			if (state === "failed" || state === "unsupported") {
				throw new DureBackendRequestError(
					state === "unsupported"
						? "browser_engine_platform_unavailable"
						: "browser_installation_failed",
					t("ipc.browser.requestFailed"),
					{ kind: "operation", disposition: "terminal" },
				);
			}
			return state;
		},
		async createProfile(
			label: string,
			userAgentMode: BrowserProfileRecord["profile"]["userAgentMode"],
			operationId: string,
		) {
			if (
				!isBrowserProfileLabel(label) ||
				!isDureDomainIdV1(operationId) ||
				(userAgentMode !== "native" && userAgentMode !== "clean")
			)
				invalid();
			const result = parseBrowserProfile(
				(
					await payload({
						kind: "profile_create",
						operation_id: operationId,
						label,
						scope: "isolated",
						user_agent_mode: userAgentMode,
					})
				).profile,
			);
			if (
				result?.state !== "active" ||
				result.profile.scope !== "isolated" ||
				result.profile.label !== label ||
				result.profile.userAgentMode !== userAgentMode
			)
				invalid();
			return result;
		},
		async deleteProfile(profileId: string, operationId: string) {
			if (
				!isDureDomainIdV1(profileId) ||
				profileId === "default" ||
				!isDureDomainIdV1(operationId)
			)
				invalid();
			const result = await payload({
				kind: "profile_delete",
				profile_id: profileId,
				operation_id: operationId,
			});
			if (
				result.profile_id !== profileId ||
				typeof result.deleted !== "boolean"
			)
				invalid();
			return result.deleted;
		},
		async profiles() {
			const result = parseBrowserProfiles(
				await payload({ kind: "profile_list" }),
			);
			if (!result) invalid();
			return result;
		},
		async create(operationId: string) {
			const reply = await send({
				kind: "create",
				operation_id: operationId,
			});
			return createdBrowser(reply, operationId);
		},
		async recoverCreation(operationId: string) {
			const reply = await send({ kind: "receipt", operation_id: operationId });
			const receipt = asRecord(reply.receipt);
			if (
				reply.result_available !== true ||
				receipt?.operationId !== operationId ||
				receipt.operationKind !== "browser.resource" ||
				!["succeeded", "failed"].includes(String(receipt.state))
			)
				invalid();
			return createdBrowser({ ...reply, replayed: true }, operationId);
		},
		async close(resource: BrowserResourceIdentity, operationId: string) {
			const result = await payload({
				kind: "close",
				resource,
				operation_id: operationId,
			});
			const closed = parseBrowserResource(result.resource);
			if (
				result.closed !== true ||
				!closed ||
				!sameBrowserResource(closed, resource)
			)
				invalid();
			return result;
		},
		async list() {
			const result = await payload({ kind: "list" });
			if (!Array.isArray(result.resources)) invalid();
			if ("target" in result && !parseBrowserWorkspaceCatalogTarget(result))
				invalid();
			return result.resources.map((value) => {
				const parsed = parseBrowserControl(value);
				if (!parsed || parsed.resource.workspace_id !== result.workspace_id)
					invalid();
				return parsed;
			});
		},
		async selectResource(
			resource: BrowserResourceIdentity,
			operationId: string,
		) {
			if (!parseBrowserResource(resource) || !isDureDomainIdV1(operationId))
				invalid();
			const catalog = await payload({
				kind: "list",
			});
			const expected = parseBrowserWorkspaceCatalogTarget(catalog);
			if (
				!expected ||
				!Array.isArray(catalog.resources) ||
				!catalog.resources.some((row) => {
					const parsed = parseBrowserResource(asRecord(row)?.resource);
					return parsed && sameBrowserResource(parsed, resource);
				})
			)
				invalid();
			const result = await payload({
				kind: "select_resource",
				resource,
				expected,
				operation_id: operationId,
			});
			const selected = browserWorkspaceSelectionResult(
				expected,
				resource,
				result.target,
			);
			if (!selected) invalid();
			return selected;
		},
		async observe(resource: BrowserResourceIdentity) {
			const result = parseBrowserObservation(
				await payload({ kind: "observe", resource_id: resource.resource_id }),
			);
			if (!result || !sameBrowserResource(result.control.resource, resource))
				invalid();
			return result;
		},
		async control(resource: BrowserResourceIdentity) {
			return control(
				await payload({
					kind: "control_state",
					resource_id: resource.resource_id,
				}),
				resource,
			);
		},
		async requestControl(
			resource: BrowserResourceIdentity,
			controllerId: string,
			expected: BrowserControllerLease | null,
			operationId: string,
		) {
			return control(
				await payload({
					kind: "control",
					resource,
					controller_id: controllerId,
					expected,
					operation_id: operationId,
				}),
				resource,
			);
		},
		async screenshot(page: BrowserPageIdentity) {
			const captured = parseBrowserFrame(
				await payload({ kind: "screenshot", page }),
			);
			if (
				captured?.mimeType !== "image/png" ||
				!sameBrowserPage(captured.page, page)
			)
				invalid();
			return captured;
		},

		async capture(
			page: BrowserPageIdentity,
			operationId: string,
			signal?: AbortSignal,
		) {
			signal?.throwIfAborted();
			const result = await payload({
				kind: "capture",
				page,
				options: { full_page: false, format: "png" },
				operation_id: operationId,
			});
			const artifact = parseBrowserImageArtifact(result.artifact);
			const viewport = parseBrowserViewport(result.viewport);
			if (!artifact || !viewport || !sameBrowserPage(artifact.page, page))
				invalid();
			const base64 = await downloadBrowserImage(
				(offset) =>
					send({ kind: "artifact", operation_id: operationId, offset }),
				artifact,
				signal,
			);
			return {
				page: artifact.page,
				mimeType: artifact.mimeType,
				base64,
				viewport,
			};
		},

		async frame(page: BrowserPageIdentity) {
			const frame = parseBrowserFrame(await payload({ kind: "frame", page }));
			if (!frame || !sameBrowserPage(frame.page, page)) invalid();
			return frame;
		},
		async action(
			caller: string,
			actionAuthority: BrowserActionAuthority,
			action: BrowserPaneAction,
		) {
			// The caller supplies the lease it actually observed. A pending
			// handoff may still need a key-up; only the Host decides admission.
			const profileChange =
				action.kind === "profile_set" || action.kind === "profile_clone";
			if (profileChange && !isDureDomainIdV1(action.profile_id)) invalid();
			const result = await payload({
				kind: profileChange ? action.kind : "action",
				caller,
				authority: actionAuthority,
				...(profileChange ? { profile_id: action.profile_id } : { action }),
			});
			const response = asRecord(result.response);
			if (!response || typeof response.success !== "boolean") invalid();
			const projection = control(result.control, actionAuthority.page.resource);
			const observation =
				result.observation === null
					? null
					: parseBrowserObservation(result.observation);
			if (
				observation === undefined ||
				(observation &&
					!sameBrowserResource(
						observation.control.resource,
						actionAuthority.page.resource,
					))
			)
				invalid();
			let createdPage: BrowserPageIdentity | undefined;
			let replacedPage: BrowserPageIdentity | undefined;
			if (profileChange && response.success) {
				const data = asRecord(response.data);
				const changed = parseBrowserPage(data?.page);
				if (
					!changed ||
					data?.profile_id !== action.profile_id ||
					!sameBrowserResource(changed.resource, actionAuthority.page.resource)
				)
					invalid();
				if (action.kind === "profile_set") {
					if (
						changed.page_id !== actionAuthority.page.page_id ||
						BigInt(changed.document_revision) <
							BigInt(actionAuthority.page.document_revision)
					)
						invalid();
					replacedPage = changed;
				} else {
					const sourcePage = parseBrowserPage(data?.source_page);
					if (!sourcePage || !sameBrowserPage(sourcePage, actionAuthority.page))
						invalid();
				}
			}
			if (
				(action.kind === "new_page" || action.kind === "profile_clone") &&
				response.success
			) {
				createdPage = parseBrowserPage(asRecord(response.data)?.page);
				if (
					!createdPage ||
					!sameBrowserResource(
						createdPage.resource,
						actionAuthority.page.resource,
					) ||
					createdPage.page_id === actionAuthority.page.page_id
				)
					invalid();
			}
			return {
				response,
				control: projection,
				observation,
				...(createdPage ? { createdPage } : {}),
				...(replacedPage ? { replacedPage } : {}),
			};
		},
		async receipt(operationId: string) {
			return send({ kind: "receipt", operation_id: operationId });
		},
	};
}
