import { describe, expect, it } from "vitest";
import { DEFAULT_SSH_PORT, parseSshPort } from "@/lib/ssh/sshPort";

describe("parseSshPort", () => {
	it("reads a port in range", () => {
		expect(parseSshPort("22")).toEqual({ ok: true, port: 22 });
		expect(parseSshPort("2222")).toEqual({ ok: true, port: 2222 });
		expect(parseSshPort("1")).toEqual({ ok: true, port: 1 });
		expect(parseSshPort("65535")).toEqual({ ok: true, port: 65535 });
		expect(parseSshPort("  2222  ")).toEqual({ ok: true, port: 2222 });
	});

	it("treats a blank field as the default", () => {
		expect(parseSshPort("")).toEqual({ ok: true, port: DEFAULT_SSH_PORT });
		expect(parseSshPort("   ")).toEqual({ ok: true, port: DEFAULT_SSH_PORT });
	});

	/** Each of these used to be saved as something the reader never typed. */
	it("refuses what the old parseInt read as 22", () => {
		// parseInt("abc") is NaN, and `NaN || 22` was 22.
		expect(parseSshPort("abc")).toEqual({ ok: false });
		// parseInt("0") is 0, and zero is falsy, so `0 || 22` was 22 too.
		expect(parseSshPort("0")).toEqual({ ok: false });
		// parseInt stops at the first non-digit: all of these read as 22.
		expect(parseSshPort("22x")).toEqual({ ok: false });
		expect(parseSshPort("22.5")).toEqual({ ok: false });
		expect(parseSshPort("2 2")).toEqual({ ok: false });
	});

	it("refuses ports outside the TCP range", () => {
		expect(parseSshPort("65536")).toEqual({ ok: false });
		expect(parseSshPort("99999")).toEqual({ ok: false });
		expect(parseSshPort("-5")).toEqual({ ok: false });
	});
});
