import { homeDir } from "@/lib/ipc";

export interface SshRegistrationRecovery {
	desktopId: string;
	panelId: string;
	previousRealmId: string;
	binding: {
		runtime: "hmux_standalone_v1";
		source: "ssh";
		hostId: string;
		sessionId: string;
		workspaceId: string;
	};
}

export async function readSshRegistrationFixture() {
	const runId = import.meta.env.VITE_DURE_SSH_REGISTRATION_QA_RUN_ID;
	if (typeof runId !== "string" || !/^[a-f0-9-]{36}$/.test(runId))
		throw new Error("invalid QA identity");
	const response = await fetch("/__qa_flag", {
		signal: AbortSignal.timeout(2_000),
	});
	if (!response.ok) throw new Error("SSH QA fixture is unavailable");
	const flag = await response.json();
	const home = (await homeDir()).replace(/\/$/, "");
	if (
		flag.runId !== runId ||
		flag.home !== home ||
		!home.includes("/dure-ssh-registration.") ||
		flag.host !== "127.0.0.1"
	) {
		throw new Error("SSH registration QA escaped its disposable home");
	}
	return flag as {
		runId: string;
		home: string;
		host: "127.0.0.1";
		port: number;
		user: string;
		recovery?: SshRegistrationRecovery;
		repeatedClose?: {
			desktopId: string;
			panelId: string;
			sessionId: string;
			workspaceId: string;
			hostId: string;
		};
	};
}

export function sshRegistrationQaPublisher(runId: string, realmId: string) {
	return async (event: string, detail: object = {}) => {
		const response = await fetch("/__qa_log", {
			method: "POST",
			body: JSON.stringify([
				"ssh-registration",
				{ runId, realmId, event, ...detail },
			]),
			signal: AbortSignal.timeout(2_000),
		});
		if (!response.ok) throw new Error("QA evidence publication failed");
	};
}

export function sshRegistrationMarker(
	runId: string,
	sequence: "0001" | "0002",
) {
	const marker = `HMUX_WINDOW_QA_${runId.replace(/-/g, "").slice(0, 12).toUpperCase()}_S_${sequence}`;
	const escaped = [...marker]
		.map(
			(character) =>
				`\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`,
		)
		.join("");
	return { marker, input: `printf '${escaped}\\n'\r` };
}
