import type {
	MobileDeviceTarget,
	MobileFrame,
} from "@/lib/ipc/mobileSimulator";

/** Serialize worker ownership even when start finishes after the pane hides. */
export class MobileLiveObserver {
	private current?: {
		target: MobileDeviceTarget;
		publish: (frame: MobileFrame) => void;
		fail: (error: unknown) => void;
	};
	private running = false;
	constructor(
		private readonly native: {
			liveStart: (target: MobileDeviceTarget) => Promise<string>;
			liveFrame: (id: string) => Promise<MobileFrame | null>;
			liveStop: (id: string) => Promise<void>;
		},
	) {}
	observe(observation: NonNullable<MobileLiveObserver["current"]>) {
		this.current = observation;
		void this.next();
		return () => {
			if (this.current === observation) this.current = undefined;
		};
	}
	private async next() {
		if (this.running || !this.current) return;
		const observation = this.current;
		this.running = true;
		let id: string | undefined;
		try {
			id = await this.native.liveStart(observation.target);
			while (this.current === observation) {
				const frame = await this.native.liveFrame(id);
				if (this.current === observation && frame) observation.publish(frame);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		} catch (error) {
			if (this.current === observation) {
				this.current = undefined;
				observation.fail(error);
			}
		} finally {
			if (id) {
				try {
					await this.native.liveStop(id);
				} catch (error) {
					observation.fail(error);
					this.current = undefined;
				}
			}
			this.running = false;
			if (this.current) void this.next();
		}
	}
}
