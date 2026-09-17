//! The only shape the intake accepts. Caps are checked here, before any
//! upstream call, so an oversized payload never reaches GitHub.

use serde::Deserialize;

pub const BODY_LIMIT: usize = 8_000;
pub const CONTACT_LIMIT: usize = 200;
pub const ATTACHMENT_COUNT_LIMIT: usize = 2;
pub const ATTACHMENT_BYTES_LIMIT: usize = 4 * 1024 * 1024;
pub const ATTACHMENT_NAME_LIMIT: usize = 200;
pub const DEVICE_LIMIT: usize = 128;
/// Per-value cap for each of the six [`Environment`] fields. Every one of
/// them is client-generated from a known source (an OS version string, a
/// build id, a `WxH` window size), so legitimate values are short. The cap
/// exists because all six render into the issue body and GitHub rejects a
/// body over 65536 characters with a 422: without it a single oversized
/// value burned a delivery attempt and came back as a 503 instead of being
/// refused here, where every other cap lives.
pub const ENVIRONMENT_FIELD_LIMIT: usize = 200;

#[derive(Debug, PartialEq, Eq, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Bug,
    Idea,
    Other,
    Crash,
}

#[derive(Debug, Deserialize)]
pub struct Attachment {
    pub name: String,
    pub media_type: String,
    pub bytes_b64: String,
}

#[derive(Debug, Deserialize)]
pub struct Environment {
    pub app: String,
    pub channel: String,
    pub os: String,
    pub arch: String,
    pub locale: String,
    pub window: String,
}

impl Environment {
    /// Every environment value as `(wire name, issue-table label, value)`.
    ///
    /// One enumeration, two consumers: [`Submission::parse`] caps each value
    /// here and `sink.rs` renders each one through its untrusted-text
    /// boundary. A seventh field cannot reach the issue body uncapped and
    /// unescaped without being added to this list first, which is the whole
    /// point — three earlier rounds hardened one field at a time, and what
    /// let `env.*` through was that nothing enumerated them together.
    pub fn fields(&self) -> [(&'static str, &'static str, &str); 6] {
        [
            ("app", "App", self.app.as_str()),
            ("channel", "Channel", self.channel.as_str()),
            ("os", "OS", self.os.as_str()),
            ("arch", "Arch", self.arch.as_str()),
            ("locale", "Locale", self.locale.as_str()),
            ("window", "Window", self.window.as_str()),
        ]
    }
}

#[derive(Debug, Deserialize)]
pub struct Submission {
    pub schema: u8,
    pub kind: Kind,
    pub body: String,
    #[serde(default)]
    pub contact: Option<String>,
    pub env: Environment,
    pub device: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Debug)]
pub enum SubmissionError {
    Schema(String),
    TooLarge(String),
}

impl Submission {
    pub fn parse(raw: &str) -> Result<Self, SubmissionError> {
        let mut parsed: Submission =
            serde_json::from_str(raw).map_err(|e| SubmissionError::Schema(e.to_string()))?;
        // A contact that is empty or whitespace-only is normalized to
        // absent here, at the boundary, rather than left for every
        // downstream consumer to re-check. The shipped client never sends
        // one, but the wire itself accepted `Some("")`, and the renderer
        // trusts that a present contact is a real one — a live hand-crafted
        // request proved that gap by producing a bare "**Contact:**" line
        // with nothing after it.
        parsed.contact = parsed.contact.filter(|contact| !contact.trim().is_empty());
        if parsed.schema != 1 {
            return Err(SubmissionError::Schema("unsupported schema".into()));
        }
        if parsed.body.trim().is_empty() {
            return Err(SubmissionError::Schema("empty body".into()));
        }
        if parsed.body.chars().count() > BODY_LIMIT {
            return Err(SubmissionError::TooLarge("body".into()));
        }
        // `device` is client-generated, so legitimate input is exactly this
        // shape; it also doubles as a rate-limiter map key, so an
        // unconstrained value on a public endpoint is a memory-exhaustion
        // vector. Not a size cap earning `TooLarge` — an out-of-shape device
        // id is a malformed request, so it is a schema error like an
        // unsupported `kind`.
        if parsed.device.chars().count() > DEVICE_LIMIT
            || !parsed
                .device
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
        {
            return Err(SubmissionError::Schema("invalid device".into()));
        }
        if parsed.contact.as_deref().map_or(0, |c| c.chars().count()) > CONTACT_LIMIT {
            return Err(SubmissionError::TooLarge("contact".into()));
        }
        for (name, _label, value) in parsed.env.fields() {
            if value.chars().count() > ENVIRONMENT_FIELD_LIMIT {
                return Err(SubmissionError::TooLarge(format!("env.{name}")));
            }
        }
        if parsed.attachments.len() > ATTACHMENT_COUNT_LIMIT {
            return Err(SubmissionError::TooLarge("attachment count".into()));
        }
        if parsed
            .attachments
            .iter()
            .any(|a| a.name.chars().count() > ATTACHMENT_NAME_LIMIT)
        {
            return Err(SubmissionError::TooLarge("attachment name".into()));
        }
        // base64 inflates by 4/3; compare decoded size, which is what we store.
        let decoded: usize = parsed
            .attachments
            .iter()
            .map(|a| a.bytes_b64.len() / 4 * 3)
            .sum();
        if decoded > ATTACHMENT_BYTES_LIMIT {
            return Err(SubmissionError::TooLarge("attachment bytes".into()));
        }
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal() -> String {
        r#"{"schema":1,"kind":"bug","body":"it froze",
            "env":{"app":"0.2.19","channel":"beta","os":"macOS 15.5",
                   "arch":"aarch64","locale":"ko","window":"1512x982"},
            "device":"d-abc"}"#
            .to_string()
    }

    #[test]
    fn accepts_a_minimal_submission() {
        let parsed = Submission::parse(&minimal()).expect("parses");
        assert_eq!(parsed.kind, Kind::Bug);
        assert!(parsed.attachments.is_empty());
    }

    #[test]
    fn rejects_a_body_over_the_cap() {
        let long = "x".repeat(8001);
        let raw = minimal().replace("it froze", &long);
        assert!(matches!(
            Submission::parse(&raw),
            Err(SubmissionError::TooLarge(_))
        ));
    }

    #[test]
    fn rejects_attachments_over_the_combined_cap() {
        let payload = "A".repeat(3_000_000); // ~2.2MB decoded each
        let raw = minimal().replace(
            r#""device":"d-abc""#,
            &format!(
                r#""device":"d-abc","attachments":[
                    {{"name":"a.png","media_type":"image/png","bytes_b64":"{payload}"}},
                    {{"name":"b.png","media_type":"image/png","bytes_b64":"{payload}"}}]"#
            ),
        );
        assert!(matches!(
            Submission::parse(&raw),
            Err(SubmissionError::TooLarge(_))
        ));
    }

    #[test]
    fn rejects_an_unknown_kind() {
        let raw = minimal().replace("\"bug\"", "\"spam\"");
        assert!(matches!(
            Submission::parse(&raw),
            Err(SubmissionError::Schema(_))
        ));
    }

    // Fix round 2, finding C: body, contact, attachment count and attachment
    // bytes are all bounded, but attachment.name had no limit at all, so the
    // only real bound on it was the 8 MiB request cap.
    #[test]
    fn rejects_an_attachment_name_over_the_cap() {
        let long_name = "a".repeat(ATTACHMENT_NAME_LIMIT + 1);
        let raw = minimal().replace(
            r#""device":"d-abc""#,
            &format!(
                r#""device":"d-abc","attachments":[
                    {{"name":"{long_name}","media_type":"image/png","bytes_b64":"QQ=="}}]"#
            ),
        );
        assert!(matches!(
            Submission::parse(&raw),
            Err(SubmissionError::TooLarge(_))
        ));
    }

    // Fix round 3, finding 2: `device` had no cap at all and is used as a
    // rate-limiter map key — on a public endpoint that is a
    // memory-exhaustion vector, worse in combination with the limiter map
    // never evicting entries. The client generates this value, so we
    // control what legitimate input looks like: capped at 128 characters
    // and constrained to `[A-Za-z0-9._:-]`.
    #[test]
    fn rejects_an_over_length_device() {
        let long_device = "d".repeat(DEVICE_LIMIT + 1);
        let raw = minimal().replace(
            "\"device\":\"d-abc\"",
            &format!("\"device\":\"{long_device}\""),
        );
        assert!(matches!(
            Submission::parse(&raw),
            Err(SubmissionError::Schema(_))
        ));
    }

    #[test]
    fn rejects_a_device_with_a_disallowed_character() {
        let raw = minimal().replace("\"device\":\"d-abc\"", "\"device\":\"d abc/../etc\"");
        assert!(matches!(
            Submission::parse(&raw),
            Err(SubmissionError::Schema(_))
        ));
    }

    #[test]
    fn accepts_a_device_using_the_full_allowed_charset() {
        let raw = minimal().replace("\"device\":\"d-abc\"", "\"device\":\"d.abc_123:xyz-9\"");
        assert!(Submission::parse(&raw).is_ok());
    }

    // Fix round 5: the six `Environment` values had no cap at all, and every
    // one of them is rendered into the issue body. A 200 KB `env.app`
    // produced a 200 KB body, which GitHub rejects with a 422 past 65536
    // characters — so the request burned a delivery attempt and came back
    // 503 instead of being refused here, where every other cap lives.
    #[test]
    fn rejects_an_oversized_environment_value() {
        let huge = "x".repeat(200_000);
        let raw = minimal().replace("0.2.19", &huge);
        assert!(matches!(
            Submission::parse(&raw),
            Err(SubmissionError::TooLarge(_))
        ));
    }

    #[test]
    fn names_the_environment_field_that_exceeded_the_cap() {
        let parsed = Submission::parse(&minimal()).expect("parses");
        let samples: Vec<(&'static str, String)> = parsed
            .env
            .fields()
            .iter()
            .map(|(name, _label, value)| (*name, (*value).to_string()))
            .collect();
        let over = "x".repeat(ENVIRONMENT_FIELD_LIMIT + 1);
        for (name, sample) in samples {
            let raw = minimal().replace(&format!("\"{sample}\""), &format!("\"{over}\""));
            match Submission::parse(&raw) {
                Err(SubmissionError::TooLarge(field)) => {
                    assert_eq!(field, format!("env.{name}"));
                }
                other => panic!("env.{name} over the cap must be TooLarge, got {other:?}"),
            }
        }
    }

    #[test]
    fn accepts_environment_values_exactly_at_the_cap() {
        let at_cap = "x".repeat(ENVIRONMENT_FIELD_LIMIT);
        let raw = minimal().replace("macOS 15.5", &at_cap);
        assert!(Submission::parse(&raw).is_ok());
    }

    // Fix round 8: a live hand-crafted request sent `"contact": ""` and the
    // issue body rendered a bare "**Contact:**" with nothing after it — the
    // renderer trusted that a present contact is a real one. The shipped
    // client never sends a blank contact, so this was unreachable in
    // practice, but the wire itself accepted it. Fixed at the boundary: a
    // contact that is empty or whitespace-only is normalized to absent here,
    // so nothing downstream has to remember to re-check it.
    #[test]
    fn treats_a_blank_contact_as_absent() {
        let raw = minimal().replace(
            "\"device\":\"d-abc\"",
            "\"device\":\"d-abc\",\"contact\":\"   \"",
        );
        let parsed = Submission::parse(&raw).expect("parses");
        assert_eq!(parsed.contact, None);
    }

    #[test]
    fn treats_an_empty_contact_as_absent() {
        let raw = minimal().replace(
            "\"device\":\"d-abc\"",
            "\"device\":\"d-abc\",\"contact\":\"\"",
        );
        let parsed = Submission::parse(&raw).expect("parses");
        assert_eq!(parsed.contact, None);
    }

    #[test]
    fn keeps_a_real_contact_with_surrounding_content_intact() {
        let raw = minimal().replace(
            "\"device\":\"d-abc\"",
            "\"device\":\"d-abc\",\"contact\":\"a@b.com\"",
        );
        let parsed = Submission::parse(&raw).expect("parses");
        assert_eq!(parsed.contact.as_deref(), Some("a@b.com"));
    }
}
