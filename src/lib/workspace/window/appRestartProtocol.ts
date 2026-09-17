import type { WorkCheckpointResume } from "@/lib/persistence/windowWorkCheckpoint";

type Phase = "prepare" | "verify" | "release";
export interface RestartRequest {
	id: string;
	owner: string;
	phase: Phase;
}
export interface RestartResponse extends RestartRequest {
	window: string;
	realm: string;
	drafts: readonly (readonly [string, string])[];
	error?: string;
}
export interface RestartTransport {
	owner: string;
	windows(): Promise<readonly string[]>;
	send(request: RestartRequest): Promise<void>;
	listen(listener: (response: RestartResponse) => void): Promise<() => void>;
}

/** A bounded two-phase handshake; silence and changed window generations never authorize restart. */
export async function runPreparedRestart(
	transport: RestartTransport,
	commit: (verify: () => Promise<void>) => Promise<void>,
	timeoutMs = 30_000,
): Promise<void> {
	const id = crypto.randomUUID();
	const windows = [...new Set(await transport.windows())].sort();
	if (!windows.includes(transport.owner))
		throw new Error("app_restart_owner_missing");
	const realms = new Map<string, string>();
	let receive: (response: RestartResponse) => void = () => {};
	const stop = await transport.listen((response) => receive(response));
	const exchange = async (phase: "prepare" | "verify") => {
		const current = [...new Set(await transport.windows())].sort();
		if (JSON.stringify(current) !== JSON.stringify(windows))
			throw new Error("app_restart_windows_changed");
		await new Promise<void>((resolve, reject) => {
			const pending = new Set(windows);
			const drafts = new Map<string, string>();
			let done = false;
			const timer = setTimeout(
				() => finish(new Error("app_restart_window_unresponsive")),
				timeoutMs,
			);
			const finish = (error?: unknown) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				receive = () => {};
				if (error) reject(error);
				else resolve();
			};
			receive = (response) => {
				if (
					response.id !== id ||
					response.owner !== transport.owner ||
					response.phase !== phase ||
					!pending.has(response.window)
				)
					return;
				if (response.error) return finish(new Error(response.error));
				for (const [identity, digest] of response.drafts) {
					if (drafts.has(identity) && drafts.get(identity) !== digest)
						return finish(new Error("app_restart_draft_conflict"));
					drafts.set(identity, digest);
				}
				if (
					phase === "verify" &&
					realms.get(response.window) !== response.realm
				)
					return finish(new Error("app_restart_window_reloaded"));
				realms.set(response.window, response.realm);
				pending.delete(response.window);
				if (!pending.size) finish();
			};
			void transport.send({ id, owner: transport.owner, phase }).catch(finish);
		});
	};
	try {
		await exchange("prepare");
		await commit(() => exchange("verify"));
	} finally {
		stop();
		await transport.send({ id, owner: transport.owner, phase: "release" });
	}
}

/** One realm holds its input and mounted document writers until commit or abort. */
export function createRestartParticipant(runtime: {
	window: string;
	realm: string;
	holdInput(cancel: () => void): () => void;
	checkpoint(): Promise<WorkCheckpointResume>;
	settle(): Promise<unknown>;
	respond(response: RestartResponse): Promise<void>;
}) {
	let held:
		| {
				id: string;
				owner: string;
				releaseInput: () => void;
				resumeWork?: WorkCheckpointResume;
				ready: boolean;
		  }
		| undefined;
	const release = () => {
		const current = held;
		held = undefined;
		current?.resumeWork?.();
		current?.releaseInput();
	};
	return {
		dispose: release,
		async handle(request: RestartRequest): Promise<void> {
			const matches = held?.id === request.id && held.owner === request.owner;
			if (request.phase === "release") {
				if (matches) release();
				return;
			}
			const response = (error?: string) =>
				runtime.respond({
					...request,
					window: runtime.window,
					realm: runtime.realm,
					drafts: held?.resumeWork?.drafts ?? [],
					...(error ? { error } : {}),
				});
			try {
				if (request.phase === "prepare") {
					if (held) throw new Error("app_restart_already_preparing");
					const current = {
						id: request.id,
						owner: request.owner,
						releaseInput: runtime.holdInput(release),
						ready: false,
						resumeWork: undefined as WorkCheckpointResume | undefined,
					};
					held = current;
					const resume = await runtime.checkpoint();
					if (held !== current) {
						resume();
						throw new Error("app_restart_cancelled");
					}
					current.resumeWork = resume;
					await runtime.settle();
					if (held !== current) throw new Error("app_restart_cancelled");
					current.ready = true;
				} else {
					if (!matches || !held?.ready)
						throw new Error("app_restart_preparation_missing");
					const current = held;
					// Re-checkpoint asynchronous document changes made while installing.
					const resume = await runtime.checkpoint();
					if (held !== current) {
						resume();
						throw new Error("app_restart_cancelled");
					}
					current.resumeWork?.();
					current.resumeWork = resume;
					await runtime.settle();
					if (held !== current) throw new Error("app_restart_cancelled");
				}
				await response();
			} catch (error) {
				if (held?.id === request.id && held.owner === request.owner) release();
				await response(error instanceof Error ? error.message : String(error));
			}
		},
	};
}
