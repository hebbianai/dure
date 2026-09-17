export interface PromptIdentity {
	promptDigest: string;
	promptLen: number;
}

export async function computeTextDigest(value: string): Promise<string> {
	const encoded = new TextEncoder().encode(value);
	const digest = new Uint8Array(
		await globalThis.crypto.subtle.digest("SHA-256", encoded),
	);
	return `sha256:${[...digest]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;
}

export async function computePromptIdentity(
	prompt: string,
): Promise<PromptIdentity> {
	const encoded = new TextEncoder().encode(prompt);
	return {
		promptDigest: await computeTextDigest(prompt),
		promptLen: encoded.byteLength,
	};
}
