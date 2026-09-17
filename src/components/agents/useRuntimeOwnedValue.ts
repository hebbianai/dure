import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

interface RuntimeOwnerToken {
	key: string;
}

interface RuntimeOwnedValue<T> {
	owner: RuntimeOwnerToken;
	value?: T;
}

/** Keeps pane-local presentation state with the exact runtime projection that
 * produced it. An owner occurrence gets a fresh token, so a late callback from
 * a replaced runtime cannot write into a later runtime even if a key is reused. */
export function useRuntimeOwnedValue<T>(ownerKey: string) {
	const owner = useMemo<RuntimeOwnerToken>(
		() => ({ key: ownerKey }),
		[ownerKey],
	);
	const currentOwner = useRef(owner);
	const [owned, setOwned] = useState<RuntimeOwnedValue<T>>({ owner });

	useLayoutEffect(() => {
		currentOwner.current = owner;
	}, [owner]);

	const setValue = useCallback(
		(value: T | undefined) => {
			if (currentOwner.current !== owner) return;
			setOwned({ owner, value });
		},
		[owner],
	);

	return [owned.owner === owner ? owned.value : undefined, setValue] as const;
}

/** Starts a latest-wins request owned by one runtime projection. The returned
 * predicate stays true only while both the runtime and request are current. */
export function useRuntimeOwnedRequest(ownerKey: string) {
	const owner = useMemo<RuntimeOwnerToken>(
		() => ({ key: ownerKey }),
		[ownerKey],
	);
	const currentOwner = useRef(owner);
	const latestRequest = useRef<{
		owner: RuntimeOwnerToken;
		request?: object;
	}>({ owner });

	useLayoutEffect(() => {
		currentOwner.current = owner;
		latestRequest.current = { owner };
	}, [owner]);

	return useCallback(() => {
		if (currentOwner.current !== owner) return () => false;
		const request = {};
		latestRequest.current = { owner, request };
		return () =>
			currentOwner.current === owner &&
			latestRequest.current.owner === owner &&
			latestRequest.current.request === request;
	}, [owner]);
}
