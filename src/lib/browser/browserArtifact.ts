import { asRecord } from "@/lib/payloadGuards";
import { bytesToBase64 } from "@/lib/platform/base64";
import { parseBrowserPage, sameBrowserPage } from "./browserResourceContract";

export function parseBrowserImageArtifact(value: unknown) {
	const raw = asRecord(value);
	const page = parseBrowserPage(raw?.page);
	if (
		!raw ||
		!page ||
		raw.mimeType !== "image/png" ||
		typeof raw.size !== "number" ||
		!Number.isSafeInteger(raw.size) ||
		raw.size <= 0 ||
		raw.size > 64 * 1024 * 1024 ||
		typeof raw.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(raw.sha256)
	)
		return undefined;
	return {
		page,
		mimeType: "image/png" as const,
		size: raw.size,
		sha256: raw.sha256,
	};
}

/** Read the immutable export through the existing bounded artifact carrier.
 * Cancellation stops future reads; it never repeats the capture operation. */
export async function downloadBrowserImage(
	read: (offset: number) => Promise<unknown>,
	artifact: NonNullable<ReturnType<typeof parseBrowserImageArtifact>>,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const bytes = new Uint8Array(artifact.size);
	let offset = 0;
	while (offset < bytes.length) {
		signal?.throwIfAborted();
		const part = asRecord(await read(offset));
		signal?.throwIfAborted();
		const manifest = parseBrowserImageArtifact(part?.artifact);
		if (
			!part ||
			!manifest ||
			!sameBrowserPage(manifest.page, artifact.page) ||
			manifest.size !== artifact.size ||
			manifest.sha256 !== artifact.sha256 ||
			part.offset !== offset ||
			typeof part.base64 !== "string" ||
			part.base64.length > 87384 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				part.base64,
			)
		)
			throw new Error("browser_artifact_invalid");
		const chunk = atob(part.base64);
		if (
			!chunk.length ||
			chunk.length > 64 * 1024 ||
			btoa(chunk) !== part.base64 ||
			offset + chunk.length > artifact.size ||
			part.eof !== (offset + chunk.length === artifact.size)
		)
			throw new Error("browser_artifact_invalid");
		for (let i = 0; i < chunk.length; i++)
			bytes[offset + i] = chunk.charCodeAt(i);
		offset += chunk.length;
	}
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	signal?.throwIfAborted();
	if (
		Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
			"",
		) !== artifact.sha256
	)
		throw new Error("browser_artifact_digest_mismatch");
	return bytesToBase64(bytes);
}
