// 이미지 pane 본문 — 줌/팬. 판정은 src/lib/imageZoom.ts (VS Code 관례:
// ⌘/Ctrl+휠·핀치 줌, 일반 휠 팬, 더블클릭 맞춤↔100%, 버튼 이산 스텝).
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { Titled } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";
import {
	clampZoom,
	fitScale,
	stepZoom,
	wheelZoom,
} from "@/lib/files/imageZoom";

/** "fit"이면 컨테이너 맞춤(기본), 숫자면 원본 대비 배율. */
type ZoomState = "fit" | number;

function ToolbarButton({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		// Pixel-preserving overrides: 4px corners + glass hover on the glass tray.
		<IconButton
			className="rounded hover:bg-glass-tint-hover"
			title={label}
			onClick={onClick}
		>
			{children}
		</IconButton>
	);
}

export function ImageViewerBody({ src, name }: { src: string; name: string }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const imageRef = useRef<HTMLImageElement>(null);
	const [zoom, setZoom] = useState<ZoomState>("fit");
	const [natural, setNatural] = useState<{ w: number; h: number }>();

	/** 이벤트 시점의 실제 배율 — fit 상태에서도 줌 시작점이 자연스럽다. */
	const currentScale = () => {
		if (typeof zoom === "number") return zoom;
		const box = containerRef.current?.getBoundingClientRect();
		if (!box || !natural) return 1;
		return fitScale(natural.w, natural.h, box.width, box.height);
	};

	// React의 위임 wheel 리스너는 preventDefault를 보장하지 않는다 —
	// 핀치 줌이 페이지 줌으로 새지 않게 non-passive로 직접 단다.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const onWheel = (event: WheelEvent) => {
			if (!(event.ctrlKey || event.metaKey)) return;
			event.preventDefault();
			setZoom((previous) => {
				const base =
					typeof previous === "number" ? previous : currentScale();
				return wheelZoom(base, event.deltaY);
			});
		};
		container.addEventListener("wheel", onWheel, { passive: false });
		return () => container.removeEventListener("wheel", onWheel);
	});

	const zoomed = typeof zoom === "number";
	const percent = Math.round(currentScale() * 100);

	return (
		<div className="relative h-full">
			<div
				ref={containerRef}
				className={
					zoomed
						? "h-full overflow-auto"
						: "flex h-full items-center justify-center overflow-hidden p-4"
				}
				onDoubleClick={() => setZoom((previous) => (previous === "fit" ? 1 : "fit"))}
			>
				<img
					ref={imageRef}
					src={src}
					alt={name}
					draggable={false}
					onLoad={(event) => {
						const img = event.currentTarget;
						setNatural({ w: img.naturalWidth, h: img.naturalHeight });
					}}
					className={zoomed ? "max-w-none" : "max-h-full max-w-full object-contain"}
					style={
						zoomed && natural
							? { width: natural.w * clampZoom(zoom), height: natural.h * clampZoom(zoom) }
							: undefined
					}
				/>
			</div>
			<div className="absolute right-2 bottom-2 flex items-center gap-0.5 rounded-md border border-glass-pane-border bg-glass-pane/90 px-1 py-0.5 shadow-pane-light backdrop-blur">
				<ToolbarButton
					label={t("panels.imageViewer.zoomOut")}
					onClick={() => setZoom(stepZoom(currentScale(), -1))}
				>
					<ZoomOut className="size-3.5" />
				</ToolbarButton>
				<Titled title={t("panels.imageViewer.actualSize")}>
					<button
						type="button"
						className="min-w-11 rounded px-1 text-center text-[10px] tabular-nums text-muted-foreground hover:bg-glass-tint-hover hover:text-foreground"
						onClick={() => setZoom(1)}
					>
						{percent}%
					</button>
				</Titled>
				<ToolbarButton
					label={t("panels.imageViewer.zoomIn")}
					onClick={() => setZoom(stepZoom(currentScale(), 1))}
				>
					<ZoomIn className="size-3.5" />
				</ToolbarButton>
				<ToolbarButton label={t("panels.imageViewer.fitToWindow")} onClick={() => setZoom("fit")}>
					<Maximize className="size-3.5" />
				</ToolbarButton>
			</div>
		</div>
	);
}
