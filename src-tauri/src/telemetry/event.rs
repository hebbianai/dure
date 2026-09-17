//! The event type is the allowlist. An event reaches the wire only as one of
//! these variants, and every property is a closed enumeration, so a path, a
//! prompt, a URL or a repository name has no field to travel in. The webview offers the same tagged shape
//! (`{"event": "message_sent", "properties": {"provider": "codex"}}`); serde
//! rejects unknown events, unknown keys and values outside the enumerations.

use serde::{Deserialize, Serialize};

/// The coding agents Dure can drive. Mirrors `PROVIDERS` in
/// cli/lib/contracts/provider-catalog.mjs; src/lib/ipc/telemetry.providers.test.ts
/// fails when the two lists drift. A provider outside this list is not an
/// event, not an "other" bucket.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Provider {
    Claude,
    Codex,
    Kimi,
    Gemini,
    Cursor,
    Copilot,
    Opencode,
    Amp,
    Goose,
    Droid,
    Auggie,
    Grok,
    Hermes,
    Cline,
    Continue,
    Charm,
    Codebuff,
    Kilocode,
    Kiro,
    Antigravity,
    Openclaude,
    Pi,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProjectKind {
    Local,
    Ssh,
}

/// Mirrors `PaneSplitDirection` in src/lib/workspace/dock.ts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SplitDirection {
    Right,
    Below,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "event",
    content = "properties",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(crate) enum TelemetryEvent {
    AppOpened,
    TelemetryAccepted,
    TelemetryOptedOut,
    SpaceCreated,
    ProjectAdded { kind: ProjectKind },
    AgentPaneOpened { provider: Provider },
    MessageSent { provider: Provider },
    PaneSplit { direction: SplitDirection },
    PaneHidden,
    PaneRestored,
    QuickDispatchUsed,
    GithubPanelOpened,
    GitPanelOpened,
    SshSessionOpened,
}

impl TelemetryEvent {
    /// Lifecycle events the native side emits itself; the webview may not
    /// offer them, so a choice and its event can never diverge.
    pub(crate) fn is_native_only(&self) -> bool {
        matches!(
            self,
            Self::AppOpened | Self::TelemetryAccepted | Self::TelemetryOptedOut
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: serde_json::Value) -> Result<TelemetryEvent, String> {
        serde_json::from_value(value).map_err(|error| error.to_string())
    }

    #[test]
    fn accepts_listed_events_with_enumeration_values() {
        assert_eq!(
            parse(json!({"event": "pane_hidden"})),
            Ok(TelemetryEvent::PaneHidden)
        );
        assert_eq!(
            parse(json!({"event": "message_sent", "properties": {"provider": "claude"}})),
            Ok(TelemetryEvent::MessageSent {
                provider: Provider::Claude
            })
        );
        assert_eq!(
            parse(json!({"event": "pane_split", "properties": {"direction": "below"}})),
            Ok(TelemetryEvent::PaneSplit {
                direction: SplitDirection::Below
            })
        );
    }

    #[test]
    fn rejects_unknown_events_and_unknown_keys() {
        assert!(parse(json!({"event": "prompt_text"})).is_err());
        assert!(parse(json!({"event": "pane_hidden", "path": "/x"})).is_err());
        assert!(parse(
            json!({"event": "message_sent", "properties": {"provider": "codex", "text": "hi"}})
        )
        .is_err());
        assert!(parse(json!({"event": "project_added", "properties": {"kind": "smb"}})).is_err());
    }

    #[test]
    fn rejects_values_that_could_carry_text_or_name_an_unknown_provider() {
        for bad in [
            "/Users/someone/repo",
            "hello world",
            "Codex",
            "https://example.test",
            "",
            "claude-code",
            "other",
        ] {
            assert!(
                parse(json!({"event": "message_sent", "properties": {"provider": bad}})).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn serialises_to_the_wire_names() {
        let value = serde_json::to_value(TelemetryEvent::AgentPaneOpened {
            provider: Provider::Codex,
        })
        .unwrap();
        assert_eq!(
            value,
            json!({"event": "agent_pane_opened", "properties": {"provider": "codex"}})
        );
        assert_eq!(
            serde_json::to_value(TelemetryEvent::AppOpened).unwrap(),
            json!({"event": "app_opened"})
        );
    }

    #[test]
    fn lifecycle_events_are_native_only() {
        assert!(TelemetryEvent::AppOpened.is_native_only());
        assert!(TelemetryEvent::TelemetryOptedOut.is_native_only());
        assert!(!TelemetryEvent::PaneHidden.is_native_only());
    }
}
