//! One OSC 7501 body, the bytes after `7501;` (Program Status Protocol 0.3).
//!
//! The body is `key=value` pairs joined by `:`. A pair without `=` or with a
//! key that is not lowercase letters is skipped; an unknown key is ignored and
//! a repeated key keeps its last value. Each recognized value is judged by its
//! key: a report that breaks a size limit, carries invalid base64 or decodes to
//! text with a control character is discarded whole, as is one whose `state` is
//! missing or unknown or whose `id` is unusable. An unrecognized `kind` or an
//! unusable `app` is treated as absent.
use crate::local_protocol::{
    PROGRAM_STATUS_APP_MAX_BYTES, PROGRAM_STATUS_MESSAGE_MAX_BYTES, ProgramStatusBlockedKind,
    ProgramStatusState, is_program_status_app, is_program_status_control_char,
    is_program_status_format_char,
};
use base64::Engine as _;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use std::fmt;

const MAX_KEY_BYTES: usize = 16;
const MAX_MESSAGE_ENCODED_BYTES: usize = 2732;
const MAX_TITLE_ENCODED_BYTES: usize = 256;
const MAX_TITLE_BYTES: usize = 192;
const MAX_ID_BYTES: usize = 128;
const MAX_ID_DEPTH: usize = 8;

/// Standard alphabet with optional padding.
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// A record address: `/`-separated segments, empty for the root record.
#[derive(Clone, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct RecordId(Vec<String>);

impl RecordId {
    pub(super) fn root() -> Self {
        Self::default()
    }

    /// Whether `other` is this record or one of its descendants.
    pub(super) fn contains(&self, other: &Self) -> bool {
        other.0.starts_with(&self.0)
    }

    fn parse(value: &[u8]) -> Option<Self> {
        if value.len() > MAX_ID_BYTES {
            return None;
        }
        let text = std::str::from_utf8(value).ok()?;
        let segments = text
            .split('/')
            .map(|segment| is_program_status_app(segment).then(|| segment.to_owned()))
            .collect::<Option<Vec<_>>>()?;
        (segments.len() <= MAX_ID_DEPTH).then_some(Self(segments))
    }
}

/// What a record keeps of its report. `title` and `progress` are validated
/// by the protocol's rules but not kept until a client surface presents them,
/// so a change to either alone is not a record change.
#[derive(Clone, Eq, PartialEq)]
pub(super) struct ReportedRecord {
    pub state: ProgramStatusState,
    pub blocked_kind: Option<ProgramStatusBlockedKind>,
    pub app: Option<String>,
    pub message: Option<String>,
}

// The message is program-chosen text; logs carry its size only.
impl fmt::Debug for ReportedRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReportedRecord")
            .field("state", &self.state)
            .field("blocked_kind", &self.blocked_kind)
            .field("app", &self.app)
            .field("message_len", &self.message.as_ref().map(String::len))
            .finish()
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum ProgramStatusCommand {
    /// `?`: the program asks whether the terminal speaks the protocol.
    Query,
    Report {
        id: RecordId,
        record: ReportedRecord,
    },
    /// `state=clear`: remove the record and its descendants; the root
    /// address removes every record.
    Clear { id: RecordId },
}

#[derive(Default)]
struct Pairs<'a> {
    state: Option<&'a [u8]>,
    id: Option<&'a [u8]>,
    kind: Option<&'a [u8]>,
    app: Option<&'a [u8]>,
    title: Option<&'a [u8]>,
    msg: Option<&'a [u8]>,
}

pub(super) fn parse(body: &[u8]) -> Option<ProgramStatusCommand> {
    if body.trim_ascii() == b"?" {
        return Some(ProgramStatusCommand::Query);
    }
    let pairs = pairs(body)?;
    // Every discard rule applies before the state is read, `clear` included.
    let id = match pairs.id {
        Some(value) => RecordId::parse(value)?,
        None => RecordId::root(),
    };
    let app = match pairs.app {
        Some(value) if value.len() > PROGRAM_STATUS_APP_MAX_BYTES => return None,
        Some(value) => std::str::from_utf8(value)
            .ok()
            .filter(|app| is_program_status_app(app))
            .map(str::to_owned),
        None => None,
    };
    decode_text(pairs.title, MAX_TITLE_ENCODED_BYTES, MAX_TITLE_BYTES)?;
    let message = decode_text(
        pairs.msg,
        MAX_MESSAGE_ENCODED_BYTES,
        PROGRAM_STATUS_MESSAGE_MAX_BYTES,
    )?;
    let state = match pairs.state? {
        b"clear" => return Some(ProgramStatusCommand::Clear { id }),
        b"idle" => ProgramStatusState::Idle,
        b"working" => ProgramStatusState::Working,
        b"blocked" => ProgramStatusState::Blocked,
        b"done" => ProgramStatusState::Done,
        b"error" => ProgramStatusState::Error,
        _ => return None,
    };
    let blocked_kind = match (state, pairs.kind) {
        (ProgramStatusState::Blocked, Some(b"permission")) => {
            Some(ProgramStatusBlockedKind::Permission)
        }
        (ProgramStatusState::Blocked, Some(b"question")) => {
            Some(ProgramStatusBlockedKind::Question)
        }
        (ProgramStatusState::Blocked, Some(b"auth")) => Some(ProgramStatusBlockedKind::Auth),
        _ => None,
    };
    Some(ProgramStatusCommand::Report {
        id,
        record: ReportedRecord {
            state,
            blocked_kind,
            app,
            message,
        },
    })
}

/// `None` discards the whole report: one of its keys is longer than the
/// protocol admits.
fn pairs(body: &[u8]) -> Option<Pairs<'_>> {
    let mut pairs = Pairs::default();
    for pair in body.split(|&byte| byte == b':') {
        let Some(separator) = pair.iter().position(|&byte| byte == b'=') else {
            continue;
        };
        let key = pair[..separator].trim_ascii();
        if key.len() > MAX_KEY_BYTES {
            return None;
        }
        if key.is_empty() || !key.iter().all(u8::is_ascii_lowercase) {
            continue;
        }
        let slot = match key {
            b"state" => &mut pairs.state,
            b"id" => &mut pairs.id,
            b"kind" => &mut pairs.kind,
            b"app" => &mut pairs.app,
            b"title" => &mut pairs.title,
            b"msg" => &mut pairs.msg,
            _ => continue,
        };
        *slot = Some(pair[separator + 1..].trim_ascii());
    }
    Some(pairs)
}

/// Outer `None` discards the report; inner `None` means no displayable text.
/// Bidirectional and invisible formatting characters are removed rather than
/// refused, so a status cannot reorder or hide surrounding text.
fn decode_text(
    value: Option<&[u8]>,
    max_encoded_bytes: usize,
    max_decoded_bytes: usize,
) -> Option<Option<String>> {
    let Some(value) = value else {
        return Some(None);
    };
    if value.len() > max_encoded_bytes {
        return None;
    }
    let decoded = BASE64.decode(value).ok()?;
    if decoded.len() > max_decoded_bytes {
        return None;
    }
    let text = String::from_utf8(decoded).ok()?;
    if text.chars().any(is_program_status_control_char) {
        return None;
    }
    let text = text
        .chars()
        .filter(|&character| !is_program_status_format_char(character))
        .collect::<String>();
    Some((!text.is_empty()).then_some(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(text: &str) -> String {
        BASE64.encode(text)
    }

    fn report(body: &str) -> Option<(RecordId, ReportedRecord)> {
        match parse(body.as_bytes()) {
            Some(ProgramStatusCommand::Report { id, record }) => Some((id, record)),
            _ => None,
        }
    }

    fn root(state: ProgramStatusState) -> ReportedRecord {
        ReportedRecord {
            state,
            blocked_kind: None,
            app: None,
            message: None,
        }
    }

    #[test]
    fn the_query_is_recognized_with_surrounding_whitespace() {
        assert_eq!(parse(b"?"), Some(ProgramStatusCommand::Query));
        assert_eq!(parse(b" ? "), Some(ProgramStatusCommand::Query));
        assert_eq!(parse(b"??"), None);
    }

    #[test]
    fn a_full_report_keeps_what_is_presented() {
        let body = format!(
            "state=blocked:kind=permission:progress=40:app=claude-code:id=task/a1:title={}:msg={}",
            b64("Subagent"),
            b64("Allow Bash(cargo test)?"),
        );
        let (id, record) = report(&body).unwrap();
        assert_eq!(id, RecordId(vec!["task".into(), "a1".into()]));
        assert_eq!(
            record,
            ReportedRecord {
                state: ProgramStatusState::Blocked,
                blocked_kind: Some(ProgramStatusBlockedKind::Permission),
                app: Some("claude-code".into()),
                message: Some("Allow Bash(cargo test)?".into()),
            }
        );
    }

    #[test]
    fn pairs_are_trimmed_malformed_ones_skipped_and_the_last_repeat_wins() {
        let (id, record) =
            report(" state = idle : junk : =x : Bad=1 : odd=a;b : state=working : app=pi ")
                .unwrap();
        assert_eq!(id, RecordId::root());
        assert_eq!(
            record,
            ReportedRecord {
                app: Some("pi".into()),
                ..root(ProgramStatusState::Working)
            }
        );
    }

    #[test]
    fn missing_or_unknown_states_and_unusable_ids_ignore_the_report() {
        for body in [
            "app=x",
            "state=paused",
            "state=",
            "state=idle:id=",
            "state=idle:id=a//b",
            "state=idle:id=a%b",
            // An unusable id never falls back to the root record.
            "state=blocked:id=sub task",
            "state=blocked:id=ünïcode",
            "state=idle:id=a/b/c/d/e/f/g/h/i",
            &format!("state=idle:id={}", "x".repeat(33)),
            &format!("state=idle:id={}", ["abcdefghijklmnop"; 8].join("/")),
        ] {
            assert_eq!(parse(body.as_bytes()), None, "{body}");
        }
        assert!(report(&format!("state=idle:id={}", ["a"; 8].join("/"))).is_some());
    }

    #[test]
    fn a_kind_applies_only_to_a_blocked_state() {
        let (_, working) = report("state=working:kind=question").unwrap();
        assert_eq!(working.blocked_kind, None);
        let (_, blocked) = report("state=blocked:kind=approve").unwrap();
        assert_eq!(blocked.blocked_kind, None);
        for (kind, expected) in [
            ("permission", ProgramStatusBlockedKind::Permission),
            ("question", ProgramStatusBlockedKind::Question),
            ("auth", ProgramStatusBlockedKind::Auth),
        ] {
            let (_, blocked) = report(&format!("state=blocked:kind={kind}")).unwrap();
            assert_eq!(blocked.blocked_kind, Some(expected), "{kind}");
        }
    }

    #[test]
    fn clear_addresses_a_subtree_or_every_record() {
        assert_eq!(
            parse(b"state=clear"),
            Some(ProgramStatusCommand::Clear {
                id: RecordId::root()
            })
        );
        assert_eq!(
            parse(b"state=clear:id=task"),
            Some(ProgramStatusCommand::Clear {
                id: RecordId(vec!["task".into()])
            })
        );
        assert!(RecordId::root().contains(&RecordId(vec!["a".into()])));
        assert!(RecordId(vec!["a".into()]).contains(&RecordId(vec!["a".into(), "b".into()])));
        assert!(!RecordId(vec!["a".into()]).contains(&RecordId(vec!["ab".into()])));
    }

    #[test]
    fn limits_invalid_base64_and_control_characters_discard_the_whole_report() {
        for body in [
            format!("state=idle:{}=1", "k".repeat(MAX_KEY_BYTES + 1)),
            format!(
                "state=idle:app={}",
                "a".repeat(PROGRAM_STATUS_APP_MAX_BYTES + 1)
            ),
            format!(
                "state=idle:msg={}",
                b64(&"m".repeat(PROGRAM_STATUS_MESSAGE_MAX_BYTES + 1))
            ),
            format!("state=idle:title={}", b64(&"t".repeat(MAX_TITLE_BYTES + 1))),
            "state=idle:msg=not*base64".into(),
            "state=idle:msg=has space".into(),
            format!("state=idle:msg={}", b64("two\nlines")),
            format!("state=idle:msg={}", b64("c1\u{9b}31m")),
            format!("state=idle:title={}", b64("bell\u{7}")),
            format!("state=idle:msg={}", BASE64.encode([0xff, 0xfe])),
            // Clearing obeys the same discard rules as any other report.
            "state=clear:id=task:msg=!!".into(),
            format!("state=clear:title={}", b64("bell\u{7}")),
        ] {
            assert_eq!(parse(body.as_bytes()), None, "{body}");
        }
        let longest_key = format!("state=idle:{}=1", "k".repeat(MAX_KEY_BYTES));
        assert!(
            report(&longest_key).is_some(),
            "an unknown key at the limit is ignored"
        );
        let longest = "m".repeat(PROGRAM_STATUS_MESSAGE_MAX_BYTES);
        assert_eq!(
            report(&format!("state=idle:msg={}", b64(&longest)))
                .unwrap()
                .1
                .message,
            Some(longest)
        );
    }

    #[test]
    fn unpadded_base64_and_formatting_characters_are_normalized() {
        let encoded = b64("ok").trim_end_matches('=').to_owned();
        assert_eq!(
            report(&format!("state=done:msg={encoded}"))
                .unwrap()
                .1
                .message,
            Some("ok".into())
        );
        let (_, record) = report(&format!(
            "state=error:msg={}",
            b64("\u{202E}evil\u{200B} name")
        ))
        .unwrap();
        assert_eq!(record.message, Some("evil name".into()));
        let (_, record) = report(&format!("state=error:msg={}", b64("\u{2066}"))).unwrap();
        assert_eq!(record.message, None, "nothing displayable remains");
    }

    #[test]
    fn unusable_app_names_are_absent_without_discarding_the_report() {
        for app in ["has%20space", "é", "a;b"] {
            let (_, record) = report(&format!("state=idle:app={app}")).unwrap();
            assert_eq!(record.app, None, "{app}");
        }
    }

    #[test]
    fn debug_output_never_contains_the_message() {
        let (_, record) = report(&format!("state=error:msg={}", b64("secret path"))).unwrap();
        let debug = format!(
            "{:?}",
            ProgramStatusCommand::Report {
                id: RecordId::root(),
                record,
            }
        );
        assert!(debug.contains("message_len: Some(11)"));
        assert!(!debug.contains("secret"));
    }
}
