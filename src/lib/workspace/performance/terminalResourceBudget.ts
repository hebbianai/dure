const MIB = 1024 * 1024;

/**
 * Conservative admission prices for terminal surfaces whose measured memory
 * is not available yet. Runtime observations replace these estimates.
 */
export const DEFAULT_TERMINAL_GPU_VIEWPORT_BYTES = 16 * MIB;
export const DEFAULT_TERMINAL_MODEL_BYTES = 44 * MIB;
export const PREWARM_TERMINAL_MODEL_BYTES = 8 * MIB;
export const TERMINAL_MODEL_FALLBACK_BUDGET_BYTES = 768 * MIB;
