// Mockup-pane srcdoc assembly.
// CSP-spike-proven mechanism (2026-08-06): the pane injects the parent
// document's actually-loaded stylesheets plus a scheme override for the
// REQUESTED preview appearance into the srcdoc inline, so mockups render with
// production tokens and the previewed theme in both vite dev and tauri://
// prod. Mockup files need no CSS of their own; coverage judgment stays static
// and never runs this code.

import { THEME_STYLE_ELEMENT_ID } from "@/lib/theme/themeStyle";

export const MOCKUP_TOKEN_STYLE_ATTR = "data-mockup-tokens";

/** design/mockups/<cluster>/<Name>/<state>.html — the only tree the pane renders. */
export function isMockupPath(path: string): boolean {
	return /(^|\/)design\/mockups\/[^/]+\/[^/]+\/[^/]+\.html$/.test(path);
}

/** "<Name> · <state>" pane title from a mockup path; null when not a mockup path. */
export function mockupPaneTitle(path: string): string | null {
	const match = path.match(/(^|\/)design\/mockups\/[^/]+\/([^/]+)\/([^/]+)\.html$/);
	if (!match) return null;
	return `${match[2]} · ${match[3]}`;
}

/**
 * The parent document's CSS sources: inline <style> texts (vite dev injects
 * styles this way) and stylesheet link hrefs (prod bundles). The managed
 * theme-override element is deliberately EXCLUDED — it carries the app's live
 * appearance and would pin the preview to it (its html:root specificity beats
 * .dark); the pane injects a scheme override for the previewed appearance
 * instead. The caller fetches hrefs — this part stays synchronous and
 * jsdom-testable.
 */
export function appCssSources(doc: Document): { inline: string[]; hrefs: string[] } {
	const inline = [...doc.querySelectorAll(`style:not(#${THEME_STYLE_ELEMENT_ID})`)].map(
		(el) => el.textContent ?? "",
	);
	const hrefs = [...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(
		(el) => el.href,
	);
	return { inline, hrefs };
}

const escapeStyleText = (css: string) => css.replace(/<\/style/gi, "<\\/style");

/** Quote-agnostic class attribute inside an <html ...> tag. */
const CLASS_ATTR = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=>]+))/i;

/**
 * Inject token CSS + dark class into mockup HTML. Handles both full documents
 * and fragments: a fragment is wrapped; a full document gets the style block
 * inserted into (or as) its head, and the dark class merged onto <html>.
 * String.replace always uses replacer functions — collected CSS or tag text
 * must never be interpreted as $-replacement patterns.
 */
export function buildMockupSrcdoc(mockupHtml: string, tokenCss: string, dark: boolean): string {
	const styleBlock = `<style ${MOCKUP_TOKEN_STYLE_ATTR}>${escapeStyleText(tokenCss)}</style>`;
	const htmlTag = mockupHtml.match(/<html\b[^>]*>/i);
	if (!htmlTag) {
		return `<!doctype html><html class="${dark ? "dark" : ""}"><head>${styleBlock}</head><body>${mockupHtml}</body></html>`;
	}
	// Merge the dark class onto the existing <html> tag.
	const tag = htmlTag[0];
	const classMatch = tag.match(CLASS_ATTR);
	let newTag: string;
	if (classMatch) {
		const value = classMatch[1] ?? classMatch[2] ?? classMatch[3] ?? "";
		const classes = new Set(value.split(/\s+/).filter(Boolean));
		if (dark) classes.add("dark");
		else classes.delete("dark");
		const merged = ` class="${[...classes].join(" ")}"`;
		newTag = tag.replace(CLASS_ATTR, () => merged);
	} else {
		newTag = dark ? tag.replace(/<html\b/i, () => '<html class="dark"') : tag;
	}
	const out = mockupHtml.replace(tag, () => newTag);
	const headTag = out.match(/<head\b[^>]*>/i);
	if (headTag) {
		return out.replace(headTag[0], () => `${headTag[0]}${styleBlock}`);
	}
	return out.replace(newTag, () => `${newTag}<head>${styleBlock}</head>`);
}
