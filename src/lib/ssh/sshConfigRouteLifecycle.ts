import {
	normalizeSshConfigAlias,
	type SshConfigHostDraft,
} from "@/lib/ssh/sshConfigRegistration";
import {
	createSshHostDurably,
	type SshHostCredentialUpdate,
	type SshHostRegistrationResult,
	updateSshHostCredentialsDurably,
} from "@/lib/ssh/sshCredentialLifecycle";
import type { SshHostConfig } from "@/types";

export function sshConfigRouteAdoptionUpdate(
	host: SshHostConfig,
	draft: SshConfigHostDraft,
): SshHostCredentialUpdate | undefined {
	if (normalizeSshConfigAlias(host.sshConfigAlias)) return undefined;
	return {
		expected: host,
		next: {
			name: host.name,
			sshConfigAlias: draft.sshConfigAlias,
			host: host.host,
			port: host.port,
			user: host.user,
			auth: host.auth,
			keyPath: host.keyPath,
		},
	};
}

export async function registerSshConfigHostDurably(
	draft: SshConfigHostDraft,
	password?: string,
): Promise<SshHostRegistrationResult> {
	const registration = await createSshHostDurably(draft, password);
	if (registration.created) return registration;
	const adoption = sshConfigRouteAdoptionUpdate(registration.host, draft);
	if (!adoption) return registration;
	return {
		host: await updateSshHostCredentialsDurably(adoption),
		created: false,
	};
}
