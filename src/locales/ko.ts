import { automations } from "./ko/automations";
import { common } from "@/locales/ko/common";
import { interactions } from "@/locales/ko/interactions";
import { terminal } from "@/locales/ko/terminal";
import { agents } from "@/locales/ko/agents";
import { sessions } from "@/locales/ko/sessions";
import { plugins } from "@/locales/ko/plugins";
import { panels } from "@/locales/ko/panels";
import { usage } from "@/locales/ko/usage";
import { spaces } from "@/locales/ko/spaces";
import { sidebar } from "@/locales/ko/sidebar";
import { ssh } from "@/locales/ko/ssh";
import { design } from "@/locales/ko/design";
import { workflows } from "@/locales/ko/workflows";
import { search } from "@/locales/ko/search";
import { app } from "@/locales/ko/app";
import { ipc } from "@/locales/ko/ipc";
import { hmux } from "@/locales/ko/hmux";
import { theme } from "@/locales/ko/theme";
import { files } from "@/locales/ko/files";
import { github } from "@/locales/ko/github";
import { feedback } from "@/locales/ko/feedback";
import { platform } from "@/locales/ko/platform";
import { updates } from "@/locales/ko/updates";
import { persistence } from "@/locales/ko/persistence";
import { cli } from "@/locales/ko/cli";
import { workspace } from "@/locales/ko/workspace";
import { sourceControl } from "@/locales/ko/sourceControl";
import { onboarding } from "@/locales/ko/onboarding";
import { settings } from "@/locales/ko/settings";
import { agentsSessions } from "@/locales/ko/agentsSessions";
import { legacy } from "@/locales/ko/legacy";

/** 명시적 한국어 카탈로그 — semantic ID 키만 담는다. legacy 한국어-문장
 *  키는 원문 자체가 표시라 여기 실리지 않는다(i18n.ts 머리말). */
export const ko: Record<string, string> = {
	...common,
	...interactions,
	...terminal,
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
	...workspace,
	...sourceControl,
	...onboarding,
	...settings,
	...agentsSessions,
	...legacy,
};
