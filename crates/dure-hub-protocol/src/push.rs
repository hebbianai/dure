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
}
