import { automations } from "./pt/automations";
import { onboardingImportEnglishFallback } from "./onboardingImportEnglishFallback";
import { notificationDeliveryTranslations } from "./notificationDeliveryTranslations";
import { agentsSessions } from "./pt/agentsSessions";
import { common } from "./pt/common";
import { interactions } from "./pt/interactions";
import { legacy } from "./pt/legacy";
import { onboarding } from "./pt/onboarding";
import { settings } from "./pt/settings";
import { sourceControl } from "./pt/sourceControl";
import { terminal } from "./pt/terminal";
import { workspace } from "./pt/workspace";
import { agents } from "./pt/agents";
import { sessions } from "./pt/sessions";
import { plugins } from "./pt/plugins";
import { panels } from "./pt/panels";
import { usage } from "./pt/usage";
import { spaces } from "./pt/spaces";
import { sidebar } from "./pt/sidebar";
import { ssh } from "./pt/ssh";
import { design } from "./pt/design";
import { workflows } from "./pt/workflows";
import { search } from "./pt/search";
import { app } from "./pt/app";
import { ipc } from "./pt/ipc";
import { hmux } from "./pt/hmux";
import { theme } from "./pt/theme";
import { files } from "./pt/files";
import { github } from "./pt/github";
import { feedback } from "./pt/feedback";
import { platform } from "./pt/platform";
import { updates } from "./pt/updates";
import { persistence } from "./pt/persistence";
import { cli } from "./pt/cli";

// pt 사전 — en/과 같은 조각 구조. 클러스터별 이관 에이전트가 자기 조각만 소유한다.
export const pt: Record<string, string> = {
	...onboardingImportEnglishFallback,
	...notificationDeliveryTranslations.pt,
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
