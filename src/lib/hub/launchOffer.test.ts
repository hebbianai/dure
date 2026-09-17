import { describe, expect, it } from "vitest";
import type { Project, Space } from "@/types";
import {
	buildLaunchOffer,
	launchTargetId,
	seatOfLaunchTarget,
} from "./launchOffer";

function space(id: string, name: string, kind?: "popout"): Space {
	return { id, name, ...(kind ? { kind } : {}) } as Space;
}

function project(
	id: string,
	name: string,
	kind: Project["kind"] = "local",
): Project {
	return { id, name, path: `~/dev/${name}`, kind, isRepo: true } as Project;
}

const boxLabel = (p: Project) => (p.kind === "ssh" ? "vps-1" : "mac-mini");

describe("buildLaunchOffer", () => {
	/**
	 * "Start an agent in HebbianIDE" is not a complete instruction — it does not
	 * say which space. So a target is a seat: one space and one project.
	 */
	it("offers one target per space-and-folder pair", () => {
		const offer = buildLaunchOffer({
			spaces: [space("s1", "Main"), space("s2", "Onchain")],
			projects: [project("p1", "HebbianIDE")],
			kinds: [],
			installedKinds: [],
			boxLabel,
		});

		expect(offer.targets.map((t) => t.id)).toEqual(["s1 p1", "s2 p1"]);
		expect(offer.targets[0]?.space_label).toBe("Main");
		expect(offer.targets[1]?.space_label).toBe("Onchain");
	});

	/**
	 * The phone may hold an offer across a laptop restart. A fresh id each
	 * publish would turn a stale press into "that place is gone" for a place
	 * that never moved.
	 */
	it("names the same seat the same way every time", () => {
		const once = buildLaunchOffer({
			spaces: [space("s1", "Main")],
			projects: [project("p1", "HebbianIDE")],
			kinds: [],
			installedKinds: [],
			boxLabel,
		});
		const again = buildLaunchOffer({
			spaces: [space("s1", "Main")],
			projects: [project("p1", "HebbianIDE")],
			kinds: [],
			installedKinds: [],
			boxLabel,
		});

		expect(once.targets[0]?.id).toBe(again.targets[0]?.id);
		expect(seatOfLaunchTarget(launchTargetId("s1", "p1"))).toEqual({
			spaceId: "s1",
			projectId: "p1",
		});
	});

	/**
	 * A folder whose SSH host is no longer registered is carried and refused,
	 * not hidden or silently reassigned to another available host.
	 */
	it("carries a remote folder without a registered host as unstartable", () => {
		const offer = buildLaunchOffer({
			spaces: [space("s1", "Main")],
			projects: [project("p1", "HebbianIDE"), project("p2", "dure-app", "ssh")],
			kinds: [],
			installedKinds: [],
			boxLabel,
		});

		expect(offer.targets.map((t) => [t.folder_label, t.startable])).toEqual([
			["HebbianIDE", true],
			["dure-app", false],
		]);
		// Both say which machine they sit on — that is where the refusal's reason is.
		expect(offer.targets[1]?.box_label).toBe("vps-1");
	});

	/**
	 * A popout is the same space seen in another window. Offered twice, the
	 * person sees one place as two with no way to tell them apart.
	 */
	it("does not offer a popout space as a second seat", () => {
		const offer = buildLaunchOffer({
			spaces: [space("s1", "Main"), space("s2", "Main", "popout")],
			projects: [project("p1", "HebbianIDE")],
			kinds: [],
			installedKinds: [],
			boxLabel,
		});

		expect(offer.targets).toHaveLength(1);
	});

	/**
	 * The desk's menu keeps the core agents listed whether or not they are on
	 * this machine, so somebody can find out they need to install one. The
	 * phone gets the same list with the same fact attached — dropping the
	 * missing ones would leave a person wondering where Codex went.
	 */
	it("carries an agent this machine does not have, marked as missing", () => {
		const offer = buildLaunchOffer({
			spaces: [],
			projects: [],
			kinds: ["claude", "codex"],
			installedKinds: ["claude"],
			boxLabel,
		});

		expect(offer.kinds).toEqual([
			{ id: "claude", label: "Claude Code", installed: true },
			{ id: "codex", label: "Codex", installed: false },
		]);
	});
});
