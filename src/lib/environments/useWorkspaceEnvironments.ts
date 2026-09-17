import { useCallback, useEffect, useRef, useState } from "react";
import {
	type EnvironmentSnapshot,
	listEnvironments,
} from "@/lib/ipc/dureWorkspaceEnvironment";
import { environmentPending } from "./workspaceEnvironmentContract";

/** Poll only while a visible lifecycle operation is pending. Mutations are never replayed. */
export function useWorkspaceEnvironments(enabled = true) {
	const [snapshot, setSnapshot] = useState<EnvironmentSnapshot | null>(null);
	const [error, setError] = useState<unknown>(null);
	const requestSequence = useRef(0);
	const refresh = useCallback(async () => {
		const sequence = ++requestSequence.current;
		try {
			const next = await listEnvironments();
			if (sequence === requestSequence.current) {
				setSnapshot(next);
				setError(null);
			}
			return next;
		} catch (cause) {
			if (sequence === requestSequence.current) {
				setSnapshot(null);
				setError(cause);
			}
			throw cause;
		}
	}, []);
	const pending = snapshot?.environments.some(environmentPending) ?? false;
	useEffect(() => {
		if (!enabled) return;
		void refresh().catch(() => {});
		return () => {
			requestSequence.current += 1;
		};
	}, [enabled, refresh]);
	useEffect(() => {
		if (!enabled || !pending) return;
		let disposed = false;
		let timer: number;
		const poll = async () => {
			await refresh().catch(() => {});
			if (!disposed) timer = window.setTimeout(() => void poll(), 1500);
		};
		timer = window.setTimeout(() => void poll(), 1500);
		return () => {
			disposed = true;
			window.clearTimeout(timer);
		};
	}, [enabled, pending, refresh]);
	return { snapshot, error, refresh };
}
