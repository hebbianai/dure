import fs from "node:fs";
import { createHash } from "node:crypto";

const cache = new Map();

export function fixtureClaudeExecutableIdentity(target) {
	const metadata = fs.lstatSync(target, { bigint: true });
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error("claude_fixture_executable_invalid");
	}
	const cacheKey = [
		target,
		metadata.dev,
		metadata.ino,
		metadata.size,
		metadata.mtimeNs,
	].join(":");
	let identity = cache.get(cacheKey);
	if (!identity) {
		identity = Object.freeze({
			changedNanoseconds: (metadata.ctimeNs % 1_000_000_000n).toString(),
			changedSeconds: (metadata.ctimeNs / 1_000_000_000n).toString(),
			device: metadata.dev.toString(),
			inode: metadata.ino.toString(),
			modifiedNanoseconds: (metadata.mtimeNs % 1_000_000_000n).toString(),
			modifiedSeconds: (metadata.mtimeNs / 1_000_000_000n).toString(),
			sha256: `sha256:${createHash("sha256").update(fs.readFileSync(target)).digest("hex")}`,
			size: metadata.size.toString(),
		});
		cache.set(cacheKey, identity);
	}
	return identity;
}
