export function canonicalSshNetworkHost(value: string): string | undefined {
	if (value.includes(":")) {
		try {
			return new URL(`http://[${value}]/`).hostname.slice(1, -1);
		} catch {
			return undefined;
		}
	}
	if (/^[\d.]+$/.test(value)) {
		const octets = value.split(".");
		return octets.length === 4 &&
			octets.every(
				(part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255,
			)
			? value
			: undefined;
	}
	const host = value.toLowerCase().replace(/\.$/, "");
	const labels = host.split(".");
	return host.length <= 253 &&
		labels.length > 1 &&
		labels.every((label) =>
			/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
		)
		? host
		: undefined;
}
