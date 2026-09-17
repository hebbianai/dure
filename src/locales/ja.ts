import { automations } from "./ja/automations";
import { onboardingImportEnglishFallback } from "./onboardingImportEnglishFallback";
import { notificationDeliveryTranslations } from "./notificationDeliveryTranslations";
import { agentsSessions } from "./ja/agentsSessions";
import { common } from "./ja/common";
import { interactions } from "./ja/interactions";
import { legacy } from "./ja/legacy";
import { onboarding } from "./ja/onboarding";
import { settings } from "./ja/settings";
import { sourceControl } from "./ja/sourceControl";
import { terminal } from "./ja/terminal";
import { workspace } from "./ja/workspace";
import { agents } from "./ja/agents";
import { sessions } from "./ja/sessions";
import { plugins } from "./ja/plugins";
import { panels } from "./ja/panels";
import { usage } from "./ja/usage";
import { spaces } from "./ja/spaces";
import { sidebar } from "./ja/sidebar";
import { ssh } from "./ja/ssh";
import { design } from "./ja/design";
import { workflows } from "./ja/workflows";
import { search } from "./ja/search";
import { app } from "./ja/app";
import { ipc } from "./ja/ipc";
import { hmux } from "./ja/hmux";
import { theme } from "./ja/theme";
import { files } from "./ja/files";
import { github } from "./ja/github";
import { feedback } from "./ja/feedback";
import { platform } from "./ja/platform";
import { updates } from "./ja/updates";
import { persistence } from "./ja/persistence";
import { cli } from "./ja/cli";

// ja 사전 — en/과 같은 조각 구조. 클러스터별 이관 에이전트가 자기 조각만 소유한다.
export const ja: Record<string, string> = {
	...onboardingImportEnglishFallback,
	...notificationDeliveryTranslations.ja,
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
