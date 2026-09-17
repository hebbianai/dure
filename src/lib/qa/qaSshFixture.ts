export interface QaSshFixture {
	name: string;
	host: string;
	user: string;
	port: number;
	keyPath: string;
	expectedWorkspacePath: string;
}

type QaSshFixtureDirective = "onboardingssh" | "sshproject";

/** Parse the shared key-auth SSH fixture at the QA flag boundary. */
export function qaSshFixture(
	flag: string,
	directive: QaSshFixtureDirective,
): QaSshFixture | undefined {
	const prefix = `${directive}=`;
	const encoded = flag
		.split(/\s+/u)
		.find((part) => part.startsWith(prefix))
		?.slice(prefix.length);
	if (!encoded) return undefined;

	let candidate: unknown;
	try {
		const base64 = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
		candidate = JSON.parse(atob(base64));
	} catch {
		throw new Error("SSH QA fixture is malformed");
	}
	if (!candidate || typeof candidate !== "object") {
		throw new Error("SSH QA fixture is missing");
	}
	const host = candidate as Record<string, unknown>;
	if (
		typeof host.name !== "string" ||
		typeof host.host !== "string" ||
		typeof host.user !== "string" ||
		typeof host.port !== "number" ||
		!Number.isInteger(host.port) ||
		host.port < 1 ||
		host.port > 65_535 ||
		host.auth !== "key" ||
		typeof host.keyPath !== "string" ||
		!host.keyPath.startsWith("/") ||
		typeof host.expectedWorkspacePath !== "string" ||
		!host.expectedWorkspacePath.startsWith("/")
	) {
		throw new Error("SSH QA fixture is outside the reviewed key-auth shape");
	}
	return {
		name: host.name,
		host: host.host,
		user: host.user,
		port: host.port,
		keyPath: host.keyPath,
		expectedWorkspacePath: host.expectedWorkspacePath,
	};
}
