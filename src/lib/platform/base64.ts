const BASE64_CHUNK_BYTES = 0x8000;

/** Encode browser bytes without exceeding the argument limit of one spread. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
		binary += String.fromCharCode(
			...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES),
		);
	}
	return btoa(binary);
}
