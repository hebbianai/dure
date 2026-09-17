import { getCurrentWindow } from "@tauri-apps/api/window";
import { POPOUT_RESIZE_HANDLES } from "@/lib/workspace/window/popoutWindowGeometry";
import { cn } from "@/lib/utils";

/** The transparent macOS frame has a very narrow native resize boundary. These
 * handles begin the same native resize operation from a forgiving inner area. */
export function PopoutResizeHandles() {
  return (
    <>
      {POPOUT_RESIZE_HANDLES.map((handle) => (
        <div
          key={handle.direction}
          aria-hidden="true"
          data-popout-resize-direction={handle.direction}
          className={cn("z-[1000] touch-none select-none", handle.className)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            void getCurrentWindow().startResizeDragging(handle.direction);
          }}
        />
      ))}
    </>
  );
}
