import { sameSshHostOperationalIdentity } from "@/lib/agents/resourceOperationalIdentity";
import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";
import { t } from "@/lib/i18n";
import {
	prepareTrustedSshTarget,
	routeSessionFiles,
	saveTempFiles,
	uploadSshFilesToTempDirectory,
} from "@/lib/ipc";
import { useStore } from "@/store";

async function routePreparedFiles(
	request: Parameters<typeof routeSessionFiles>[0],
) {
	try {
		return await routeSessionFiles(request);
	} catch (cause) {
		const message = String(cause);
		if (message.includes("session_file_remote_update_required"))
			throw new Error(t("files.transfer.remoteUpdateRequired"));
		if (/session_file_(ssh|session|process)_changed/.test(message))
			throw new Error(t("files.transfer.sessionChanged"));
		if (/session_file_ssh_(options|remote_command)_unsupported/.test(message))
			throw new Error(t("files.transfer.sshRouteUnsupported"));
		throw cause;
	}
}

/** The receiving session's host determines where its file references resolve.
 * Each native save/upload creates a fresh private directory and never replaces
 * a user file. Pin the server key at the explicit transfer boundary. */
export async function saveSessionFiles(
	hostId: string | undefined,
	files: DroppedFilePayload[],
	session?: { sessionId: string; workspaceId: string; terminalEpoch: string },
): Promise<string[]> {
	if (hostId === undefined) {
		const paths = await saveTempFiles(files);
		return session ? routePreparedFiles({ ...session, paths }) : paths;
	}
	const host = useStore
		.getState()
		.sshHosts.find((candidate) => candidate.id === hostId);
	if (!host) throw new Error(t("common.hostNotFound"));
	const expected = {
		...host,
		credential: host.credential ? { ...host.credential } : undefined,
	};
	const {
		schemaVersion: _version,
		hostId: _hostId,
		...opts
	} = await prepareTrustedSshTarget([expected], hostId);
	const current = useStore
		.getState()
		.sshHosts.find((candidate) => candidate.id === hostId);
	if (!sameSshHostOperationalIdentity(current, expected))
		throw new Error("session_file_host_changed");
	const paths = await uploadSshFilesToTempDirectory(opts, files);
	if (!session) return paths;
	if (
		!sameSshHostOperationalIdentity(
			useStore.getState().sshHosts.find((candidate) => candidate.id === hostId),
			expected,
		)
	)
		throw new Error("session_file_host_changed");
	const routed = await routePreparedFiles({ ...session, paths, opts });
	if (
		!sameSshHostOperationalIdentity(
			useStore.getState().sshHosts.find((candidate) => candidate.id === hostId),
			expected,
		)
	)
		throw new Error("session_file_host_changed");
	return routed;
}
