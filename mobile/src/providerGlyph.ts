import { agentLogoUrl } from "@/lib/agents/agentLogos";
import { providerGlyphShape } from "@/lib/agents/providerGlyphs";
import iconTerminal from "./assets/icon-command.svg";
import { element, glyph } from "./dom";
import { agentKind } from "./sessionRows";

/** Render the same provider identity and geometry as the desktop. */
export function providerGlyph(provider: string): SVGSVGElement | HTMLElement {
	const known = agentKind(provider);
	const id = known === "other" ? provider : known;
	const className = `session-row__provider session-row__provider--${id}`;
	const shape = providerGlyphShape(id);
	if (shape) {
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("viewBox", shape.viewBox);
		svg.setAttribute("fill", "currentColor");
		svg.setAttribute("fill-rule", "evenodd");
		svg.setAttribute("class", className);
		svg.setAttribute("aria-hidden", "true");
		for (const d of shape.paths) {
			const path = document.createElementNS(svg.namespaceURI, "path");
			path.setAttribute("d", d);
			svg.append(path);
		}
		return svg;
	}
	const logo = agentLogoUrl(id);
	if (logo) {
		const img = element("img", className);
		img.src = logo;
		img.alt = "";
		return img;
	}
	return glyph(iconTerminal, 18, className);
}
