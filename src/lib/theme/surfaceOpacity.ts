/**
 * Fixed background opacity by appearance, selected after the temporary slider
 * trial. Pane bodies, headers, sheets and terminals share this alpha through
 * --surface-alpha; text remains opaque. Theme tint compensation uses the same
 * pair so the painted alpha and its chroma gain stay in sync.
 */
export const SURFACE_OPACITY = { light: 65, dark: 85 } as const;
