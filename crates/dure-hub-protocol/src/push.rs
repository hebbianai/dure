//! Push registration belongs to a paired device, not a terminal attachment.
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(try_from = "String", into = "String")]
pub struct ApnsToken(String);

impl TryFrom<String> for ApnsToken {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        // APNs token lengths are not a public fixed-size contract.
        if value.is_empty()
            || value.len() > 512
            || value.len() % 2 != 0
            || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Invalid APNs device token");
        }
        Ok(Self(value.to_ascii_lowercase()))
    }
}

impl From<ApnsToken> for String {
    fn from(value: ApnsToken) -> Self {
        value.0
    }
}

impl std::fmt::Debug for ApnsToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ApnsToken(<redacted>)")
    }
}

impl ApnsToken {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApnsEnvironment {
    Sandbox,
    Production,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PushPreference {
    All,
    Approvals,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PushKind {
    Approval,
    Done,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PushLanguage {
    En,
    Ko,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PushSubscription {
    pub token: ApnsToken,
    pub environment: ApnsEnvironment,
    pub preference: PushPreference,
    pub language: PushLanguage,
}

impl PushSubscription {
    pub fn accepts(&self, kind: PushKind) -> bool {
        self.preference == PushPreference::All || kind == PushKind::Approval
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PushSubscriptionResult {
    Saved,
    Refused { detail: String },
}

/// An identifier an alert carries: the agent's catalog key (a chat-owned
/// agent's id, else its Hmux session id), or its approval's attention id and
/// terminal epoch.
///
/// It crosses the push relay and APNs, so it must stay an identifier. The
/// alphabet is the one Hmux mints opaque ids from: no space a title needs and
/// no separator a path needs, so neither can pass for one.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(try_from = "String", into = "String")]
pub struct PushId(String);

impl TryFrom<String> for PushId {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty()
            || value.len() > 256
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'+' | b'-')
            })
        {
            return Err("Invalid push identifier");
        }
        Ok(Self(value))
    }
}

impl From<PushId> for String {
    fn from(value: PushId) -> Self {
        value.0
    }
}

impl PushId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The approval an approval alert is about: what an answer from the alert
/// must name, so it can never answer a later request of the same agent.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushApproval {
    /// The Host's id of the pending approval.
    pub attention_id: PushId,
    /// The provider process that raised it.
    pub terminal_epoch: PushId,
}

/// The alert category whose Allow once and Deny actions answer [`PushApproval`].
pub const PUSH_APPROVAL_CATEGORY: &str = "dure.approval";

/// The key beside `aps` under which the push relay puts [`PushAlertContext`].
pub const PUSH_ALERT_CONTEXT_KEY: &str = "dure";

/// What an APNs alert carries for the app beyond its text. Only identifiers:
/// what the agent asked or said is read from the paired computer.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushAlertContext {
    /// The agent a tap on the alert opens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<PushId>,
    /// The computer that raised the alert, as the phone's paired entry names
    /// it ([`crate::fingerprint::of_der`]). Sent with an approval only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hub: Option<String>,
    /// The approval Allow once and Deny answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<PushApproval>,
}

impl PushAlertContext {
    /// Reads the context from a delivered alert's whole JSON payload, field
    /// by field: an alert from an older relay has none, and a malformed field
    /// is absent rather than taking the others with it.
    pub fn from_payload(payload: &[u8]) -> Self {
        let Ok(serde_json::Value::Object(mut payload)) = serde_json::from_slice(payload) else {
            return Self::default();
        };
        let Some(serde_json::Value::Object(mut context)) = payload.remove(PUSH_ALERT_CONTEXT_KEY)
        else {
            return Self::default();
        };
        let mut field = |name: &str| context.remove(name).unwrap_or_default();
        Self {
            session: serde_json::from_value(field("session")).ok(),
            hub: serde_json::from_value::<String>(field("hub"))
                .ok()
                .filter(|hub| crate::fingerprint::is_fingerprint(hub)),
            approval: serde_json::from_value(field("approval")).ok(),
        }
    }

    /// What an answer from this alert needs: the computer to ask, the agent
    /// and its approval. None for any alert that is not answerable.
    pub fn answerable(&self) -> Option<(&str, &PushId, &PushApproval)> {
        Some((
            self.hub.as_deref()?,
            self.session.as_ref()?,
            self.approval.as_ref()?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_bounded_normalized_and_redacted() {
        let token = ApnsToken::try_from("AA12".to_string()).unwrap();
        assert_eq!(token.as_str(), "aa12");
        assert!(!format!("{token:?}").contains("aa12"));
        for invalid in [
            "".to_string(),
            "abc".to_string(),
            "../../device".to_string(),
            "aa".repeat(257),
        ] {
            assert!(ApnsToken::try_from(invalid).is_err());
        }
    }

    #[test]
    fn approvals_only_does_not_send_completion() {
        let mut subscription = PushSubscription {
            token: "aa12".to_string().try_into().unwrap(),
            environment: ApnsEnvironment::Sandbox,
            preference: PushPreference::Approvals,
            language: PushLanguage::En,
        };
        assert!(subscription.accepts(PushKind::Approval));
        assert!(!subscription.accepts(PushKind::Done));
        subscription.preference = PushPreference::All;
        assert!(subscription.accepts(PushKind::Done));
    }

    #[test]
    fn a_push_id_is_an_identifier_never_a_path_or_a_title() {
        for valid in [
            "managed_0123456789abcdef01234567",
            "session-7a1d1b2f352c9cc587a6b8bfd7b6d2f7",
            "3f2c1a9e-58b4-4c4e-9a4f-1d2e3f4a5b6c",
            "attention-12",
        ] {
            assert_eq!(PushId::try_from(valid.to_string()).unwrap().as_str(), valid);
        }
        for invalid in [
            String::new(),
            "/Users/me/project".to_string(),
            "C:\\work\\repo".to_string(),
            "Fix the build".to_string(),
            "a".repeat(257),
        ] {
            assert!(PushId::try_from(invalid).is_err());
        }
    }

    #[test]
    fn an_alert_context_is_read_from_the_relay_payload_and_absent_otherwise() {
        let delivered =
            br#"{"aps":{"alert":{"title":"Dure","body":"x"}},"dure":{"session":"agent-1"}}"#;
        let context = PushAlertContext::from_payload(delivered);
        assert_eq!(
            context.session.map(String::from),
            Some("agent-1".to_string())
        );
        assert_eq!((context.hub, context.approval), (None, None));
        for unusable in [
            br#"{"aps":{"alert":{"title":"Dure","body":"x"}}}"#.as_slice(),
            br#"{"aps":{},"dure":{"session":"/Users/me/project"}}"#,
            br#"{"aps":{},"dure":"agent-1"}"#,
            b"not json",
        ] {
            assert_eq!(
                PushAlertContext::from_payload(unusable),
                PushAlertContext::default()
            );
        }
    }

    #[test]
    fn an_approval_alert_is_answerable_only_with_its_computer_agent_and_approval() {
        let hub = crate::fingerprint::of_der(b"hub certificate");
        let payload = |hub: &str, approval: &str| {
            format!(
                r#"{{"aps":{{"category":"dure.approval"}},"dure":{{"session":"managed_1","hub":"{hub}","approval":{approval}}}}}"#
            )
        };
        let context = PushAlertContext::from_payload(
            payload(&hub, r#"{"attentionId":"attention-3","terminalEpoch":"7"}"#).as_bytes(),
        );
        let (computer, session, approval) = context.answerable().unwrap();
        assert_eq!(
            (
                computer,
                session.as_str(),
                approval.attention_id.as_str(),
                approval.terminal_epoch.as_str()
            ),
            (hub.as_str(), "managed_1", "attention-3", "7")
        );
        // A malformed field is absent; the others still open the agent.
        for (hub, approval) in [
            (
                "SHA256:short",
                r#"{"attentionId":"attention-3","terminalEpoch":"7"}"#,
            ),
            (
                hub.as_str(),
                r#"{"attentionId":"attention 3","terminalEpoch":"7"}"#,
            ),
            (hub.as_str(), r#"{"attentionId":"attention-3"}"#),
        ] {
            let context = PushAlertContext::from_payload(payload(hub, approval).as_bytes());
            assert!(context.answerable().is_none());
            assert_eq!(
                context.session.map(String::from),
                Some("managed_1".to_string())
            );
        }
    }
}
