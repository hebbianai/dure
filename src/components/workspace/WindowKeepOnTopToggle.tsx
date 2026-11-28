import { PictureInPicture2 } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useWindowKeepOnTop } from "@/lib/workspace/window/useWindowKeepOnTop";
import { useCurrentWindowFullscreen } from "@/lib/workspace/window/windowShellShape";

/**
 * Chrome-strip toggle that keeps this window above other apps' windows on its
 * own desktop. A full-screen window has nothing to stay above, so the toggle
 * steps aside until the window leaves full screen. The label stays the same
 * in both states; `aria-pressed` and the pressed tint carry the state.
 */
export function WindowKeepOnTopToggle({ className }: { className?: string }) {
	const fullscreen = useCurrentWindowFullscreen();
	const { keepOnTop, toggle } = useWindowKeepOnTop();
	if (fullscreen) return null;
	return (
		<IconButton
			title={t("workspace.window.keepOnTop")}
			pressed={keepOnTop}
			className={cn("shrink-0", className)}
			onClick={toggle}
		>
			<PictureInPicture2 />
		</IconButton>
	);
}
