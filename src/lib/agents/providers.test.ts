import { beforeEach, describe, expect, it } from "vitest";
import {
  accountProviders,
  agentAccount,
	loginCmd,
	providerLoginCmd,
  providerCmd,
	providerCredentialCapability,
	providerCredentialMigrationCmd,
	providerFreshManagedCmd,
  providerForkIdCmd,
  providerFromCommand,
	providerFromLegacyLaunchCommand,
	providerConversationForkStrategy,
	providerRecoveryResumeCmd,
	providerResumeIdCmd,
	providerRunCmd,
	providerSupportsConversationFork,
	providerSupportsConversationListing,
	providerSupportsExplicitResume,
  remoteAccountDir,
  remoteLoginCmd,
} from "@/lib/agents/providers";
import { useStore } from "@/store";
import { ConversationIdentityRequiredError } from "@/lib/agents/providerCredentials";
import { PROVIDER_IDS, PROVIDERS } from "@/lib/agents/providerCatalog";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { AccountProfile, Agent, Provider } from "@/types";

const work: AccountProfile = {
  id: "acc-work",
  provider: "codex",
  name: "work",
  dir: "/Users/me/.dure/accounts/codex-work",
};
const personal: AccountProfile = {
  id: "acc-personal",
  provider: "codex",
  name: "personal",
  dir: "/Users/me/.dure/accounts/codex-personal",
};

function agent(patch: Partial<Agent> = {}): Agent {
  return agentFixture({
    name: "codex",
    worktreePath: "/repo",
    branch: "main",
    sessionKind: "ssh",
    ...patch,
  });
}

beforeEach(() => {
  useStore.setState({
    accounts: [work, personal],
    activeAccounts: { codex: work.id },
    skipPermissions: {},
  });
});

describe("agentAccount", () => {
  it("Codex와 Claude adapter capability는 per-process overlay로 credential만 분리한다", () => {
    expect(providerCredentialCapability("codex")).toEqual({
			credentialSelection: "per_process_credential_overlay",
			stateRoot: "shared_canonical_overlay",
			environmentVariable: "CODEX_HOME",
			injectionMode: "per_process",
			concurrentDifferentCredentials: true,
		});
		expect(providerCredentialCapability("claude")).toEqual({
			credentialSelection: "per_process_credential_overlay",
			stateRoot: "shared_canonical_overlay",
			environmentVariable: "CLAUDE_CONFIG_DIR",
			injectionMode: "per_process",
			concurrentDifferentCredentials: true,
		});
  });

	it("Codex 전역 활성 계정을 에이전트가 따른다 (overlay adapter)", () => {
		expect(agentAccount(agent())).toEqual(work);
  });

  it("Codex pane 계정 선택은 전역 활성 계정을 이긴다", () => {
    expect(
      agentAccount(agent({ accountId: personal.id, credentialId: personal.id })),
    ).toEqual(personal);
  });

  it("committed execution profile은 stale compatibility 계정보다 우선한다", () => {
    expect(
      agentAccount(
        agent({
          accountId: work.id,
          credentialId: work.id,
          executionProfile: {
            kind: "credential_reference",
            reference_id: personal.id,
            credential_generation: "generation-2",
          },
        }),
      ),
    ).toEqual(personal);
  });

  it("committed provider default은 stale compatibility 계정을 되살리지 않는다", () => {
    expect(
      agentAccount(
        agent({
          accountId: personal.id,
          credentialId: personal.id,
          executionProfile: { kind: "provider_default" },
        }),
      ),
    ).toBeUndefined();
  });

  it("null은 '기본 계정' 고정 — 전역이 프로필을 가리켜도 따르지 않는다", () => {
    expect(agentAccount(agent({ accountId: null }))).toBeUndefined();
  });

  it("지워진 계정을 가리키면 기본 계정으로 떨어진다", () => {
    expect(
      agentAccount(agent({ provider: "claude", accountId: "acc-gone" })),
    ).toBeUndefined();
  });
});

describe("providerRunCmd — 원격(SSH)", () => {
  it("계정이 없어도 Codex startup update prompt를 비활성화한다", () => {
    expect(providerRunCmd("codex", {})).toBe(
      "codex -c check_for_update_on_startup=false",
    );
  });

  it("Codex overlay 계정은 원격 thin profile과 canonical SQLite state를 함께 쓴다", () => {
    expect(providerRunCmd("codex", { account: work })).toBe(
      'env CODEX_HOME="$HOME/.dure/accounts/codex-work" CODEX_SQLITE_HOME="$HOME/.codex" codex -c check_for_update_on_startup=false',
    );
  });

	it("Codex canonical 실행은 CODEX_HOME을 덮어쓰지 않고 위험 플래그 위치를 보존한다", () => {
    useStore.setState({ skipPermissions: { codex: true } });
		expect(providerRunCmd("codex", { resume: true })).toBe(
			"codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false resume --last",
    );
  });

	it("Codex conversation id는 credential과 독립이며 canonical home을 유지한다", () => {
		expect(providerRunCmd("codex", { convId: "conv-9" })).toBe(
			"codex -c check_for_update_on_startup=false resume conv-9",
    );
  });

  it("Claude overlay 계정은 원격 thin profile을 process-local로 쓴다", () => {
    const claude: AccountProfile = {
      id: "acc-claude",
      provider: "claude",
      name: "work",
      dir: "/Users/me/.dure/accounts/claude-work",
    };
    expect(providerRunCmd("claude", { resume: true, account: claude })).toBe(
      'env CLAUDE_CONFIG_DIR="$HOME/.dure/accounts/claude-work" claude --continue',
    );
  });
});

describe.each(["local", "ssh", "recovery"] as const)("exact resume: %s", (route) => {
	function resume(provider: Provider, conversationId: string): string {
		if (route === "local") return providerResumeIdCmd(provider, conversationId);
		if (route === "recovery") {
			return providerRecoveryResumeCmd(provider, conversationId);
		}
		return providerRunCmd(provider, { convId: conversationId, resume: true });
	}

	it.each(PROVIDER_IDS)("preserves the exact request or refuses %s", (provider) => {
		const conversationId = "conversation-selected";
		if (PROVIDERS[provider].resumeId) {
			expect(resume(provider, conversationId)).toContain(conversationId);
		} else {
			expect(() => resume(provider, conversationId)).toThrowError(
				expect.objectContaining({ code: "explicit_resume_unsupported", provider }),
			);
		}
	});

	it.each(["", "   "])("refuses an empty exact identity %j", (conversationId) => {
		expect(() => resume("codex", conversationId)).toThrow(
			"conversation_identity_required",
		);
	});
});

describe("managed fresh command", () => {
	it("uses the fenced permission posture instead of mutable store state", () => {
		useStore.setState({ skipPermissions: { codex: false } });
		expect(providerFreshManagedCmd("codex", "bypass_approvals")).toBe(
			"codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false",
		);
		useStore.setState({ skipPermissions: { codex: true } });
		expect(providerFreshManagedCmd("codex", "default")).toBe(
			"codex -c check_for_update_on_startup=false",
		);
	});

	it("검증된 provider 자동승인 플래그를 실행 파일 바로 뒤에 둔다", () => {
		expect(providerFreshManagedCmd("gemini", "bypass_approvals")).toBe(
			"gemini --approval-mode=yolo",
		);
		expect(providerFreshManagedCmd("opencode", "bypass_approvals")).toBe(
			"opencode --auto",
		);
		expect(providerFreshManagedCmd("grok", "bypass_approvals")).toBe(
			"grok --always-approve",
		);
		expect(providerFreshManagedCmd("copilot", "bypass_approvals")).toBe(
			"copilot --allow-all",
		);
		expect(providerFreshManagedCmd("cursor", "bypass_approvals")).toBe(
			"cursor-agent --force",
		);
	});
});

describe("명령을 다 모르는 에이전트", () => {
  it("검증된 provider는 workspace 최신 대화를 공식 명령으로 이어간다", () => {
    expect(providerRunCmd("gemini", { resume: true })).toBe(
      "gemini --resume latest",
    );
    expect(providerRunCmd("opencode", { resume: true })).toBe(
      "opencode --continue",
    );
    expect(providerRunCmd("pi", { resume: true })).toBe("pi --continue");
    expect(providerRunCmd("grok", { resume: true })).toBe("grok --continue");
    expect(providerRunCmd("copilot", { resume: true })).toBe(
      "copilot --continue",
    );
    expect(providerRunCmd("cursor", { resume: true })).toBe(
      "cursor-agent resume",
    );
  });

  it("검증된 provider는 provider-native id로 정확히 재개한다", () => {
    expect(providerRunCmd("gemini", { convId: "gemini-session-1" })).toBe(
      "gemini --resume gemini-session-1",
    );
    expect(providerRunCmd("opencode", { convId: "ses_opencode_1" })).toBe(
      "opencode --session ses_opencode_1",
    );
    expect(providerRunCmd("pi", { convId: "pi-session-1" })).toBe(
      "pi --session pi-session-1",
    );
    expect(providerRunCmd("grok", { convId: "grok-session-1" })).toBe(
      "grok --resume grok-session-1",
    );
    expect(providerRunCmd("copilot", { convId: "copilot-session-1" })).toBe(
      "copilot --resume=copilot-session-1",
    );
    expect(providerRunCmd("cursor", { convId: "cursor-session-1" })).toBe(
      "cursor-agent --resume=cursor-session-1",
    );
  });

  it("Amp 대화 id는 provider-native thread 명령으로 재개한다", () => {
    expect(providerRunCmd("amp", { convId: "conv-1" })).toBe(
      "amp threads continue conv-1",
    );
  });

  it("권한 플래그를 모르는 에이전트는 토글을 켜도 붙이지 않는다", () => {
    useStore.setState({ skipPermissions: { pi: true } });
    expect(providerRunCmd("pi", {})).toBe("pi");
  });

  it("계정 env가 없으면 계정을 넘겨도 디렉터리를 강제하지 않는다", () => {
    const account: AccountProfile = {
      id: "acc-x",
      provider: "gemini",
      name: "work",
      dir: "/Users/me/.dure/accounts/gemini-work",
    };
    expect(providerRunCmd("gemini", { account })).toBe("gemini");
    expect(providerCmd("gemini", false, account)).toBe("gemini");
  });

  it("계정 UI에는 per-process adapter(alias/overlay) 프로바이더만 올린다", () => {
		expect(accountProviders()).toEqual(["claude", "codex", "kimi"]);
  });
});

describe("로컬 명령과 원격 디렉터리", () => {
	it("Codex overlay 계정은 per-process CODEX_HOME으로 주입되고, 기본 계정은 canonical을 쓴다", () => {
		// 전역 활성 계정(work)이 있으면 overlay dir가 process env로 붙는다.
		const prefix = `env CODEX_HOME='${work.dir}' CODEX_SQLITE_HOME="$HOME/.codex" `;
		expect(providerCmd("codex", false)).toBe(
			`${prefix}codex -c check_for_update_on_startup=false`,
		);
		expect(providerResumeIdCmd("codex", "conv-1")).toBe(
			`${prefix}codex -c check_for_update_on_startup=false resume conv-1`,
		);
		// 기본 계정(null) 명시는 canonical CODEX_HOME 그대로.
		useStore.setState({ activeAccounts: {} });
		expect(providerCmd("codex", false)).toBe(
			"codex -c check_for_update_on_startup=false",
		);
		expect(providerResumeIdCmd("codex", "conv-1")).toBe(
			"codex -c check_for_update_on_startup=false resume conv-1",
		);
		expect(providerRunCmd("codex", { convId: "conv-1", fork: true })).toBe(
			"codex -c check_for_update_on_startup=false -C . fork conv-1",
		);
		expect(providerForkIdCmd("codex", "conv-1")).toBe(
			"codex -c check_for_update_on_startup=false -C . fork conv-1",
		);
	});

	it("복구 adapter는 explicit resume만 지원하고 latest 추론을 만들지 않는다", () => {
		useStore.setState({ activeAccounts: {} });
		expect(providerSupportsExplicitResume("codex")).toBe(true);
		expect(providerSupportsExplicitResume("gemini")).toBe(true);
		expect(providerSupportsExplicitResume("opencode")).toBe(true);
		expect(providerSupportsExplicitResume("pi")).toBe(true);
		expect(providerSupportsExplicitResume("grok")).toBe(true);
		expect(providerSupportsExplicitResume("copilot")).toBe(true);
		expect(providerSupportsExplicitResume("cursor")).toBe(true);
		expect(providerRecoveryResumeCmd("codex", "conv-1")).toBe(
			"codex -c check_for_update_on_startup=false resume conv-1",
		);
		expect(providerRecoveryResumeCmd("codex", "conv-1")).not.toContain("--last");
		expect(providerRecoveryResumeCmd("gemini", "conv-1")).toBe(
			"gemini --resume conv-1",
		);
		expect(providerRecoveryResumeCmd("opencode", "conv-1")).toBe(
			"opencode --session conv-1",
		);
		expect(providerRecoveryResumeCmd("pi", "conv-1")).toBe(
			"pi --session conv-1",
		);
		expect(providerRecoveryResumeCmd("grok", "conv-1")).toBe(
			"grok --resume conv-1",
		);
		expect(providerRecoveryResumeCmd("copilot", "conv-1")).toBe(
			"copilot --resume=conv-1",
		);
		expect(providerRecoveryResumeCmd("cursor", "conv-1")).toBe(
			"cursor-agent --resume=conv-1",
		);
	});

	it("대화 picker는 reviewed listing adapter가 있는 provider만 연다", () => {
		expect(providerSupportsConversationListing("claude")).toBe(true);
		expect(providerSupportsConversationListing("codex")).toBe(true);
		expect(providerSupportsConversationListing("gemini")).toBe(true);
		expect(providerSupportsConversationListing("opencode")).toBe(true);
		expect(providerSupportsConversationListing("pi")).toBe(true);
		expect(providerSupportsConversationListing("grok")).toBe(true);
		expect(providerSupportsConversationListing("cursor")).toBe(false);
		expect(providerSupportsConversationListing("copilot")).toBe(false);
	});

	it("exact resume와 cross-worktree fork capability를 구분한다", () => {
		expect(providerConversationForkStrategy("claude")).toBe("copy_and_flag");
		expect(providerConversationForkStrategy("codex")).toBe(
			"native_fork_generated",
		);
		expect(providerSupportsConversationFork("claude")).toBe(true);
		expect(providerSupportsConversationFork("codex")).toBe(true);
		expect(providerSupportsConversationFork("gemini")).toBe(false);
		expect(providerSupportsConversationFork("opencode")).toBe(false);
		expect(providerConversationForkStrategy("pi")).toBe("native_fork");
		expect(providerConversationForkStrategy("grok")).toBe("native_fork");
		expect(providerSupportsConversationFork("pi")).toBe(true);
		expect(providerSupportsConversationFork("grok")).toBe(true);
		expect(providerForkIdCmd("pi", "conv-1", "fork-1")).toBe(
			"pi --fork conv-1 --session-id fork-1",
		);
		expect(providerForkIdCmd("grok", "conv-1", "fork-1")).toBe(
			"grok --resume conv-1 --fork-session --session-id fork-1",
		);
		expect(() => providerForkIdCmd("pi", "conv-1")).toThrow(
			/fork_conversation_identity_required/,
		);
		expect(() => providerForkIdCmd("gemini", "conv-1")).toThrow(
			/no reviewed conversation fork adapter/,
		);
	});

	it("Codex 계정 로그인은 overlay dir를 CODEX_HOME으로 지정한다", () => {
		expect(loginCmd(work)).toBe(
			`env CODEX_HOME='${work.dir}' CODEX_SQLITE_HOME="$HOME/.codex" codex login`,
		);
	});

	it("system credential login uses the provider command without an overlay", () => {
		expect(providerLoginCmd("codex")).toBe("codex login");
	});

	it("crispy 전환은 overlay 계정으로 explicit-id 재개 명령을 만든다", () => {
		const original = agent({
			sessionKind: "pty",
			worktreePath: "/repo/worktree",
			credentialId: work.id,
			conversationId: "conversation-stable",
			runtimeBinding: managedBindingFixture({
				workspaceId: "project-1",
				createIdempotencyKey: "session-1",
				credentialId: work.id,
			}),
		});
		useStore.setState({ agents: [original] });

		// overlay는 세션을 canonical에 공유하므로 explicit id 재개로 계정을 옮긴다.
		expect(
			providerCredentialMigrationCmd(
				"codex",
				original.conversationId,
				personal,
				"local",
			),
		).toBe(
			`env CODEX_HOME='${personal.dir}' CODEX_SQLITE_HOME="$HOME/.codex" codex -c check_for_update_on_startup=false resume conversation-stable`,
		);
		// --last 추론은 여전히 금지 — conversation id가 없으면 거절.
		expect(() =>
			providerCredentialMigrationCmd("codex", null, personal, "local"),
		).toThrow(ConversationIdentityRequiredError);
	});

	it("credential migration은 explicit conversation id만 사용하고 --last로 추론하지 않는다", () => {
		const claude: AccountProfile = {
			id: "claude-crispy",
			provider: "claude",
			name: "crispy",
			dir: "/tmp/claude-crispy",
		};
		expect(
			providerCredentialMigrationCmd(
				"claude",
				"conversation-stable",
				claude,
				"local",
			),
		).toBe(
			"env CLAUDE_CONFIG_DIR='/tmp/claude-crispy' claude --resume conversation-stable",
		);
		expect(() =>
			providerCredentialMigrationCmd("claude", null, claude, "local"),
		).toThrow(ConversationIdentityRequiredError);
	});

	it("Claude/Kimi local aliases remain executable by the managed login shell", () => {
		const claude: AccountProfile = {
			id: "claude-work",
			provider: "claude",
			name: "work",
			dir: "/tmp/claude-work",
		};
		const kimi: AccountProfile = {
			id: "kimi-work",
			provider: "kimi",
			name: "work",
			dir: "/tmp/kimi-work",
		};
		expect(providerCmd("claude", false, claude)).toBe(
			"env CLAUDE_CONFIG_DIR='/tmp/claude-work' claude",
		);
		expect(providerCmd("kimi", true, kimi)).toBe(
			"env KIMI_CODE_HOME='/tmp/kimi-work' kimi --continue",
		);
  });

  it("원격 디렉터리는 로컬 디렉터리 이름을 그대로 재사용한다", () => {
    expect(remoteAccountDir(work)).toBe(".dure/accounts/codex-work");
  });

	it("uses device authentication in the selected remote Codex profile", () => {
		expect(remoteLoginCmd(work)).toBe(
			'env CODEX_HOME="$HOME/.dure/accounts/codex-work" CODEX_SQLITE_HOME="$HOME/.codex" codex login --device-auth',
		);
  });

  it("원격 profile slug가 provider 경계를 벗어나면 명령 조립부터 거절한다", () => {
    expect(() =>
      remoteAccountDir({ ...work, dir: "/tmp/claude-work" }),
    ).toThrow(/remote_credential_directory_untrusted/);
  });
});

describe("실행 파일 이름으로 프로바이더 찾기", () => {
  it("데몬이 돌려준 프로세스 이름을 프로바이더로 되돌린다", () => {
    expect(providerFromCommand("claude")).toBe("claude");
    expect(providerFromCommand("codex")).toBe("codex");
    // Antigravity CLI의 실행 파일은 `agy`다 — 화면 문구와 달리 스크롤에도 안 변한다.
    expect(providerFromCommand("agy")).toBe("antigravity");
  });

  it("절대경로로 와도 파일명만 본다", () => {
    expect(providerFromCommand("/Users/me/.local/bin/agy")).toBe("antigravity");
  });

  it("모르는 이름과 빈 값은 null", () => {
    expect(providerFromCommand("zsh")).toBeNull();
    expect(providerFromCommand("")).toBeNull();
    expect(providerFromCommand(null)).toBeNull();
  });

  it("구형 pane에서는 단순 provider 실행만 보수적으로 복구한다", () => {
    expect(providerFromLegacyLaunchCommand("codex --dangerously-bypass")).toBe(
      "codex",
    );
    expect(providerFromLegacyLaunchCommand("/opt/bin/claude --continue")).toBe(
      "claude",
    );
    expect(
      providerFromLegacyLaunchCommand("env CODEX_HOME=/tmp/work codex"),
    ).toBeNull();
    expect(providerFromLegacyLaunchCommand("codex | tee output")).toBeNull();
  });
});
