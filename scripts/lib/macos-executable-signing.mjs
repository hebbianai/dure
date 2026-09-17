import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { developerIdTeam } from "./macos-signing-readiness.mjs";

const developerId = "=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";

/** Seal owned staged copies once, after source stabilization and before hashing. */
export function signMacosExecutables(files, identity) {
	if (!developerIdTeam(identity)) throw new Error("macos_distribution_developer_id_required");
	for (const file of files) {
		if (!fs.lstatSync(file).isFile()) throw new Error(`macos_signing_regular_file_required: ${file}`);
	}
	for (const file of files) {
		execFileSync("codesign", ["--force", "--sign", identity, "--options", "runtime", "--timestamp", file], { stdio: "inherit" });
	}
}

function isMachOExecutable(file) {
	const descriptor = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(descriptor).size;
		const read = (offset, length) => {
			if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > size) throw new Error(`macos_executable_header_invalid: ${file}`);
			const bytes = Buffer.alloc(length);
			if (fs.readSync(descriptor, bytes, 0, length, offset) !== length) throw new Error(`macos_executable_header_incomplete: ${file}`);
			return bytes;
		};
		if (size < 4) return false;
		const thin = (offset) => {
			const header = read(offset, 16);
			const magic = header.readUInt32BE(0);
			if (magic === 0xfeedface || magic === 0xfeedfacf) return header.readUInt32BE(12) === 2;
			if (magic === 0xcefaedfe || magic === 0xcffaedfe) return header.readUInt32LE(12) === 2;
			throw new Error(`macos_executable_architecture_invalid: ${file}`);
		};
		const magic = read(0, 4).readUInt32BE(0);
		if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return thin(0);
		if (![0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) return false;
		const little = magic === 0xbebafeca || magic === 0xbfbafeca;
		const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
		const header = read(0, 8);
		const count = little ? header.readUInt32LE(4) : header.readUInt32BE(4);
		if (count < 1 || count > 128) throw new Error(`macos_executable_architecture_count_invalid: ${file}`);
		let executable = false;
		for (let index = 0; index < count; index++) {
			const architecture = read(8 + index * (wide ? 32 : 20), wide ? 32 : 20);
			const offset = wide
				? Number(little ? architecture.readBigUInt64LE(8) : architecture.readBigUInt64BE(8))
				: little ? architecture.readUInt32LE(8) : architecture.readUInt32BE(8);
			executable = thin(offset) || executable;
		}
		return executable;
	} finally {
		fs.closeSync(descriptor);
	}
}

function requireProtection(description, label) {
	const flags = /^CodeDirectory .*flags=0x[\da-f]+\(([^)]*)\)/im.exec(description)?.[1]?.split(",");
	if (!flags?.includes("runtime")) throw new Error(`macos_distribution_${label}_hardened_runtime_required`);
	if (!/^Timestamp=.+$/m.test(description)) throw new Error(`macos_distribution_${label}_secure_timestamp_required`);
}

/** Resource executables are sealed as data by the outer app signature. */
export function verifyMacosAppCode(app, identity, check) {
	const team = developerIdTeam(identity);
	if (!team) throw new Error("macos_distribution_developer_id_required");
	check("app_signature", "codesign", ["--verify", "--deep", "--strict", "--test-requirement", `${developerId} and certificate leaf[subject.OU] = "${team}"`, app]);
	requireProtection(check("app_identity", "codesign", ["--display", "--verbose=4", app]), "app");
	const visit = (directory) => {
		for (const name of fs.readdirSync(directory).sort()) {
			const file = path.join(directory, name);
			const stat = fs.lstatSync(file);
			if (stat.isDirectory()) visit(file);
			else if (stat.isFile() && isMachOExecutable(file)) {
				// Vendor-signed Node keeps its own valid Developer ID and entitlements.
				check("resource_signature", "codesign", ["--verify", "--strict", "--all-architectures", "--test-requirement", developerId, file]);
				requireProtection(check("resource_identity", "codesign", ["--display", "--verbose=4", file]), "resource");
			}
		}
	};
	visit(path.join(app, "Contents", "Resources"));
}
