import { useCallback, useEffect, useRef, useState } from "react";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { scheduleErrorMessage } from "@/lib/automations/scheduleContract";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { createGraphClient, type GraphSnapshot } from "@/lib/ipc/dureGraph";
import {
	createScheduleClient,
	type ScheduleSnapshot,
} from "@/lib/ipc/dureSchedule";

type AutomationCatalog = { snapshot: ScheduleSnapshot } & (
	| { graphs: GraphSnapshot; graphError?: never }
	| { graphs?: never; graphError: string }
);

export function useAutomations() {
	const [client] = useState(() => createScheduleClient());
	const [graphClient] = useState(() => createGraphClient());
	const [catalog, setCatalog] = useState<AutomationCatalog>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();
	const [revision, refresh] = useState(0);
	const pro = useInterfaceMode() === "pro";
	useEffect(() => {
		let current = true;
		setLoading(true);
		setError(undefined);
		void client
			.list()
			.then(async (value) => {
				if (!current) return;
				try {
					const graphSnapshot = await graphClient.list(value.authority);
					if (current) setCatalog({ snapshot: value, graphs: graphSnapshot });
				} catch (reason) {
					if (current) {
						setCatalog({
							snapshot: value,
							graphError: scheduleErrorMessage(reason),
						});
					}
				}
			})
			.catch((reason: unknown) => {
				if (current) setError(scheduleErrorMessage(reason));
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [client, graphClient, revision]);
	return {
		client,
		graphClient,
		graphs: catalog?.graphs,
		graphError: catalog?.graphError,
		snapshot: catalog?.snapshot,
		loading,
		error,
		pro,
		refresh: () => refresh((value) => value + 1),
	};
}

/** The request closure retains its exact payload, revision, and route on an
 * uncertain response. Retrying cannot silently create a second manual run. */
export function useAutomationAction(errorMessage = scheduleErrorMessage) {
	const attempt = useRef<(() => Promise<void>) | undefined>(undefined);
	const inFlight = useRef(false);
	const [busy, setBusy] = useState(false);
	const [retryable, setRetryable] = useState(false);
	const [error, setError] = useState<string>();
	const perform = useCallback(
		async (operation?: () => Promise<void>) => {
			if (inFlight.current) return;
			if (!attempt.current) attempt.current = operation;
			if (!attempt.current) return;
			inFlight.current = true;
			setBusy(true);
			setError(undefined);
			try {
				await attempt.current();
				attempt.current = undefined;
				setRetryable(false);
			} catch (reason) {
				const rejected =
					reason instanceof DureBackendRequestError &&
					(reason.failure.kind === "authority_changed" ||
						(reason.failure.kind === "operation" &&
							reason.failure.disposition === "terminal") ||
						[
							"schedule_request_invalid",
							"schedule_expression_invalid",
							"schedule_timezone_invalid",
							"schedule_project_not_found",
							"schedule_not_found",
							"schedule_revision_conflict",
							"schedule_identity_conflict",
							"schedule_idempotency_conflict",
						].includes(reason.code));
				if (rejected) attempt.current = undefined;
				setRetryable(!rejected);
				setError(errorMessage(reason));
			} finally {
				inFlight.current = false;
				setBusy(false);
			}
		},
		[errorMessage],
	);
	return { busy, retryable, error, perform };
}
