/**
 * 집은 요소의 주변 맥락 수집 (Design Mode).
 *
 * 왜 필요한가: 참조 구현의 grab payload와 우리 캡처를 비교하니 우리 쪽에
 * 접근성 이름·주변 텍스트·조상 경로·재현 가능한 셀렉터·페이지 컨텍스트가 전부
 * 없었다. 그것들이 없으면 에이전트가 "여러 개 중 어느 것"을 모르고, 사람이 그
 * 요소를 부르는 이름(=접근성 이름)도 전달되지 않는다.
 *
 * designModeCapture와 같은 규칙으로 **다른 모듈을 import 하지 않는다** — B단계에서
 * 사용자 앱 창에 주입해 같은 수집을 해야 한다.
 */

export interface ElementAccessibility {
	role?: string;
	/** 사람이 이 요소를 부르는 이름의 **근사치**. AccName 알고리즘 전체가 아니라
	 *  aria-label → aria-labelledby → alt/title → 보이는 텍스트 순의 실용적 근사다.
	 *  정확한 계산이 필요하면 그건 별도 문제다 — 여기서 그런 척하지 않는다. */
	accessibleName?: string;
	ariaLabel?: string;
	ariaLabelledBy?: string;
}

export interface PageContext {
	url: string;
	title: string;
	viewportWidth: number;
	viewportHeight: number;
	scrollX: number;
	scrollY: number;
	devicePixelRatio: number;
	capturedAt: string;
}

/** 문맥 텍스트 상한 — 이걸 넘기면 컨텍스트 폭탄이 된다. */
const MAX_CONTEXT_TEXT = 240;

export function trimText(
	value: string | null | undefined,
	max = MAX_CONTEXT_TEXT,
): string {
	const collapsed = (value ?? "").replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** aria-labelledby가 가리키는 요소들의 텍스트. 없으면 빈 문자열. */
function labelledByText(element: Element): string {
	const ids = element.getAttribute("aria-labelledby");
	if (!ids) return "";
	const doc = element.ownerDocument;
	return trimText(
		ids
			.split(/\s+/)
			.map((id) => doc.getElementById(id)?.textContent ?? "")
			.join(" "),
	);
}

export function elementAccessibility(element: Element): ElementAccessibility {
	const ariaLabel = element.getAttribute("aria-label") ?? undefined;
	const ariaLabelledBy = element.getAttribute("aria-labelledby") ?? undefined;
	const role = element.getAttribute("role") ?? undefined;
	const fallback =
		ariaLabel ||
		labelledByText(element) ||
		element.getAttribute("alt") ||
		element.getAttribute("title") ||
		trimText(element.textContent);
	const accessibility: ElementAccessibility = {};
	if (role) accessibility.role = role;
	if (ariaLabel) accessibility.ariaLabel = ariaLabel;
	if (ariaLabelledBy) accessibility.ariaLabelledBy = ariaLabelledBy;
	const name = trimText(fallback);
	if (name) accessibility.accessibleName = name;
	return accessibility;
}

/**
 * 다시 찾을 수 있는 셀렉터. id가 있으면 그것만으로 끝내고, 없으면 조상마다
 * `tag.class:nth-of-type(n)`을 쌓는다 — 클래스만으로는 같은 카드가 12개일 때
 * 무엇을 집었는지 구분되지 않는다.
 */
export function elementSelector(element: Element, maxDepth = 5): string {
	if (element.id) return `#${element.id}`;
	const parts: string[] = [];
	let current: Element | null = element;
	while (current && parts.length < maxDepth) {
		const tag = current.tagName.toLowerCase();
		if (tag === "body" || tag === "html") break;
		if (current.id) {
			parts.unshift(`#${current.id}`);
			break;
		}
		const parent: Element | null = current.parentElement;
		const sameTag = parent
			? Array.from(parent.children).filter(
					(child) => child.tagName === current?.tagName,
				)
			: [];
		const index = sameTag.indexOf(current) + 1;
		const classes = Array.from(current.classList).slice(0, 2);
		const classPart = classes.length > 0 ? `.${classes.join(".")}` : "";
		parts.unshift(
			sameTag.length > 1
				? `${tag}${classPart}:nth-of-type(${index})`
				: `${tag}${classPart}`,
		);
		current = parent;
	}
	return parts.join(" > ");
}

/** 조상 라벨들(가장 바깥 → 대상). 대상이 어디에 속한 것인지를 말해준다. */
export function ancestorPath(element: Element, maxDepth = 6): string[] {
	const path: string[] = [];
	let current: Element | null = element.parentElement;
	while (current && path.length < maxDepth) {
		const tag = current.tagName.toLowerCase();
		if (tag === "body" || tag === "html") break;
		const classes = Array.from(current.classList).slice(0, 2);
		path.unshift(`${tag}${classes.length ? `.${classes.join(".")}` : ""}`);
		current = current.parentElement;
	}
	return path;
}

/** 형제들의 텍스트 — "여러 개 중 어느 것"을 사람 말로 좁힌다. */
export function nearbyText(element: Element, limit = 3): string[] {
	const parent = element.parentElement;
	if (!parent) return [];
	const texts: string[] = [];
	for (const sibling of Array.from(parent.children)) {
		if (sibling === element) continue;
		const text = trimText(sibling.textContent, 80);
		if (text) texts.push(text);
		if (texts.length >= limit) break;
	}
	return texts;
}

/** 사용자가 선택해 둔 텍스트가 대상 안에 있으면 그것이 의도다. */
export function selectedTextWithin(element: Element): string | undefined {
	const selection = element.ownerDocument.defaultView?.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
		return undefined;
	const text = trimText(selection.toString());
	if (!text) return undefined;
	const anchor = selection.anchorNode;
	if (
		anchor &&
		!element.contains(
			anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement,
		)
	) {
		return undefined;
	}
	return text;
}

/** React 컴포넌트 이름(가능하면). React 19에는 공개 계약이 없어 내부 fiber 키를
 *  best-effort로 읽고, 없으면 undefined다 — 있는 척하지 않는다. */
export function reactComponentName(element: Element): string | undefined {
	const key = Object.keys(element).find((name) =>
		name.startsWith("__reactFiber$"),
	);
	if (!key) return undefined;
	let fiber = (element as unknown as Record<string, unknown>)[key] as
		| { return?: unknown; type?: unknown }
		| undefined;
	for (let depth = 0; fiber && depth < 8; depth += 1) {
		const type = fiber.type as
			| { displayName?: string; name?: string }
			| string
			| undefined;
		if (type && typeof type !== "string") {
			const name = type.displayName ?? type.name;
			if (name && /^[A-Z]/.test(name)) return name;
		}
		fiber = fiber.return as typeof fiber;
	}
	return undefined;
}

export function pageContext(view: Window, now: string): PageContext {
	return {
		url: view.location.href,
		title: view.document.title,
		viewportWidth: view.innerWidth,
		viewportHeight: view.innerHeight,
		scrollX: Math.round(view.scrollX),
		scrollY: Math.round(view.scrollY),
		devicePixelRatio: view.devicePixelRatio,
		capturedAt: now,
	};
}
