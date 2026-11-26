export function normalizeBrowserAddress(input: string): string {
	const value = input.trim();
	if (!value) return "about:blank";
	if (/^[a-z]+:\/\//i.test(value) || value.startsWith("about:")) return value;
	if (/\s/.test(value) || !value.includes("."))
		return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
	return `https://${value}`;
}

function httpHostname(address: string): string | undefined {
	try {
		const url = new URL(address);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.hostname.toLowerCase()
			: undefined;
	} catch {
		return undefined;
	}
}

/** An http(s) address on the loopback interface of the machine that opens
 * it. The same hosts the native design mode injects its picker into. */
export function isLoopbackUrl(address: string): boolean {
	const host = httpHostname(address);
	return (
		host !== undefined &&
		(host === "localhost" ||
			host.endsWith(".localhost") ||
			host === "127.0.0.1" ||
			host === "[::1]")
	);
}

/** An http(s) address that names whichever machine opens it: a loopback
 * address, or the unspecified address a server prints when it listens on
 * every interface. */
export function isMachineLocalUrl(address: string): boolean {
	const host = httpHostname(address);
	return isLoopbackUrl(address) || host === "0.0.0.0" || host === "[::]";
}
