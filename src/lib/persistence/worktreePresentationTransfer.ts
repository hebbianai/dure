import { DURABLE_APP_STORE_NAME } from "./durableAppStoreName";
import {
	type DurableWriteCoordinator,
	durableWriteCoordinator,
} from "./durableWriteCoordinator";
import {
	readWorktreePresentationEnvelope,
	validatePresentationValue,
	type WorktreePresentationIdentity,
} from "./worktreePresentationEnvelope";

interface TransferStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const transferFailureScope = {};
const transferRunOptions = { failureScope: transferFailureScope };

/** Reads under the existing writer lock without repairing or rewriting the source. */
export function exportWorktreePresentation(
	storage: Pick<TransferStorage, "getItem"> = localStorage,
	coordinator: DurableWriteCoordinator = durableWriteCoordinator,
): Promise<string> {
	return coordinator.run(
		DURABLE_APP_STORE_NAME,
		() => {
			const raw = storage.getItem(DURABLE_APP_STORE_NAME);
			if (raw === null) throw new Error("worktree_presentation_source_absent");
			return validatePresentationValue(raw);
		},
		transferRunOptions,
	);
}

/** Runs before importing the app/store bundle; a later launch retains its own state. */
export async function importFirstWorktreePresentation(
	identity: WorktreePresentationIdentity,
	readEnvelope: () => Promise<unknown>,
	maxStoreVersion: number,
	storage: TransferStorage = localStorage,
	coordinator: DurableWriteCoordinator = durableWriteCoordinator,
): Promise<"imported" | "existing" | "consumed"> {
	return coordinator.run(
		DURABLE_APP_STORE_NAME,
		async () => {
			if (storage.getItem(DURABLE_APP_STORE_NAME) !== null) return "existing";
			const pending = await readEnvelope();
			if (pending === null) return "consumed";
			const envelope = await readWorktreePresentationEnvelope(
				pending,
				identity,
			);
			const value = JSON.parse(envelope.serializedValue) as { version: number };
			if (value.version > maxStoreVersion) {
				throw new Error("worktree_presentation_version_unsupported");
			}
			storage.setItem(DURABLE_APP_STORE_NAME, envelope.serializedValue);
			return "imported";
		},
		transferRunOptions,
	);
}
