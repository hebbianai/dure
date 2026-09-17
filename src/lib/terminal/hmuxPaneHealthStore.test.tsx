// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearHmuxPaneHealth,
	getHmuxPaneHealth,
	publishHmuxPaneHealthObservation,
	useHmuxPaneHealthPresentation,
} from "@/lib/terminal/hmuxPaneHealthStore";

const paneHealthId = "desktop-health-store:term:one";

afterEach(() => clearHmuxPaneHealth(paneHealthId));

describe("Hmux pane health store", () => {
	it("advances exact frame high-waters without republishing live chrome", () => {
		let renders = 0;
		const { result } = renderHook(() => {
			renders += 1;
			return useHmuxPaneHealthPresentation(paneHealthId);
		});

		act(() => {
			publishHmuxPaneHealthObservation(
				paneHealthId,
				{
					kind: "frame_received",
					terminalEpoch: "epoch-one",
					sequence: "41",
				},
				10,
			);
		});
		const livePresentation = result.current;
		expect(livePresentation).toMatchObject({
			state: "live",
			terminalEpoch: "epoch-one",
			receivedSequence: undefined,
			presentedSequence: undefined,
		});
		expect(renders).toBe(2);

		act(() => {
			publishHmuxPaneHealthObservation(
				paneHealthId,
				{
					kind: "frame_presented",
					terminalEpoch: "epoch-one",
					sequence: "41",
				},
				11,
			);
			publishHmuxPaneHealthObservation(
				paneHealthId,
				{
					kind: "frame_received",
					terminalEpoch: "epoch-one",
					sequence: "42",
				},
				12,
			);
		});

		expect(result.current).toBe(livePresentation);
		expect(renders).toBe(2);
		expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
			state: "live",
			terminalEpoch: "epoch-one",
			receivedSequence: "42",
			presentedSequence: "41",
			updatedAt: 12,
		});
	});

	it("publishes connection transitions and treats duplicates as no-ops", () => {
		publishHmuxPaneHealthObservation(
			paneHealthId,
			{
				kind: "frame_presented",
				terminalEpoch: "epoch-two",
				sequence: "7",
			},
			20,
		);
		const { result } = renderHook(() =>
			useHmuxPaneHealthPresentation(paneHealthId),
		);

		act(() => {
			publishHmuxPaneHealthObservation(
				paneHealthId,
				{
					kind: "connection",
					state: "recovering",
					reason: "transport_closed",
				},
				21,
			);
		});
		const recovering = getHmuxPaneHealth(paneHealthId);
		expect(result.current).toMatchObject({
			state: "recovering",
			reason: "transport_closed",
			terminalEpoch: "epoch-two",
			receivedSequence: "7",
			presentedSequence: "7",
		});

		act(() => {
			publishHmuxPaneHealthObservation(
				paneHealthId,
				{
					kind: "connection",
					state: "recovering",
					reason: "transport_closed",
				},
				99,
			);
		});

		expect(getHmuxPaneHealth(paneHealthId)).toBe(recovering);
		expect(getHmuxPaneHealth(paneHealthId)?.updatedAt).toBe(21);
	});

	it("clears the exact and projected record together", () => {
		publishHmuxPaneHealthObservation(paneHealthId, {
			kind: "connection",
			state: "connecting",
		});
		const { result } = renderHook(() =>
			useHmuxPaneHealthPresentation(paneHealthId),
		);
		expect(result.current?.state).toBe("connecting");

		act(() => clearHmuxPaneHealth(paneHealthId));

		expect(result.current).toBeUndefined();
		expect(getHmuxPaneHealth(paneHealthId)).toBeUndefined();
	});
});
