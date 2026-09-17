import { describe, expect, it } from "vitest";
import {
	RemoteHmuxRequestCoalescer,
	remoteHmuxHostRequestKey,
} from "@/lib/hmux/remote/remoteHmuxHostRequests";

describe("RemoteHmuxRequestCoalescer", () => {
	it("shares one request between identical questions in flight", async () => {
		let calls = 0;
		let resolve = (_: string) => {};
		const coalescer = new RemoteHmuxRequestCoalescer<string>();
		const request = () => {
			calls += 1;
			return new Promise<string>((done) => {
				resolve = done;
			});
		};
		const first = coalescer.run("box", request);
		const second = coalescer.run("box", request);
		expect(calls).toBe(1);
		resolve("trusted");
		await expect(first).resolves.toBe("trusted");
		await expect(second).resolves.toBe("trusted");

		// Settled: the next question asks again, so it sees the box as it is.
		coalescer.run("box", request);
		expect(calls).toBe(2);
	});

	it("does not share a failure with a later question", async () => {
		let calls = 0;
		const coalescer = new RemoteHmuxRequestCoalescer<string>();
		const failing = () => {
			calls += 1;
			return Promise.reject(new Error("remote_hmux_host_untrusted"));
		};
		await expect(coalescer.run("box", failing)).rejects.toThrow(
			"remote_hmux_host_untrusted",
		);
		await expect(coalescer.run("box", failing)).rejects.toThrow(
			"remote_hmux_host_untrusted",
		);
		expect(calls).toBe(2);
	});

	it("keys questions by every part that decides the answer", () => {
		expect(remoteHmuxHostRequestKey(["host-1", "box.example", 22])).not.toBe(
			remoteHmuxHostRequestKey(["host-1", "box.example", 2222]),
		);
		expect(remoteHmuxHostRequestKey(["a", "bc"])).not.toBe(
			remoteHmuxHostRequestKey(["ab", "c"]),
		);
	});
});
