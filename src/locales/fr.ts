import { automations } from "./fr/automations";
import { onboardingImportEnglishFallback } from "./onboardingImportEnglishFallback";
import { notificationDeliveryTranslations } from "./notificationDeliveryTranslations";
import { agentsSessions } from "./fr/agentsSessions";
import { common } from "./fr/common";
import { interactions } from "./fr/interactions";
import { legacy } from "./fr/legacy";
import { onboarding } from "./fr/onboarding";
import { settings } from "./fr/settings";
import { sourceControl } from "./fr/sourceControl";
import { terminal } from "./fr/terminal";
import { workspace } from "./fr/workspace";
import { agents } from "./fr/agents";
import { sessions } from "./fr/sessions";
import { plugins } from "./fr/plugins";
import { panels } from "./fr/panels";
import { usage } from "./fr/usage";
import { spaces } from "./fr/spaces";
import { sidebar } from "./fr/sidebar";
import { ssh } from "./fr/ssh";
import { design } from "./fr/design";
import { workflows } from "./fr/workflows";
import { search } from "./fr/search";
import { app } from "./fr/app";
import { ipc } from "./fr/ipc";
import { hmux } from "./fr/hmux";
import { theme } from "./fr/theme";
import { files } from "./fr/files";
import { github } from "./fr/github";
import { feedback } from "./fr/feedback";
import { platform } from "./fr/platform";
import { updates } from "./fr/updates";
import { persistence } from "./fr/persistence";
import { cli } from "./fr/cli";

// fr 사전 — en/과 같은 조각 구조. 클러스터별 이관 에이전트가 자기 조각만 소유한다.
export const fr: Record<string, string> = {
	...onboardingImportEnglishFallback,
	...notificationDeliveryTranslations.fr,
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
