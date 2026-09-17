//! The real [`FeedbackSink`]: commits attachments to the asset repository,
//! files a GitHub issue (or comments on an existing one carrying the same
//! fingerprint), and best-effort pings Telegram.
//!
//! GitHub is the durable record — any failure talking to it is a real
//! failure and is returned to the caller. Telegram is pure convenience: it
//! is entirely optional to configure, and a failure sending it is logged
//! and swallowed, never surfaced.

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::github::GithubClient;
use crate::http::{FeedbackSink, SinkError};
use crate::telegram::TelegramClient;
use crate::wire::{Kind, Submission};

/// Unambiguous base32-ish alphabet for the client-facing reference: no
/// `I`, `L`, `O`, `U`, `0` or `1`, so a tester reading it aloud or retyping
/// it from a screenshot can't confuse a letter for a digit. Nothing in this
/// system generates the reference except `deliver` itself — it must never
/// leak a repository name or issue number, so it is derived purely from a
/// process-local counter and clock, never from a GitHub response.
const REFERENCE_ALPHABET: &[u8; 30] = b"23456789ABCDEFGHJKMNPQRSTVWXYZ";

static REFERENCE_COUNTER: AtomicU64 = AtomicU64::new(0);

const FINGERPRINT_MARKER_PREFIX: &str = "<!-- dure-feedback-fingerprint: ";
const FINGERPRINT_MARKER_SUFFIX: &str = " -->";

/// Longest basename this sink will write into the asset repository.
const MAX_ATTACHMENT_NAME_LEN: usize = 64;

/// Filename used for a Telegram photo upload whose submitted name failed
/// [`safe_attachment_basename`].
const FALLBACK_UPLOAD_NAME: &str = "screenshot.png";

/// Configuration for [`GithubTelegramSink`]. `main.rs` builds this from
/// environment variables; nothing here is a hardcoded constant so tests can
/// point every upstream call at a local mock server (both GitHub credentials
/// still point at the same `github_api_base` — the split is which
/// credential is used, not which host is called). Telegram credentials are
/// optional: GitHub is the durable record, so a deployment must be able to
/// boot and deliver before a Telegram bot even exists.
///
/// `github_token` and `github_assets_token` are deliberately two separate,
/// both-required fields rather than one: a fine-grained PAT applies one
/// permission set to every repository it selects, so a single token needing
/// Issues write on `dure-internal` and Contents write on
/// `dure-feedback-assets` would give this internet-facing service Contents
/// write on the code repository — compromising the intake would then let
/// someone rewrite code. `github_token` needs only Issues read/write on
/// `dure-internal`; `github_assets_token` needs only Contents read/write on
/// `dure-feedback-assets`. Both are required at startup for the same reason
/// `GITHUB_TOKEN` alone was before: a screenshot is evidence, not
/// convenience, so an intake that booted without the assets credential
/// would silently drop every one.
pub struct GithubTelegramConfig {
    pub github_token: String,
    pub github_assets_token: String,
    pub github_api_base: String,
    pub telegram_token: Option<String>,
    pub telegram_chat_id: Option<String>,
    pub telegram_api_base: String,
}

/// The production [`FeedbackSink`]: GitHub for the durable record, Telegram
/// for a best-effort team ping. `telegram` is `None` when the deployment
/// has not configured Telegram — every notification attempt is then a
/// silent no-op rather than a failure.
pub struct GithubTelegramSink {
    github: GithubClient,
    telegram: Option<TelegramClient>,
}

impl GithubTelegramSink {
    pub fn new(config: GithubTelegramConfig) -> Self {
        let http = reqwest::Client::new();
        let github = GithubClient::new(
            http.clone(),
            config.github_api_base,
            config.github_token,
            config.github_assets_token,
        );
        let telegram = match (config.telegram_token, config.telegram_chat_id) {
            (Some(token), Some(chat_id)) => Some(TelegramClient::new(
                http,
                config.telegram_api_base,
                token,
                chat_id,
            )),
            _ => None,
        };
        Self { github, telegram }
    }

    /// Sends the Telegram ping and logs, but never propagates, a failure.
    /// A silent no-op when Telegram was never configured — `main.rs` has
    /// already logged one startup warning about that; every request is not
    /// the place to repeat it.
    async fn notify_telegram(&self, submission: &Submission, summary: &str) {
        let Some(telegram) = &self.telegram else {
            return;
        };

        let png = submission
            .attachments
            .iter()
            .find(|attachment| attachment.media_type == "image/png");

        let result = match png {
            Some(attachment) => match BASE64.decode(&attachment.bytes_b64) {
                // Never `attachment.name`: it is unvalidated by definition,
                // and this multipart `filename=` was the last flow of that
                // field that had not been through `safe_attachment_basename`.
                // A name that fails the check is replaced by a fixed literal
                // rather than sanitised — the photo's filename carries no
                // information the caption does not already have.
                Ok(bytes) => {
                    let name = safe_attachment_basename(&attachment.name)
                        .unwrap_or_else(|| FALLBACK_UPLOAD_NAME.to_string());
                    telegram.send_photo(summary, &name, bytes).await
                }
                Err(err) => {
                    eprintln!("feedback telegram: could not decode PNG attachment: {err}");
                    return;
                }
            },
            None => telegram.send_message(summary).await,
        };

        if let Err(err) = result {
            eprintln!("feedback telegram notification failed: {err}");
        }
    }
}

#[async_trait]
impl FeedbackSink for GithubTelegramSink {
    async fn deliver(&self, submission: &Submission) -> Result<String, SinkError> {
        let reference = generate_reference();
        let (year, month) = year_month_utc(SystemTime::now());

        // Attachments first: the issue/comment body links to them, so they
        // must already exist before either is created. Neither an unsafe
        // name nor a failed upload is fatal to the whole submission — the
        // user's written report is what actually matters, so each problem
        // attachment is just noted in the issue body instead of discarding
        // the report. Only issue/comment creation itself can fail `deliver`.
        //
        // A rejected attachment's raw `attachment.name` is never put in the
        // note: it is unvalidated by definition, and a name shaped as a
        // markdown/HTML payload (a fake heading, a phishing link, an
        // `@handle` mention) is *guaranteed* to fail `safe_attachment_basename`
        // and land here — so a rejection is reported by count and reason
        // only. A failed *upload*, by contrast, already has a `safe_name`
        // constrained to `[A-Za-z0-9._-]{1,64}`, so it is safe to name,
        // backtick-quoted so it can never itself be read as markdown.
        let mut asset_links = Vec::with_capacity(submission.attachments.len());
        let mut failed_uploads: Vec<String> = Vec::new();
        let mut rejected_count: usize = 0;
        for attachment in &submission.attachments {
            let Some(safe_name) = safe_attachment_basename(&attachment.name) else {
                rejected_count += 1;
                continue;
            };
            let path = format!("{year:04}/{month:02}/{reference}/{safe_name}");
            let message = format!("feedback {reference}: attach {safe_name}");
            match self
                .github
                .put_asset(&path, &attachment.bytes_b64, &message)
                .await
            {
                Ok(committed) => asset_links.push((safe_name, committed.html_url)),
                Err(err) => {
                    eprintln!("feedback: could not commit attachment {safe_name}: {err}");
                    failed_uploads.push(safe_name);
                }
            }
        }

        let fingerprint = fingerprint_for(submission);
        let marker = fingerprint_marker(&fingerprint);
        let title = issue_title(&submission.body);
        let body = issue_body(
            submission,
            &asset_links,
            &failed_uploads,
            rejected_count,
            &reference,
            &fingerprint,
        );

        let open_issues = self
            .github
            .list_open_feedback_issues()
            .await
            .map_err(|err| SinkError(err.to_string()))?;
        let existing = open_issues
            .iter()
            .find(|issue| issue.body.as_deref().is_some_and(|b| b.contains(&marker)));

        let issue_url = if let Some(issue) = existing {
            self.github
                .create_comment(issue.number, &body)
                .await
                .map_err(|err| SinkError(err.to_string()))?;
            issue.html_url.clone()
        } else {
            let created = self
                .github
                .create_issue(&title, &body, &labels_for(submission.kind))
                .await
                .map_err(|err| SinkError(err.to_string()))?;
            created.html_url
        };

        let summary = telegram_summary(&title, submission, &issue_url, &reference);
        self.notify_telegram(submission, &summary).await;

        Ok(reference)
    }
}

/// Generates the client-facing reference: `f-` followed by five characters
/// from [`REFERENCE_ALPHABET`]. Combines a per-process counter with a
/// nanosecond timestamp and the process id so concurrent deliveries never
/// collide; this is a friendly identifier, not a security token, so mild
/// modulo bias mapping hash bytes onto a 30-symbol alphabet is fine.
fn generate_reference() -> String {
    let counter = REFERENCE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    let mut hasher = Sha256::new();
    hasher.update(nanos.to_le_bytes());
    hasher.update(counter.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    let digest = hasher.finalize();

    let mut reference = String::from("f-");
    for byte in digest.iter().take(5) {
        let index = (*byte as usize) % REFERENCE_ALPHABET.len();
        reference.push(REFERENCE_ALPHABET[index] as char);
    }
    reference
}

/// Converts days-since-epoch to a proleptic Gregorian (year, month), using
/// Howard Hinnant's `civil_from_days` algorithm
/// (<https://howardhinnant.github.io/date_algorithms.html>). Kept as a
/// hand-rolled pure function rather than pulling in a date/time crate for
/// one calculation; see the unit tests below for known-date coverage.
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn year_month_utc(now: SystemTime) -> (i64, u32) {
    let secs = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let (year, month, _day) = civil_from_days(days);
    (year, month)
}

fn labels_for(kind: Kind) -> Vec<&'static str> {
    match kind {
        Kind::Bug => vec!["source:feedback", "feedback:bug"],
        Kind::Idea => vec!["source:feedback", "feedback:idea"],
        Kind::Crash => vec!["source:feedback", "feedback:crash"],
        Kind::Other => vec!["source:feedback"],
    }
}

fn kind_label(kind: Kind) -> &'static str {
    match kind {
        Kind::Bug => "bug",
        Kind::Idea => "idea",
        Kind::Other => "other",
        Kind::Crash => "crash",
    }
}

/// `[feedback] ` plus the first 60 characters of the first non-empty line
/// of the body.
fn issue_title(body: &str) -> String {
    let first_line = body
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let clipped: String = first_line.chars().take(60).collect();
    format!("[feedback] {clipped}")
}

/// `sha256(device + body)` in hex, the fingerprint rule for every kind
/// except `crash`.
fn sha256_fingerprint(device: &str, body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(device.as_bytes());
    hasher.update(body.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Whether `value` is safe to splice verbatim into the issue body's
/// HTML-comment dedupe marker (`fingerprint_marker`) and to use as a
/// dedupe-matching key. `incident.fingerprint` is entirely
/// client-controlled and reaches the public endpoint unauthenticated, so
/// two things must both be true before it's trusted:
///
/// - No comment-escape injection: an HTML comment ends at the first
///   `-->`, so a crafted value containing that sequence would let the rest
///   of the string render as real issue content (a fake heading, a
///   phishing link, an `@handle` mention that pages someone).
/// - No dedupe hijacking: an arbitrary chosen string could be set to match
///   an existing issue's marker, appending the caller's text as a comment
///   on someone else's (possibly unrelated) crash report.
///
/// An earlier hex-only rule closed both, but real bundle fingerprints from
/// `src/lib/platform/errorIncident.ts` have the shape
/// `error-v1-<16 hex characters>` — not hex — so that rule rejected every
/// genuine fingerprint and silently disabled crash grouping entirely, the
/// whole reason this code path exists. Widened to `[A-Za-z0-9._:-]{8,160}`:
/// this set still cannot contain `<`, `>`, a backtick, `@`, brackets,
/// parentheses or a newline, so the comment-escape stays closed —
/// `fingerprint_marker` only ever writes this value between `<!-- ` and
/// ` -->`, and a comment can only be closed early by a literal `>`
/// completing `-->`, which is not in this set, so no value built from it
/// can ever spell `-->`. Anything outside the set still falls back to the
/// sha256(device+body) rule, unchanged.
fn is_valid_fingerprint(value: &str) -> bool {
    let len = value.len(); // ASCII-only charset, so byte length == char count.
    (8..=160).contains(&len)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// For a `crash` submission, decodes the first `application/json`
/// attachment and reads `incident.fingerprint`. `None` — falling back to
/// the sha256 rule — when there is no such attachment, it isn't valid
/// base64/JSON, the field is missing, or its value fails
/// [`is_valid_fingerprint`].
fn crash_fingerprint(submission: &Submission) -> Option<String> {
    let attachment = submission
        .attachments
        .iter()
        .find(|attachment| attachment.media_type == "application/json")?;
    let bytes = BASE64.decode(&attachment.bytes_b64).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("incident")?
        .get("fingerprint")?
        .as_str()
        .filter(|fingerprint| is_valid_fingerprint(fingerprint))
        .map(str::to_string)
}

fn fingerprint_for(submission: &Submission) -> String {
    if submission.kind == Kind::Crash {
        if let Some(fingerprint) = crash_fingerprint(submission) {
            return fingerprint;
        }
    }
    sha256_fingerprint(&submission.device, &submission.body)
}

fn fingerprint_marker(fingerprint: &str) -> String {
    format!("{FINGERPRINT_MARKER_PREFIX}{fingerprint}{FINGERPRINT_MARKER_SUFFIX}")
}

/// Reduces an attachment name to a safe basename before it can reach a
/// Contents API path. `attachment.name` arrives from a public endpoint and
/// is attacker-controlled: a name like `../../evil.png` must never let a
/// commit land outside `<yyyy>/<mm>/<reference>/` in the asset repository,
/// and a name containing a space or other unsafe character must never
/// produce a malformed request. Takes the final path segment (splitting on
/// both `/` and `\`, so `../../evil.png` becomes `evil.png`), then requires
/// it to match `[A-Za-z0-9._-]{1,64}` and to contain at least one character
/// outside `.` — a basename of only dots (`.`, `..`, `...`) passes that
/// charset byte-for-byte and, with no separator left to split on, survives
/// unchanged; `deliver` would then build `<yyyy>/<mm>/<reference>/..`, which
/// reqwest's own RFC 3986 dot-segment removal collapses to `<yyyy>/<mm>` —
/// the very escape this function exists to prevent. Returns `None` — reject
/// the attachment, never silently rename it to something safe — when even
/// that final segment fails either check.
fn safe_attachment_basename(name: &str) -> Option<String> {
    let basename = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let is_safe = !basename.is_empty()
        && basename.len() <= MAX_ATTACHMENT_NAME_LEN
        && basename
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && basename.bytes().any(|b| b != b'.');
    is_safe.then(|| basename.to_string())
}

/// Where in the issue body an untrusted value is being written.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Placement {
    /// A block of its own — the free-text report. Line breaks are part of
    /// what the reporter wrote, so they survive.
    Block,
    /// Inside one line — a table cell, or the contact line. Line breaks are
    /// folded to spaces so the value can never escape its row.
    Inline,
}

/// The single boundary every attacker-controlled string crosses on its way
/// into the issue body. Everything that reaches this tracker from the public
/// endpoint — the free-text body, all six `env` values, the contact — goes
/// through it, so what a field may *contain* is decided in one place instead
/// of once per field.
///
/// Three earlier rounds each closed this class for exactly one field (the
/// attachment name, then the crash fingerprint, then the device id), and
/// that shape is precisely why `env.*` and `contact` were still open: a new
/// field was safe only if someone remembered. Escaping here is not a
/// per-field judgement about which construct is dangerous enough — it is a
/// blanket rule that untrusted text renders as text:
///
/// - `<`, `>` and `&` become HTML entities, never backslash escapes. A
///   backslash escape renders correctly but leaves the literal characters in
///   the *stored* body, and the dedupe lookup (`deliver`) is a substring
///   search over that raw text — so `\<!-- dure-feedback-fingerprint: … -->`
///   would still hijack another issue. With no `<` in the output at all, no
///   value from this function can ever spell the marker.
/// - `|` and `@` become entities too: `|` so a value cannot forge a table
///   row, `@` so it cannot page a team. Both still *display* as themselves.
/// - Every other ASCII punctuation character is backslash-escaped, which is
///   exactly CommonMark's escapable set. That kills headings, lists,
///   blockquotes, fences, thematic breaks, links, images and emphasis in one
///   rule rather than enumerating the ones seen so far, and a triager reads
///   precisely the characters that were submitted.
/// - Control characters become spaces, so nothing invisible survives.
fn render_untrusted(value: &str, placement: Placement) -> String {
    let mut rendered = String::with_capacity(value.len() + 16);
    for character in value.chars() {
        match character {
            '\n' if placement == Placement::Block => rendered.push('\n'),
            '<' => rendered.push_str("&lt;"),
            '>' => rendered.push_str("&gt;"),
            '&' => rendered.push_str("&amp;"),
            '|' => rendered.push_str("&#124;"),
            '@' => rendered.push_str("&#64;"),
            other if other.is_ascii_punctuation() => {
                rendered.push('\\');
                rendered.push(other);
            }
            other if other.is_control() => rendered.push(' '),
            other => rendered.push(other),
        }
    }
    rendered
}

/// Builds the issue (and duplicate-comment) body: the submitted text, the
/// environment table, the contact when given, links to the committed
/// assets, a note for each attachment that could not be uploaded or was
/// rejected, the reference, and the fingerprint marker the dedupe lookup
/// searches for.
///
/// `failed_uploads` holds each `safe_name` (already constrained to
/// `[A-Za-z0-9._-]{1,64}`) whose upload failed — safe to render, so it is
/// named directly, backtick-quoted. `rejected_count` is a bare count of
/// attachments whose raw name failed validation: that name is
/// unvalidated, attacker-controlled input and must never be echoed into an
/// internal tracker issue, so only the count and reason are reported.
fn issue_body(
    submission: &Submission,
    asset_links: &[(String, String)],
    failed_uploads: &[String],
    rejected_count: usize,
    reference: &str,
    fingerprint: &str,
) -> String {
    let mut body = String::new();
    body.push_str(&render_untrusted(submission.body.trim(), Placement::Block));
    body.push_str("\n\n### Environment\n\n| Field | Value |\n| --- | --- |\n");
    // Driven by `Environment::fields()` rather than six hand-written rows:
    // the same enumeration caps these values in `wire.rs`, so a seventh
    // field arrives here already capped and already escaped.
    for (_name, label, value) in submission.env.fields() {
        body.push_str(&format!(
            "| {label} | {} |\n",
            render_untrusted(value, Placement::Inline)
        ));
    }

    if let Some(contact) = &submission.contact {
        body.push_str(&format!(
            "\n**Contact:** {}\n",
            render_untrusted(contact, Placement::Inline)
        ));
    }

    if !asset_links.is_empty() || !failed_uploads.is_empty() || rejected_count > 0 {
        body.push_str("\n### Attachments\n\n");
        for (name, url) in asset_links {
            body.push_str(&format!("- [{name}]({url})\n"));
        }
        for safe_name in failed_uploads {
            body.push_str(&format!("- `{safe_name}` could not be stored\n"));
        }
        if rejected_count > 0 {
            let (noun, verb) = if rejected_count == 1 {
                ("attachment", "was")
            } else {
                ("attachments", "were")
            };
            body.push_str(&format!(
                "- {rejected_count} {noun} {verb} rejected (unsafe filename)\n"
            ));
        }
    }

    body.push_str(&format!("\n**Reference:** {reference}\n\n"));
    body.push_str(&fingerprint_marker(fingerprint));
    body.push('\n');
    body
}

/// The Telegram message text: title, kind, the first three lines of the
/// body, the issue URL and the reference.
fn telegram_summary(
    title: &str,
    submission: &Submission,
    issue_url: &str,
    reference: &str,
) -> String {
    let preview: Vec<&str> = submission.body.lines().take(3).collect();
    format!(
        "{title}\nKind: {}\n{}\n{issue_url}\nRef: {reference}",
        kind_label(submission.kind),
        preview.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_uses_only_the_unambiguous_alphabet() {
        for _ in 0..50 {
            let reference = generate_reference();
            assert!(reference.starts_with("f-"));
            let suffix = &reference[2..];
            assert_eq!(suffix.len(), 5);
            for ch in suffix.chars() {
                assert!(
                    REFERENCE_ALPHABET.contains(&(ch as u8)),
                    "{ch} is not in the unambiguous alphabet"
                );
                assert!(!"ILOU01".contains(ch), "{ch} is an ambiguous character");
            }
        }
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        // 19782 = 54 years of days (with 13 intervening Feb-29ths) plus the
        // 31 days of January and 28 more days of February, landing exactly
        // on the leap day itself: 1970-01-01 + 19782 days = 2024-02-29.
        assert_eq!(civil_from_days(19782), (2024, 2, 29));
    }

    #[test]
    fn issue_title_takes_the_first_sixty_characters_of_the_first_non_empty_line() {
        let body = "\n   \nThis is the real first line and it is quite long indeed, over sixty chars\nsecond line";
        let title = issue_title(body);
        assert!(title.starts_with("[feedback] This is the real first line"));
        assert_eq!(title.chars().count(), "[feedback] ".chars().count() + 60);
    }

    #[test]
    fn labels_for_other_kind_carries_only_the_source_label() {
        assert_eq!(labels_for(Kind::Other), vec!["source:feedback"]);
    }

    #[test]
    fn crash_fingerprint_falls_back_when_the_bundle_is_missing() {
        let raw = r#"{"schema":1,"kind":"crash","body":"boom","device":"d-1",
            "env":{"app":"a","channel":"c","os":"o","arch":"x","locale":"l","window":"w"}}"#;
        let submission = Submission::parse(raw).expect("parses");
        assert_eq!(
            fingerprint_for(&submission),
            sha256_fingerprint("d-1", "boom")
        );
    }

    // Fix round 3, finding 1 restricted bundle fingerprints to hex, closing
    // a comment-escape/dedupe-hijack injection. Fix round 4 corrects that
    // ruling: Task 8 found real incident fingerprints from
    // `errorIncident.ts` have the shape `error-v1-<16 hex characters>` —
    // not hex — so the hex-only rule rejected every genuine fingerprint and
    // silently disabled crash grouping entirely, the whole reason this code
    // path exists. Widened to `[A-Za-z0-9._:-]{8,160}`: this set still
    // cannot contain `<`, `>`, a backtick, `@`, brackets, parentheses or a
    // newline, so the comment-escape stays closed (the marker's own
    // `"<!-- ... -->"` can only be closed early by a literal `>`, which is
    // not in the set — no value built from this charset can ever spell
    // `-->`) — see `is_valid_fingerprint`'s doc comment for the full
    // reasoning, verified against `fingerprint_marker` directly.
    #[test]
    fn crash_fingerprint_accepts_the_widened_charset_and_boundary_lengths() {
        for accepted in [
            "error-v1-0123456789abcdef", // the real shape from errorIncident.ts
            "deadbeef",                  // 8 chars: the floor
            "zzzzzzzz",                  // 8 non-hex letters: charset widened, not just length
            "a.b_c:d-e9",                // every newly-allowed punctuation character
            &"a".repeat(140),            // over the old 128 ceiling, within the new 160 one
            &"a".repeat(160),            // 160 chars: the new ceiling, exactly
        ] {
            assert_eq!(
                crash_fingerprint_from_json(accepted),
                Some(accepted.to_string()),
                "{accepted:?} should be accepted under the widened rule"
            );
        }
    }

    #[test]
    fn crash_fingerprint_rejects_disallowed_characters_and_out_of_range_lengths() {
        for rejected in [
            "has a space in it 12345", // space
            "deadbeef>escape",         // '>' — the character that would close the comment early
            "deadbeef\nnewline12",     // newline
            "deadbeef@mention123",     // '@'
            "deadbeef`backtick1",      // backtick
            "deadbeef<tag>here12",     // '<' and '>'
            "",                        // 0 chars
            "1234567",                 // 7 chars: one short of the 8-char floor
            &"a".repeat(161),          // 161 chars: one over the new 160-char ceiling
        ] {
            assert_eq!(
                crash_fingerprint_from_json(rejected),
                None,
                "{rejected:?} must not be accepted as a bundle fingerprint"
            );
        }
    }

    /// Builds a minimal crash submission whose bundle carries
    /// `incident.fingerprint = fingerprint` and returns what
    /// `crash_fingerprint` extracts from it.
    fn crash_fingerprint_from_json(fingerprint: &str) -> Option<String> {
        let incident = serde_json::json!({ "incident": { "fingerprint": fingerprint } });
        let incident_b64 = BASE64.encode(incident.to_string());
        let raw = format!(
            r#"{{"schema":1,"kind":"crash","body":"boom","device":"d-1",
                "env":{{"app":"a","channel":"c","os":"o","arch":"x","locale":"l","window":"w"}},
                "attachments":[{{"name":"i.json","media_type":"application/json","bytes_b64":"{incident_b64}"}}]}}"#
        );
        let submission = Submission::parse(&raw).expect("parses");
        crash_fingerprint(&submission)
    }

    #[test]
    fn safe_attachment_basename_strips_path_traversal() {
        assert_eq!(
            safe_attachment_basename("../../evil.png"),
            Some("evil.png".to_string())
        );
        assert_eq!(
            safe_attachment_basename("a/b/c/name.png"),
            Some("name.png".to_string())
        );
    }

    #[test]
    fn safe_attachment_basename_rejects_unsafe_characters() {
        assert_eq!(safe_attachment_basename("screen shot.png"), None);
        assert_eq!(safe_attachment_basename(""), None);
        assert_eq!(safe_attachment_basename("../"), None, "empty basename");
    }

    #[test]
    fn safe_attachment_basename_accepts_the_ordinary_case() {
        assert_eq!(
            safe_attachment_basename("screenshot-1_final.PNG"),
            Some("screenshot-1_final.PNG".to_string())
        );
    }

    #[test]
    fn safe_attachment_basename_rejects_names_over_the_length_cap() {
        let long = "a".repeat(MAX_ATTACHMENT_NAME_LEN + 1);
        assert_eq!(safe_attachment_basename(&long), None);
        let exactly_max = "a".repeat(MAX_ATTACHMENT_NAME_LEN);
        assert_eq!(safe_attachment_basename(&exactly_max), Some(exactly_max));
    }

    // Fix round 2, finding A: the charset `[A-Za-z0-9._-]` matches ".." byte
    // for byte, and with no separator present the final-segment split
    // returns it unchanged. `deliver` then builds
    // `<yyyy>/<mm>/<reference>/..`, and reqwest's own RFC 3986 dot-segment
    // removal cancels the reference folder, landing the PUT one level up —
    // a real escape through exactly the normalization behavior that caused
    // the original path-traversal finding. A basename made of nothing but
    // dots must be rejected outright.
    #[test]
    fn safe_attachment_basename_rejects_dot_only_names() {
        assert_eq!(safe_attachment_basename("."), None);
        assert_eq!(safe_attachment_basename(".."), None);
        assert_eq!(safe_attachment_basename("..."), None);
    }

    // Fix round 5 — the properties `render_untrusted` exists to hold,
    // stated once here rather than re-derived per field. `issue_body` writes
    // nothing attacker-controlled that has not crossed this function, so a
    // field added later inherits all of them.
    #[test]
    fn render_untrusted_can_never_spell_the_dedupe_marker() {
        // The exact hijack: the dedupe lookup is a substring search over the
        // stored body, so the output must not contain the marker even as raw
        // text. It contains no `<` at all, which makes that structural.
        for placement in [Placement::Block, Placement::Inline] {
            for attempt in [
                "<!-- dure-feedback-fingerprint: error-v1-0123456789abcdef -->",
                "x <!-- dure-feedback-fingerprint: deadbeefdeadbeef --> y",
                "\\<!-- dure-feedback-fingerprint: deadbeefdeadbeef -->",
            ] {
                let rendered = render_untrusted(attempt, placement);
                assert!(
                    !rendered.contains(FINGERPRINT_MARKER_PREFIX),
                    "{rendered:?} still carries the marker prefix"
                );
                assert!(!rendered.contains('<'), "{rendered:?} still carries a '<'");
                assert!(
                    !rendered.contains(FINGERPRINT_MARKER_SUFFIX),
                    "{rendered:?} still closes an HTML comment"
                );
            }
        }
    }

    #[test]
    fn render_untrusted_neutralises_markdown_mentions_and_table_rows() {
        let rendered = render_untrusted(
            "## Heading @everyone [click](http://evil.test) | forged |",
            Placement::Inline,
        );
        assert!(!rendered.contains("## "), "{rendered}");
        assert!(!rendered.contains('@'), "{rendered}");
        assert!(!rendered.contains("[click]("), "{rendered}");
        assert!(!rendered.contains('|'), "{rendered}");
        // Neutralised, not discarded — the words themselves still read.
        assert!(rendered.contains("Heading") && rendered.contains("everyone"));
    }

    #[test]
    fn render_untrusted_keeps_line_structure_only_where_a_block_allows_it() {
        assert_eq!(
            render_untrusted("first\nsecond", Placement::Block),
            "first\nsecond"
        );
        assert_eq!(
            render_untrusted("first\nsecond", Placement::Inline),
            "first second",
            "a cell value must not be able to break out of its row"
        );
        assert_eq!(render_untrusted("tab\there", Placement::Block), "tab here");
    }

    #[test]
    fn render_untrusted_leaves_ordinary_values_readable() {
        assert_eq!(render_untrusted("aarch64", Placement::Inline), "aarch64");
        assert_eq!(render_untrusted("1512x982", Placement::Inline), "1512x982");
        assert_eq!(
            render_untrusted("macOS 15.5", Placement::Inline),
            r"macOS 15\.5"
        );
    }
}
