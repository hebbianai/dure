import "../src/styles.css";
import {
	renderHomeScreen,
	type CensusActions,
	type CensusModel,
} from "../src/censusView";
import { saveHomeViewOptions } from "../src/homeViewPreferences";
import { preserveHomeScroll } from "../src/homeScroll";
import { attachPullToRefresh } from "../src/pullToRefresh";
import { createHomeFixture } from "./homeFixture";

let model: CensusModel = createHomeFixture();
const root = document.getElementById("home-qa")!;
function draw(): void {
	root.replaceChildren(renderHomeScreen(model, actions));
	const body = root.querySelector<HTMLElement>(".home__body")!;
	attachPullToRefresh(
		body,
		body.querySelector<HTMLElement>(".home__pull")!,
		actions.refresh,
		() => body.scrollTop,
	);
}
const actions: CensusActions = {
	open: (source) => {
		model = { ...model, opening: source.session.session_id };
		preserveHomeScroll(root, draw);
	},
	selectDesktop: (desktop) => {
		model = { ...model, desktop };
		draw();
	},
	pair: () => {},
	settings: () => {},
	hold: () => {},
	refresh: () => {
		model = { ...model, busy: !model.busy };
		preserveHomeScroll(root, draw);
	},
	viewMenu: (viewMenu) => {
		model = { ...model, viewMenu };
		preserveHomeScroll(root, draw);
	},
	changeView: (viewOptions) => {
		saveHomeViewOptions(viewOptions);
		model = {
			...model,
			viewOptions,
			desktop:
				model.viewOptions?.groupBy === viewOptions.groupBy
					? model.desktop
					: undefined,
		};
		preserveHomeScroll(root, draw);
	},
};
draw();
