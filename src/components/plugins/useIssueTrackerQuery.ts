import { useCallback, useEffect, useRef, useState } from "react";
import type { IssueTrackerQueryResultV1 } from "@/contracts/generated/extensionContracts";
import { dureIssueTrackerQuery } from "@/lib/ipc";
import type { DureIssueTrackerQueryRequest } from "@/lib/ipc/plugins";

interface QuerySnapshot<T> {
	request: DureIssueTrackerQueryRequest | null;
	data: T | null;
	loading: boolean;
	error: unknown;
}

/** Owns the lifetime of one read. Callers supply a memoized admitted request or null;
 * a watcher snapshot replaces the pending read instead of competing with it. */
export function useIssueTrackerQuery<T>(
	request: DureIssueTrackerQueryRequest | null,
	select: (result: IssueTrackerQueryResultV1) => T,
	{ keepDataOnRefresh = false } = {},
) {
	const [revision, setRevision] = useState(0);
	const [snapshot, setSnapshot] = useState<QuerySnapshot<T>>({
		request: null,
		data: null,
		loading: false,
		error: null,
	});
	const pending = useRef<symbol | null>(null);
	const refresh = useCallback(() => {
		pending.current = null;
		setRevision((current) => current + 1);
	}, []);
	const replace = useCallback(
		(data: T) => {
			pending.current = null;
			setSnapshot({ request, data, loading: false, error: null });
		},
		[request],
	);

	useEffect(() => {
		const token = Symbol();
		pending.current = token;
		setSnapshot((previous) => ({
			request,
			data:
				keepDataOnRefresh && previous.request === request
					? previous.data
					: null,
			loading: request !== null,
			error: null,
		}));
		if (request) {
			void dureIssueTrackerQuery(request)
				.then(select)
				.then((data) => {
					if (pending.current !== token) return;
					setSnapshot({ request, data, loading: false, error: null });
				})
				.catch((error: unknown) => {
					if (pending.current !== token) return;
					setSnapshot((previous) => ({
						request,
						data: keepDataOnRefresh ? previous.data : null,
						loading: false,
						error,
					}));
				});
		}
		return () => {
			if (pending.current === token) pending.current = null;
		};
	}, [keepDataOnRefresh, request, revision, select]);

	// A replacement workspace must not render the previous request's result
	// during the render before effect cleanup runs.
	const current = snapshot.request === request;
	return {
		data: current ? snapshot.data : null,
		loading: current ? snapshot.loading : request !== null,
		error: current ? snapshot.error : null,
		refresh,
		replace,
	};
}
