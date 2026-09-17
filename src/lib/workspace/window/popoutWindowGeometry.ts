export const POPOUT_WINDOW_GEOMETRY = {
  width: 1200,
  height: 820,
  minWidth: 480,
  minHeight: 320,
} as const;

type PopoutResizeDirection =
  | "North"
  | "NorthEast"
  | "East"
  | "SouthEast"
  | "South"
  | "SouthWest"
  | "West"
  | "NorthWest";

export interface PopoutResizeHandle {
  direction: PopoutResizeDirection;
  className: string;
}

/** Transparent in-content handles widen the native window resize target. Edges
 * use 8px and corners use 16px so a terminal cell beside the frame stays usable. */
export const POPOUT_RESIZE_HANDLES: readonly PopoutResizeHandle[] = [
  { direction: "North", className: "fixed top-0 right-4 left-4 h-2 cursor-n-resize" },
  { direction: "NorthEast", className: "fixed top-0 right-0 size-4 cursor-ne-resize" },
  { direction: "East", className: "fixed top-4 right-0 bottom-4 w-2 cursor-e-resize" },
  { direction: "SouthEast", className: "fixed right-0 bottom-0 size-4 cursor-se-resize" },
  { direction: "South", className: "fixed right-4 bottom-0 left-4 h-2 cursor-s-resize" },
  { direction: "SouthWest", className: "fixed bottom-0 left-0 size-4 cursor-sw-resize" },
  { direction: "West", className: "fixed top-4 bottom-4 left-0 w-2 cursor-w-resize" },
  { direction: "NorthWest", className: "fixed top-0 left-0 size-4 cursor-nw-resize" },
];
