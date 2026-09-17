import fs from "node:fs";
import path from "node:path";

const ACK_TIMEOUT_MS = 5_000;
const ACK_POLL_INTERVAL_MS = 25;

/** Reuses the app runner's single exclusive-HID admission handshake. */
export async function armExclusiveNativeInput({
	stateRoot,
	requestPath,
	acknowledgementPath,
}) {
	const realStateRoot = fs.realpathSync(path.resolve(stateRoot));
	for (const handshakePath of [requestPath, acknowledgementPath]) {
		if (
			fs.realpathSync(path.dirname(path.resolve(handshakePath))) !==
			realStateRoot
		) {
			throw new Error("exclusive native input handshake escaped its state root");
		}
	}
	try {
		fs.lstatSync(acknowledgementPath);
		throw new Error("exclusive native input ACK existed before the request");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}

	fs.writeFileSync(requestPath, `${process.pid}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	const deadline = Date.now() + ACK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			const metadata = fs.lstatSync(acknowledgementPath);
			if (metadata.isFile() && !metadata.isSymbolicLink()) return;
			throw new Error("exclusive native input ACK is not a regular file");
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		await sleep(ACK_POLL_INTERVAL_MS);
	}
	throw new Error("timed out arming exclusive native input");
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
