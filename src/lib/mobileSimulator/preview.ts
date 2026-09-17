import type {
	MobileDeviceTarget,
	MobileFrame,
} from "@/lib/mobileSimulator/types";

export function readMobileDeviceTarget(
	value: unknown,
): MobileDeviceTarget | null {
	if (!value || typeof value !== "object") return null;
	const target = value as Partial<MobileDeviceTarget>;
	if (
		(target.platform !== "ios" && target.platform !== "android") ||
		typeof target.id !== "string" ||
		!target.id
	)
		return null;
	return { platform: target.platform, id: target.id };
}

export function mobileDeviceKey(target: MobileDeviceTarget): string {
	return `${target.platform}:${target.id}`;
}

interface FrameObservation {
	target: MobileDeviceTarget;
	publish: (frame: MobileFrame) => void;
	fail: (error: unknown) => void;
	repeat: boolean;
}

/** One native read per pane, including across selection and visibility changes.
 * SDK requests already in flight finish within their native timeout; only the
 * latest visible selection may publish or start the next read. */
export class MobileFrameObserver {
	private generation = 0;
	private observation: FrameObservation | undefined;
	private running = false;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly capture: (
			target: MobileDeviceTarget,
		) => Promise<MobileFrame>,
	) {}

	observe(observation: FrameObservation): () => void {
		const generation = ++this.generation;
		clearTimeout(this.timer);
		this.observation = observation;
		void this.next();
		return () => {
			if (generation !== this.generation) return;
			this.generation++;
			this.observation = undefined;
			clearTimeout(this.timer);
		};
	}

	private async next() {
		if (this.running || !this.observation) return;
		const observation = this.observation;
		const generation = this.generation;
		this.running = true;
		try {
			const frame = await this.capture(observation.target);
			if (generation !== this.generation) return;
			observation.publish(frame);
			if (observation.repeat)
				this.timer = setTimeout(() => void this.next(), 1000);
		} catch (error) {
			if (generation === this.generation) observation.fail(error);
		} finally {
			this.running = false;
			if (generation !== this.generation && this.observation) void this.next();
		}
	}
}

export function mobileFramePoint(
	rect: { left: number; top: number; width: number; height: number },
	x: number,
	y: number,
) {
	if (rect.width <= 0 || rect.height <= 0) return null;
	const point = {
		x: (x - rect.left) / rect.width,
		y: (y - rect.top) / rect.height,
	};
	return Number.isFinite(point.x) &&
		Number.isFinite(point.y) &&
		point.x >= 0 &&
		point.x <= 1 &&
		point.y >= 0 &&
		point.y <= 1
		? point
		: null;
}
