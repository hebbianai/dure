import { resolveLang } from "@/lib/i18n";
import { useStore } from "@/store";

/**
 * The app's currently resolved display language, for the envelope's
 * `locale` field.
 *
 * This is the feedback cluster's one designated `@/store` coupling point —
 * the architecture fitness gate's `componentStoreCoupling` rule requires new
 * components to read the store through a cluster hook rather than directly.
 */
export function useFeedbackLocale(): string {
	return useStore((s) => resolveLang(s.language));
}
