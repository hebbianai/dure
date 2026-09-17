import { automations } from "./zh/automations";
import { onboardingImportEnglishFallback } from "./onboardingImportEnglishFallback";
import { notificationDeliveryTranslations } from "./notificationDeliveryTranslations";
import { agentsSessions } from "./zh/agentsSessions";
import { common } from "./zh/common";
import { interactions } from "./zh/interactions";
import { legacy } from "./zh/legacy";
import { onboarding } from "./zh/onboarding";
import { settings } from "./zh/settings";
import { sourceControl } from "./zh/sourceControl";
import { terminal } from "./zh/terminal";
import { workspace } from "./zh/workspace";
import { agents } from "./zh/agents";
import { sessions } from "./zh/sessions";
import { plugins } from "./zh/plugins";
import { panels } from "./zh/panels";
import { usage } from "./zh/usage";
import { spaces } from "./zh/spaces";
import { sidebar } from "./zh/sidebar";
import { ssh } from "./zh/ssh";
import { design } from "./zh/design";
import { workflows } from "./zh/workflows";
import { search } from "./zh/search";
import { app } from "./zh/app";
import { ipc } from "./zh/ipc";
import { hmux } from "./zh/hmux";
import { theme } from "./zh/theme";
import { files } from "./zh/files";
import { github } from "./zh/github";
import { feedback } from "./zh/feedback";
import { platform } from "./zh/platform";
import { updates } from "./zh/updates";
import { persistence } from "./zh/persistence";
import { cli } from "./zh/cli";

// zh 사전 — en/과 같은 조각 구조. 클러스터별 이관 에이전트가 자기 조각만 소유한다.
export const zh: Record<string, string> = {
	...onboardingImportEnglishFallback,
	...notificationDeliveryTranslations.zh,
	...agentsSessions,
	...common,
	...interactions,
	...legacy,
	...onboarding,
	...settings,
	...sourceControl,
	...terminal,
	...workspace,
	...agents,
	...sessions,
	...plugins,
	...panels,
	...usage,
	...spaces,
	...sidebar,
	...automations,
	...ssh,
	...design,
	...workflows,
	...search,
	...app,
	...ipc,
	...hmux,
	...theme,
	...files,
	...github,
	...feedback,
	...platform,
	...updates,
	...persistence,
	...cli,
};
