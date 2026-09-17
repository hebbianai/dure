use hebbian_process_sampler::{
    AgentProvider as SampledAgentProvider, SharedProcessSampler, foreground_process_argv,
    process_cwd, ssh_target_from_argv,
};
use hmux_host::local_protocol::AgentProvider;
use hmux_host::terminal_replay::ExecutionLocationObservation;

const MAX_CWD_BYTES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeIdentity {
    pub cwd: Option<String>,
    pub agent: Option<AgentProvider>,
    pub execution_location: Option<ExecutionLocationObservation>,
}

pub fn inspect(root_pid: u32, sampler: &SharedProcessSampler) -> Option<RuntimeIdentity> {
    if root_pid == 0 {
        return None;
    }
    let agent = sampler.agent_process(root_pid).ok()?;
    let cwd = agent
        .as_ref()
        .and_then(|process| process_cwd(process.pid))
        .or_else(|| process_cwd(root_pid))
        .and_then(|path| path.into_os_string().into_string().ok())
        .filter(|path| path.len() <= MAX_CWD_BYTES && !path.chars().any(char::is_control));
    let execution_location = sampler
        .foreground_process(root_pid)
        .ok()
        .flatten()
        .and_then(foreground_process_argv)
        .map(|arguments| execution_location_from_argv(&arguments));
    Some(RuntimeIdentity {
        cwd,
        agent: agent.map(|process| map_provider(process.provider)),
        execution_location,
    })
}

fn execution_location_from_argv(arguments: &[String]) -> ExecutionLocationObservation {
    ssh_target_from_argv(arguments).map_or_else(
        ExecutionLocationObservation::local,
        ExecutionLocationObservation::ssh,
    )
}

/// 샘플러 프로바이더 → 프로토콜 프로바이더. 새 에이전트를 추가하면 컴파일러가
/// 이 match에서 막아 준다 — 프레임에 실리지 않고 조용히 사라지는 일이 없도록.
fn map_provider(provider: SampledAgentProvider) -> AgentProvider {
    match provider {
        SampledAgentProvider::Claude => AgentProvider::Claude,
        SampledAgentProvider::Codex => AgentProvider::Codex,
        SampledAgentProvider::Kimi => AgentProvider::Kimi,
        SampledAgentProvider::Gemini => AgentProvider::Gemini,
        SampledAgentProvider::Cursor => AgentProvider::Cursor,
        SampledAgentProvider::Copilot => AgentProvider::Copilot,
        SampledAgentProvider::Opencode => AgentProvider::Opencode,
        SampledAgentProvider::Amp => AgentProvider::Amp,
        SampledAgentProvider::Goose => AgentProvider::Goose,
        SampledAgentProvider::Droid => AgentProvider::Droid,
        SampledAgentProvider::Auggie => AgentProvider::Auggie,
        SampledAgentProvider::Grok => AgentProvider::Grok,
        SampledAgentProvider::Hermes => AgentProvider::Hermes,
        SampledAgentProvider::QwenCode => AgentProvider::QwenCode,
        SampledAgentProvider::Cline => AgentProvider::Cline,
        SampledAgentProvider::Continue => AgentProvider::Continue,
        SampledAgentProvider::Charm => AgentProvider::Charm,
        SampledAgentProvider::Codebuff => AgentProvider::Codebuff,
        SampledAgentProvider::Kilocode => AgentProvider::Kilocode,
        SampledAgentProvider::Kiro => AgentProvider::Kiro,
        SampledAgentProvider::RovoDev => AgentProvider::RovoDev,
        SampledAgentProvider::MistralVibe => AgentProvider::MistralVibe,
        SampledAgentProvider::Antigravity => AgentProvider::Antigravity,
        SampledAgentProvider::Openclaude => AgentProvider::Openclaude,
        SampledAgentProvider::Pi => AgentProvider::Pi,
        SampledAgentProvider::OhMyPi => AgentProvider::OhMyPi,
        SampledAgentProvider::CommandCode => AgentProvider::CommandCode,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn foreground_interactive_ssh_is_remote_and_ordinary_processes_are_local() {
        assert_eq!(
            execution_location_from_argv(&argv(&["ssh", "rts@211.181.122.124"])),
            ExecutionLocationObservation::ssh("rts@211.181.122.124")
        );
        assert_eq!(
            execution_location_from_argv(&argv(&["/bin/zsh", "-l"])),
            ExecutionLocationObservation::local()
        );
    }

    #[test]
    fn transport_only_or_malformed_ssh_fails_closed_to_local() {
        for arguments in [
            argv(&["ssh", "-N", "tunnel.example"]),
            argv(&["ssh", "-W", "target:22", "jump.example"]),
            argv(&["ssh", "-unknown", "host.example"]),
        ] {
            assert_eq!(
                execution_location_from_argv(&arguments),
                ExecutionLocationObservation::local()
            );
        }
    }
}
