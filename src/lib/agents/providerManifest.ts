import { PROVIDERS as CANONICAL_PROVIDERS } from "@/lib/agents/providerCatalog";

/**
 * @deprecated Import `PROVIDERS` from `@/types` instead. This facade preserves
 * object identity with the canonical provider catalog; it owns no registry.
 */
export const PROVIDERS = CANONICAL_PROVIDERS;
