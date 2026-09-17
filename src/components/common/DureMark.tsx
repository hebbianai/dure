import { DURE_MARK_PATHS, DURE_MARK_VIEW_BOX } from "@/lib/ui/dureMark";

/** The Dure brand mark. Fill rides currentColor so one component serves light
 *  and dark; the geometry lives in lib/ui/dureMark next to its canvas twin. */
export function DureMark({ className }: { className?: string }) {
	return (
		<svg
			viewBox={DURE_MARK_VIEW_BOX}
			fill="none"
			aria-hidden
			className={className}
		>
			{DURE_MARK_PATHS.map((d) => (
				<path key={d.slice(0, 24)} d={d} fill="currentColor" />
			))}
		</svg>
	);
}
