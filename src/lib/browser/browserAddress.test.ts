import { describe, expect, it } from "vitest";
import {
	isLoopbackUrl,
	isMachineLocalUrl,
	normalizeBrowserAddress,
} from "./browserAddress";

describe("browser addresses", () => {
	it("normalizes typed input", () => {
		expect(normalizeBrowserAddress("")).toBe("about:blank");
		expect(normalizeBrowserAddress("example.com")).toBe("https://example.com");
		expect(normalizeBrowserAddress("http://localhost:3000")).toBe(
			"http://localhost:3000",
		);
	});

	it.each([
		"http://localhost:5173/",
		"https://LOCALHOST:8443/a",
		"http://app.localhost:3000",
		"http://127.0.0.1:8080/x",
		"http://[::1]:3000/",
	])("treats %s as loopback and machine-local", (address) => {
		expect(isLoopbackUrl(address)).toBe(true);
		expect(isMachineLocalUrl(address)).toBe(true);
	});

	it.each(["http://0.0.0.0:8000/docs", "http://[::]:8000/"])(
		"treats the unspecified address %s as machine-local but not loopback",
		(address) => {
			expect(isMachineLocalUrl(address)).toBe(true);
			expect(isLoopbackUrl(address)).toBe(false);
		},
	);

	it.each([
		"https://example.com",
		"http://localhost.example.com",
		"http://192.168.1.4:3000",
		"ftp://localhost/file",
		"localhost:3000",
		"not a url",
	])("does not treat %s as machine-local", (address) => {
		expect(isLoopbackUrl(address)).toBe(false);
		expect(isMachineLocalUrl(address)).toBe(false);
	});
});
