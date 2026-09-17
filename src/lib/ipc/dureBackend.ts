import { invoke } from "@tauri-apps/api/core";
import { t } from "@/lib/i18n";
import {
	type DureBackendRouteAuthorityV1,
	exactDureBackendRoute,
	parseDureBackendRouteAuthority,
	sameDureBackendRouteAuthority,
	selectedDureBackendRoute,
} from "@/lib/ipc/dureBackendRoute";
import { asRecord as record } from "@/lib/payloadGuards";

export type DureBackendInvoke = (
	command: string,
	arguments_: Record<string, unknown>,
) => Promise<unknown>;

export interface DureBackendIdentity {
	id: string;
	generation: string;
}

export interface DureBackendResponse {
	backend: DureBackendIdentity;
	routeAuthority: DureBackendRouteAuthorityV1;
	result: Record<string, unknown>;
}

export type DureBackendRequestRouteV1 =
	| {
			readonly kind: "exact";
			readonly authority: DureBackendRouteAuthorityV1;
	  }
	| { readonly kind: "complete_selected_snapshot" };

interface DureBackendAuthorityObservation {
	readonly observationRevision: number;
}

/** One client-owned ordering fence for selected-route responses. Exact effects
 * are fenced directly by their route authority. */
export class DureBackendAuthorityFence {
	private observedRoute: DureBackendRouteAuthorityV1 | undefined;
	private observationRevision = 0;
	private acceptedObservationRevision = 0;

	begin(): DureBackendAuthorityObservation {
		return {
			observationRevision: ++this.observationRevision,
		};
	}

	currentRouteAuthority(): DureBackendRouteAuthorityV1 | undefined {
		return this.observedRoute;
	}

	accept(
		request: DureBackendAuthorityObservation,
		routeAuthority: DureBackendRouteAuthorityV1,
		observation: "strict_effect" | "complete_snapshot" = "strict_effect",
	): boolean {
		if (request.observationRevision < this.acceptedObservationRevision) {
			return false;
		}
		if (
			this.observedRoute &&
			!sameDureBackendRouteAuthority(this.observedRoute, routeAuthority)
		) {
			if (observation === "strict_effect") return false;
		}
		this.observedRoute = routeAuthority;
		this.acceptedObservationRevision = request.observationRevision;
		return true;
	}
}

export function parseDureBackendEnvelope(
	raw: unknown,
): DureBackendResponse | undefined {
	const envelope = record(raw);
	const result = record(envelope?.result);
	const routeAuthority = parseDureBackendRouteAuthority(
		envelope?.routeAuthority,
	);
	if (
		envelope?.schemaVersion !== 1 ||
		!token(envelope.backendId) ||
		!token(envelope.backendGeneration) ||
		!routeAuthority ||
		routeAuthority.backend.id !== envelope.backendId ||
		routeAuthority.backend.generation !== envelope.backendGeneration ||
		result?.schemaVersion !== 1
	) {
		return undefined;
	}
	return {
		backend: {
			id: envelope.backendId,
			generation: envelope.backendGeneration,
		},
		routeAuthority,
		result,
	};
}

type DureOperationDispositionV1 =
	| "unassigned"
	| "stale_generation"
	| "retry_same"
	| "terminal";

export type DureRequestFailureV1 =
	| {
			kind: "operation";
			disposition: DureOperationDispositionV1;
	  }
	| { kind: "transport" }
	| { kind: "contract" }
	| { kind: "authority_changed" };

export class DureBackendRequestError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly failure: DureRequestFailureV1,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "DureBackendRequestError";
	}
}

function token(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 512) {
		return false;
	}
	return !Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
}

function operationDisposition(
	value: unknown,
): DureOperationDispositionV1 | undefined {
	return value === "unassigned" ||
		value === "stale_generation" ||
		value === "retry_same" ||
		value === "terminal"
		? value
		: undefined;
}

export function dureBackendInvokeFailure(
	error: unknown,
	fallbackCode: string,
	fallbackMessage: string,
): DureBackendRequestError {
	if (error instanceof DureBackendRequestError) return error;
	const candidate = record(error);
	const details = record(candidate?.details);
	const disposition = operationDisposition(details?.disposition);
	const candidateCode = candidate?.code;
	const backendCode = token(candidateCode) ? candidateCode : undefined;
	const code = backendCode ?? fallbackCode;
	const message =
		typeof candidate?.message === "string" && candidate.message
			? candidate.message
			: t(fallbackMessage);
	const failure: DureRequestFailureV1 = disposition
		? { kind: "operation", disposition }
		: backendCode === "backend_transport_authority_changed"
			? { kind: "authority_changed" }
			: backendCode && !backendCode.startsWith("backend_transport_")
				? { kind: "operation", disposition: "retry_same" }
				: { kind: "transport" };
	return new DureBackendRequestError(code, message, failure, details);
}

/** Shared generation-fenced IPC carrier. Domain clients still own parsing and
 * retry policy; this boundary validates the one backend envelope exactly once. */
export function createDureBackendRequester({
	profileId,
	invokeCommand = (command, arguments_) => invoke(command, arguments_),
	invalidResponseCode,
	invalidResponseMessage,
	backendChangedCode,
	backendChangedMessage,
	requestFailedCode,
	requestFailedMessage,
	authority,
}: {
	profileId?: string;
	invokeCommand?: DureBackendInvoke;
	invalidResponseCode: string;
	invalidResponseMessage: string;
	backendChangedCode: string;
	backendChangedMessage: string;
	requestFailedCode: string;
	requestFailedMessage: string;
	authority?: DureBackendAuthorityFence;
}) {
	const backendAuthority = authority ?? new DureBackendAuthorityFence();

	return async (
		operation: string,
		body: Record<string, unknown>,
		request?: DureBackendRequestRouteV1,
	): Promise<DureBackendResponse> => {
		// An exact route is already the operation's sole authority. The selected
		// snapshot fence only orders unresolved selected-route observations; it
		// must not reinterpret or reject an explicit lease after the effect.
		const requestEpoch =
			request?.kind === "exact" ? undefined : backendAuthority.begin();
		let raw: unknown;
		try {
			raw = await invokeCommand("dure_backend_request", {
				route: request
					? request.kind === "exact"
						? exactDureBackendRoute(request.authority)
						: selectedDureBackendRoute(profileId)
					: selectedDureBackendRoute(profileId),
				operation,
				body,
			});
		} catch (error) {
			throw dureBackendInvokeFailure(
				error,
				requestFailedCode,
				requestFailedMessage,
			);
		}
		const response = parseDureBackendEnvelope(raw);
		if (!response) {
			// Messages are re-resolved through t() at throw time: a requester
			// created at module scope receives its option strings before the app
			// language is set, and t() on already-translated text is a no-op.
			throw new DureBackendRequestError(
				invalidResponseCode,
				t(invalidResponseMessage),
				{ kind: "contract" },
			);
		}
		const { backend, routeAuthority, result } = response;
		if (
			request?.kind === "exact" &&
			!sameDureBackendRouteAuthority(request.authority, routeAuthority)
		) {
			throw new DureBackendRequestError(
				backendChangedCode,
				t(backendChangedMessage),
				{ kind: "authority_changed" },
			);
		}
		if (
			requestEpoch &&
			!backendAuthority.accept(
				requestEpoch,
				routeAuthority,
				request?.kind === "complete_selected_snapshot"
					? "complete_snapshot"
					: "strict_effect",
			)
		) {
			throw new DureBackendRequestError(
				backendChangedCode,
				t(backendChangedMessage),
				{ kind: "authority_changed" },
			);
		}
		return { backend, routeAuthority, result };
	};
}

/** Resolves the currently selected profile to one exact route without opening
 * a backend request connection. Callers retain the returned authority across
 * every effect in one logical operation. */
export async function resolveSelectedDureBackendRouteAuthority(
	profileId: string | undefined,
	invokeCommand: DureBackendInvoke = (command, arguments_) =>
		invoke(command, arguments_),
): Promise<DureBackendRouteAuthorityV1> {
	let raw: unknown;
	try {
		raw = await invokeCommand("dure_backend_route_assert", {
			route: selectedDureBackendRoute(profileId),
		});
	} catch (error) {
		throw dureBackendInvokeFailure(
			error,
			"backend_transport_authority_changed",
			"ipc.dureBackend.generationChanged",
		);
	}
	const observed = parseDureBackendRouteAuthority(raw);
	if (
		!observed ||
		(profileId !== undefined && observed.profileId !== profileId)
	) {
		throw new DureBackendRequestError(
			"backend_transport_authority_changed",
			t("ipc.dureBackend.generationChanged"),
			{ kind: "authority_changed" },
		);
	}
	return observed;
}

/** Rechecks an already observed route without opening a backend connection.
 * Remote callers use this immediately before SSH preflight and then pass the
 * same authority to credential registration and runtime mutation. */
export async function assertDureBackendRouteAuthority(
	authority: DureBackendRouteAuthorityV1,
	invokeCommand: DureBackendInvoke = (command, arguments_) =>
		invoke(command, arguments_),
): Promise<DureBackendRouteAuthorityV1> {
	let raw: unknown;
	try {
		raw = await invokeCommand("dure_backend_route_assert", {
			route: exactDureBackendRoute(authority),
		});
	} catch (error) {
		throw dureBackendInvokeFailure(
			error,
			"backend_transport_authority_changed",
			"ipc.dureBackend.generationChanged",
		);
	}
	const observed = parseDureBackendRouteAuthority(raw);
	if (!observed || !sameDureBackendRouteAuthority(observed, authority)) {
		throw new DureBackendRequestError(
			"backend_transport_authority_changed",
			t("ipc.dureBackend.generationChanged"),
			{ kind: "authority_changed" },
		);
	}
	return observed;
}

/** Connect the selected backend before native Browser QA starts observing it. */
export const probeSelectedDureBackend = () =>
	invoke("dure_backend_request", {
		route: selectedDureBackendRoute(),
		operation: "projects.list",
		body: { schemaVersion: 1, maxItems: 1 },
	});
