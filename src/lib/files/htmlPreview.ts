// A local HTML page renders in the file viewer as a static preview. The frame's
// sandbox blocks scripts, forms, popups and top-level navigation; this module
// prepares the document the frame shows. Nothing here relies on listeners in
// the frame: WebKit runs no event listener, not even the parent's, inside a
// frame whose sandbox blocks scripts. Images beside the page are read through
// the same local or SSH route as the page, because the preview document would
// otherwise resolve relative references against the app's own origin.

import { resolveMarkdownAssetPath } from "@/lib/files/markdownAssets";

const HTML_FILE_NAME = /\.html?$/i;
const SCRIPT_ATTRIBUTE = /^on/i;
/** The srcdoc document's own URL: `#id` links stay same-document fragment
 * navigations, and nothing relative resolves against the app. */
const PREVIEW_BASE_URL = "about:srcdoc";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/** Distinct local images one preview reads; references beyond it stay as written. */
export const HTML_PREVIEW_IMAGE_LIMIT = 64;

export function isHtmlFileName(name: string): boolean {
	return HTML_FILE_NAME.test(name);
}

/** Text documents the viewer can show rendered as well as as source. */
export function hasRenderedView(file: { kind: string; name: string }): boolean {
	return file.kind === "markdown" || (file.kind === "text" && isHtmlFileName(file.name));
}

export interface HtmlPreview {
	srcdoc: string;
	/** The page has scripts or inline handlers that the preview does not run. */
	hasScripts: boolean;
}

/** Reads one image beside the page as a data URI; undefined keeps the reference as written. */
export type HtmlPreviewImageReader = (path: string) => Promise<string | undefined>;

function containsScripts(doc: Document): boolean {
	if (doc.querySelector("script")) return true;
	for (const element of doc.querySelectorAll("*")) {
		for (const name of element.getAttributeNames()) {
			if (SCRIPT_ATTRIBUTE.test(name)) return true;
		}
	}
	return false;
}

/** Links never navigate the frame. Fragments scroll within the page; any other
 * link opens a new window, which the sandbox refuses, and shows its target on
 * hover. A refresh directive could still navigate, so it is dropped. */
function keepFrameInPlace(doc: Document): void {
	for (const base of doc.querySelectorAll("base")) base.remove();
	const base = doc.createElement("base");
	base.setAttribute("href", PREVIEW_BASE_URL);
	doc.head.prepend(base);
	for (const meta of doc.querySelectorAll("meta[http-equiv]")) {
		if (meta.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") meta.remove();
	}
	for (const link of doc.querySelectorAll("a, area")) {
		// SVG links may still use the older xlink:href.
		const raw = link.getAttribute("href") ?? link.getAttributeNS(XLINK_NAMESPACE, "href");
		if (raw === null) continue;
		const href = raw.trim();
		if (href.startsWith("#")) {
			link.removeAttribute("target");
			continue;
		}
		link.setAttribute("target", "_blank");
		if (!link.hasAttribute("title")) link.setAttribute("title", href);
	}
}

function serialize(doc: Document): string {
	const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : "";
	return doctype + doc.documentElement.outerHTML;
}

/** The preview document for `html` read from `documentPath`. Parsing never
 * runs the page's scripts; relative images become data URIs. */
export async function buildHtmlPreview(
	html: string,
	documentPath: string,
	readImage: HtmlPreviewImageReader,
): Promise<HtmlPreview> {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const reads = new Map<string, Promise<string | undefined>>();
	await Promise.all(
		[...doc.querySelectorAll("img[src]")].map(async (image) => {
			const path = resolveMarkdownAssetPath(documentPath, image.getAttribute("src") ?? "");
			if (!path) return;
			let read = reads.get(path);
			if (!read) {
				if (reads.size >= HTML_PREVIEW_IMAGE_LIMIT) return;
				read = readImage(path).catch(() => undefined);
				reads.set(path, read);
			}
			const uri = await read;
			if (!uri) return;
			image.setAttribute("src", uri);
			// A relative srcset would win over the inlined src and miss again.
			image.removeAttribute("srcset");
		}),
	);
	keepFrameInPlace(doc);
	return { srcdoc: serialize(doc), hasScripts: containsScripts(doc) };
}
