type TerminalResizeRenderBuffer = "alternate" | "normal";

export interface TerminalResizeRenderObservation {
	provider: string;
	buffer: TerminalResizeRenderBuffer;
	generation: number;
	reportedColumns: number;
	reportedRows: number;
	terminalColumns: number;
	terminalRows: number;
	dimensionsMatch: boolean;
	footerVisible: boolean;
}

interface ObservationInput {
	lines: readonly string[];
	buffer: TerminalResizeRenderBuffer;
	columns: number;
	rows: number;
}

const HEADER =
	/DURE_RESIZE_QA_([A-Z][A-Z0-9_]{0,23})_R([0-9]+)_C([0-9]+)_G([0-9]+)/;

export function terminalResizeRenderObservation({
	lines,
	buffer,
	columns,
	rows,
}: ObservationInput): TerminalResizeRenderObservation | undefined {
	let latest:
		| {
				provider: string;
				reportedRows: number;
				reportedColumns: number;
				generation: number;
		  }
		| undefined;

	for (const line of lines) {
		const match = HEADER.exec(line);
		if (!match) continue;
		const candidate = {
			provider: match[1].toLowerCase(),
			reportedRows: Number(match[2]),
			reportedColumns: Number(match[3]),
			generation: Number(match[4]),
		};
		if (!latest || candidate.generation > latest.generation) latest = candidate;
	}
	if (!latest) return undefined;

	const footer = `DURE_RESIZE_QA_FOOTER_${latest.provider.toUpperCase()}_G${latest.generation}`;
	return {
		provider: latest.provider,
		buffer,
		generation: latest.generation,
		reportedColumns: latest.reportedColumns,
		reportedRows: latest.reportedRows,
		terminalColumns: columns,
		terminalRows: rows,
		dimensionsMatch:
			latest.reportedColumns === columns && latest.reportedRows === rows,
		footerVisible: lines.some((line) => line.includes(footer)),
	};
}
