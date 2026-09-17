export function normalizeBrowserAddress(input: string): string {
	const value = input.trim();
	if (!value) return "about:blank";
	if (/^[a-z]+:\/\//i.test(value) || value.startsWith("about:")) return value;
	if (/\s/.test(value) || !value.includes("."))
		return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
	return `https://${value}`;
}
