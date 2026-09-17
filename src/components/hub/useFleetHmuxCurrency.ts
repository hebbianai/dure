/**
 * Keeping every paired box's `hmux` current, without anybody pressing anything.
 *
 * # Why this exists
 *
 * A box whose `hmux` predates a feature cannot serve it, and says so in terms
 * that name the box rather than the fix: "이 상자의 hmux가 오래되어 …". The cure
 * already existed — `remote_hmux_provision` — but it lived only behind a manual
 * sweep inside the *mobile pairing wizard's* last step. Updating computers you
 * already paired is not the same job as pairing a new phone, and burying one
 * inside the other is how a person ends up with a box nobody ever updates.
 *
 * # Why not on every connection
 *
 * `plan_install` has no monotonicity: two laptops carrying different builds
 * would flip one shared box back and forth forever. So this runs at bounded
 * moments — when the app has a host set to work with, and again whenever that
 * set or this app's bundled build changes — never per connection.
 *
 * # What bounds it
 *
 * Main window only, a few boxes at a time after the panes have had the first
 * seconds of startup to themselves, and each pass is abandoned wholesale if
 * the inputs change under it. A box already running this build costs one SSH
 * round trip (`currency_probe`), which is what makes an unattended pass
 * affordable at all. A box carrying somebody's own hand-installed binary is
 * refused by the backend and left exactly as it is.
 */

import { useEffect, useRef } from "react";
import {
	FLEET_SWEEP_CONCURRENCY,
	FLEET_SWEEP_START_DELAY_MS,
	sweepFleet,
} from "@/lib/hub/fleetHmuxCurrencySweep";
import {
	prepareTrustedSshTarget,
	remoteHmuxProvision,
} from "@/lib/ipc/sessions";
import { isMainWindow } from "@/lib/workspace/window/windows";
import { useStore } from "@/store";

export function useFleetHmuxCurrency(): void {
	const sshHosts = useStore((state) => state.sshHosts);
	// Read once per pass rather than tracked: a host added mid-sweep would
	// otherwise restart it from the top and upload to the same box twice.
	const hosts = useRef(sshHosts);
	hosts.current = sshHosts;
	const generation = useRef(0);

	// The identity of the work, not of the render. Renaming a host or moving a
	// pane must not start a sweep; adding or removing one must.
	const fingerprint = sshHosts
		.map((host) => host.id)
		.sort()
		.join(",");

	useEffect(() => {
		if (!isMainWindow()) return;
		if (fingerprint === "") return;
		const mine = ++generation.current;
		const isCurrent = () => mine === generation.current;
		const timer = setTimeout(() => {
			if (!isCurrent()) return;
			void sweepFleet(
				hosts.current,
				async (host) => {
					const target = await prepareTrustedSshTarget(hosts.current, host.id);
					await remoteHmuxProvision(target);
				},
				{ concurrency: FLEET_SWEEP_CONCURRENCY, isCurrent },
			);
		}, FLEET_SWEEP_START_DELAY_MS);
		return () => {
			generation.current += 1;
			clearTimeout(timer);
		};
	}, [fingerprint]);
}
