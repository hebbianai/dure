import { describe, expect, it } from "vitest";
import {
	crashReportAttachment,
	crashReportBody,
} from "@/lib/feedback/crashReportEnvelope";
import {
	buildErrorReportBundle,
	type ErrorIncident,
	serializeErrorReportBundle,
} from "@/lib/platform/errorIncident";

const incident: ErrorIncident = {
	boundary: "app",
	surface: "main",
	occurredAt: "2026-09-14T00:00:00.000Z",
	error: { name: "TypeError", message: "cannot read property 'x'" },
	diagnostics: [],
};

describe("crashReportBody", () => {
	it("uses the trimmed reproduction notes when the user typed any", () => {
		const bundle = buildErrorReportBundle(incident, { notes: "  it froze  " });
		expect(crashReportBody(bundle)).toBe("it froze");
	});

	it("falls back to the error name and message when notes are empty", () => {
		const bundle = buildErrorReportBundle(incident, { notes: "" });
		expect(crashReportBody(bundle)).toBe("TypeError: cannot read property 'x'");
	});

	it("falls back the same way when notes are whitespace-only", () => {
		const bundle = buildErrorReportBundle(incident, { notes: "   \n\t " });
		expect(crashReportBody(bundle)).toBe("TypeError: cannot read property 'x'");
	});

	it("never returns an empty string", () => {
		const bundle = buildErrorReportBundle(incident, { notes: "" });
		expect(crashReportBody(bundle).trim().length).toBeGreaterThan(0);
	});
});

describe("crashReportAttachment", () => {
	it("uses a fixed, safe literal name and the JSON media type", () => {
		const bundle = buildErrorReportBundle(incident, { notes: "it froze" });
		const attachment = crashReportAttachment(bundle);
		expect(attachment.name).toBe("error-report.json");
		expect(attachment.mediaType).toBe("application/json");
		// The intake's safe_attachment_basename (sink.rs) rejects anything
		// outside [A-Za-z0-9._-]{1,64} with at least one non-dot character.
		expect(attachment.name).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
		expect(attachment.name.replace(/\./g, "").length).toBeGreaterThan(0);
	});

	it("base64-encodes exactly the same JSON text Copy/Save use", () => {
		const bundle = buildErrorReportBundle(incident, { notes: "it froze" });
		const attachment = crashReportAttachment(bundle);
		const decoded = new TextDecoder().decode(
			Uint8Array.from(atob(attachment.bytesB64), (c) => c.charCodeAt(0)),
		);
		expect(decoded).toBe(serializeErrorReportBundle(bundle));
	});
});
