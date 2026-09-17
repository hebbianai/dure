import { automations } from "./es/automations";
import { onboardingImportEnglishFallback } from "./onboardingImportEnglishFallback";
import { notificationDeliveryTranslations } from "./notificationDeliveryTranslations";
import { agentsSessions } from "./es/agentsSessions";
import { common } from "./es/common";
import { interactions } from "./es/interactions";
import { legacy } from "./es/legacy";
import { onboarding } from "./es/onboarding";
import { settings } from "./es/settings";
import { sourceControl } from "./es/sourceControl";
import { terminal } from "./es/terminal";
import { workspace } from "./es/workspace";
import { agents } from "./es/agents";
import { sessions } from "./es/sessions";
import { plugins } from "./es/plugins";
import { panels } from "./es/panels";
import { usage } from "./es/usage";
import { spaces } from "./es/spaces";
import { sidebar } from "./es/sidebar";
import { ssh } from "./es/ssh";
import { design } from "./es/design";
import { workflows } from "./es/workflows";
import { search } from "./es/search";
import { app } from "./es/app";
import { ipc } from "./es/ipc";
import { hmux } from "./es/hmux";
import { theme } from "./es/theme";
import { files } from "./es/files";
import { github } from "./es/github";
import { feedback } from "./es/feedback";
import { platform } from "./es/platform";
import { updates } from "./es/updates";
import { persistence } from "./es/persistence";
import { cli } from "./es/cli";

// es 사전 — en/과 같은 조각 구조. 클러스터별 이관 에이전트가 자기 조각만 소유한다.
export const es: Record<string, string> = {
	...onboardingImportEnglishFallback,
	...notificationDeliveryTranslations.es,
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
