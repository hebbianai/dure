//! What a phone alert says about the agent it names, read from the paired
//! computer when the alert arrives (#625).
//!
//! The relay carries identifiers only: the agent, what happened and the
//! computer that raised it (`PushAlertContext`). The notification service
//! extension (`NotificationService.m`) hands each delivered alert to
//! [`dure_alert_text`], which asks that computer over the same pinned
//! channel the screen uses. Its catalog names the agent, its project and its
//! pending approval, and its transcript carries a finished turn's answer.
//! Anything missing, refused or late keeps the alert as the relay sent it.

use crate::{hub_store, push::AlertActions, HubProbe, HubProbeSession};
use dure_hub_protocol::{
    hello::HubRequest,
    push::{PushAlertContext, PushApproval, PushKind},
};
use serde::Serialize;
use std::path::Path;
use std::time::{Duration, Instant};

/// The text an alert shows once its computer said who and what.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct AlertText {
    /// The agent and its project.
    pub title: String,
    /// What happened, in the relay's words, when the body says what the
    /// agent asks or said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub body: String,
}

/// Longer details are cut here. It is the home card's bound for an answer's
/// first line (`finalResponses.ts`); an alert shows a few lines anyway.
const MAX_DETAIL_CHARS: usize = 280;

/// Past this, most of the extension's time is spent: a finished turn's
/// answer is not asked for, so the name still lands before the system gives
/// up on the alert.
const ANSWER_BUDGET: Duration = Duration::from_secs(12);

/// The new text for the alert whose whole JSON payload is `payload`, read
/// with the device configuration in `root`. None keeps the alert as it is:
/// an older relay, alerts kept generic, an unknown computer or agent, or a
/// computer that did not answer.
pub fn read(payload: &[u8], root: &Path) -> Option<AlertText> {
    let started = Instant::now();
    let context = PushAlertContext::from_payload(payload);
    let (hub, session, kind) = context.subject()?;
    let generic = generic_body(payload)?;
    // A mirror never written by this version counts as generic, so a phone
    // that has not opened the app since the update shows nothing new.
    if !AlertActions::load(&AlertActions::path_in(root))?.details() {
        return None;
    }
    let entry = hub_store::load(&root.join(hub_store::HUB_STORE_FILE))
        .ok()?
        .hubs
        .into_iter()
        .find(|entry| entry.id == hub)?;
    let probe = crate::connect_to(&entry).ok()?;
    let row = probe
        .sessions
        .iter()
        .find(|row| row.session.session_id == session.as_str())?;
    let detail = match kind {
        PushKind::Approval => approval_detail(row, context.approval.as_ref()),
        PushKind::Done if row.conversation && started.elapsed() < ANSWER_BUDGET => {
            final_response(&entry, row).as_deref().and_then(answer_line)
        }
        PushKind::Done | PushKind::Input => None,
    };
    compose(&probe, row, generic, detail)
}

/// The relay's text, which says what happened in the phone's language.
fn generic_body(payload: &[u8]) -> Option<String> {
    let payload: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let body = payload.get("aps")?.get("alert")?.get("body")?.as_str()?;
    Some(body.to_string())
}

/// The agent's name and project over the relay's text, and what it asks or
/// said when there is a `detail`. An agent with neither a name nor a
/// project keeps the alert as it is.
fn compose(
    probe: &HubProbe,
    row: &HubProbeSession,
    generic: String,
    detail: Option<String>,
) -> Option<AlertText> {
    let name = row.session.session_name.as_deref().and_then(first_line);
    let project = row
        .presentation
        .as_ref()
        .and_then(|presentation| presentation.project_name.as_deref())
        .or_else(|| {
            let seat = probe
                .layout
                .as_ref()?
                .placements
                .get(&row.session.session_id)?;
            Some(seat.project.as_str())
        })
        .and_then(first_line);
    let title = match (name, project) {
        (Some(name), Some(project)) if name != project => format!("{name} · {project}"),
        (Some(name), _) => name,
        (None, Some(project)) => project,
        (None, None) => return None,
    };
    Some(match detail {
        Some(body) => AlertText {
            title,
            subtitle: Some(generic),
            body,
        },
        None => AlertText {
            title,
            subtitle: None,
            body: generic,
        },
    })
}

/// The tool and the first line of its input, for the approval the alert's
/// Allow once and Deny answer. A newer approval than the alerted one is not
/// shown: the alert's actions would not answer it.
fn approval_detail(row: &HubProbeSession, alerted: Option<&PushApproval>) -> Option<String> {
    let pending = row.presentation.as_ref()?.approval.as_ref()?;
    if alerted.is_some_and(|alerted| alerted.attention_id.as_str() != pending.attention_id) {
        return None;
    }
    let tool = first_line(&pending.request.tool_name)?;
    Some(
        match pending.request.summary.as_deref().and_then(first_line) {
            Some(input) => clip(&format!("{tool}: {input}")),
            None => tool,
        },
    )
}

/// The agent's last answer, as home's finished card reads it: the
/// transcript's `final_response`, asked with `limit: 0` so the computer
/// sends no messages.
fn final_response(entry: &hub_store::HubEntry, row: &HubProbeSession) -> Option<String> {
    let relay = entry
        .relay_endpoint
        .as_deref()
        .zip(entry.server_id.as_deref());
    let mut stream =
        crate::hub_client::dial_tls(&entry.endpoint, relay, &entry.fingerprint).ok()?;
    let request = HubRequest::ConversationTranscriptV1 {
        box_id: row.box_id.clone(),
        workspace_id: row.session.workspace_id.clone(),
        session_id: row.session.session_id.clone(),
        limit: Some(0),
        after: None,
    };
    crate::hub_conversation::transcript_on_stream(&mut stream, &entry.token, request)
        .ok()?
        .final_response
}

/// A character an alert can show. Controls and the invisible characters
/// that reorder or hide text are dropped, so an alert cannot show a request
/// other than the one its Allow once answers.
fn shown(character: char) -> bool {
    !character.is_control()
        && !matches!(
            character,
            '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

/// The first line with text in it, its whitespace collapsed, cut to
/// [`MAX_DETAIL_CHARS`].
fn first_line(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let words: Vec<String> = line
            .split_whitespace()
            .map(|word| word.chars().filter(|&character| shown(character)).collect())
            .filter(|word: &String| !word.is_empty())
            .collect();
        (!words.is_empty()).then(|| clip(&words.join(" ")))
    })
}

/// An answer's first line without the Markdown that only formats it: a
/// heading, quote or list marker, emphasis and code ticks. A code fence is
/// not a line of the answer.
fn answer_line(text: &str) -> Option<String> {
    text.lines()
        .filter(|line| !line.trim_start().starts_with("```"))
        .find_map(|line| {
            let mut line = line.trim_start();
            line = line.trim_start_matches('#').trim_start();
            line = line.trim_start_matches('>').trim_start();
            for marker in ["- ", "* ", "+ "] {
                line = line.strip_prefix(marker).unwrap_or(line);
            }
            if let Some((number, rest)) = line.split_once(". ") {
                if !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()) {
                    line = rest;
                }
            }
            first_line(&line.replace("**", "").replace("__", "").replace('`', ""))
        })
}

fn clip(text: &str) -> String {
    if text.chars().count() <= MAX_DETAIL_CHARS {
        return text.to_string();
    }
    let kept: String = text.chars().take(MAX_DETAIL_CHARS - 1).collect();
    format!("{}…", kept.trim_end())
}

/// The notification service extension's one call (`NotificationService.m`),
/// on a background queue for each alert that arrives: the alert's whole
/// JSON payload in, its new text out as a JSON [`AlertText`] the caller
/// releases with [`dure_alert_text_free`], or null to keep the alert as
/// delivered.
///
/// # Safety
/// `payload` is null or points to `length` readable bytes.
#[cfg(target_os = "ios")]
#[no_mangle]
pub unsafe extern "C" fn dure_alert_text(
    payload: *const u8,
    length: usize,
) -> *mut std::ffi::c_char {
    if payload.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: the caller passes `length` readable bytes at `payload`.
    let payload = unsafe { std::slice::from_raw_parts(payload, length) };
    // Nothing unwinds into the extension: a panic keeps the alert as it is.
    std::panic::catch_unwind(|| {
        let text = read(payload, &crate::shared_config::shared_root()?)?;
        std::ffi::CString::new(serde_json::to_string(&text).ok()?).ok()
    })
    .ok()
    .flatten()
    .map_or(std::ptr::null_mut(), std::ffi::CString::into_raw)
}

/// Releases a text [`dure_alert_text`] returned.
///
/// # Safety
/// `text` is null or a pointer [`dure_alert_text`] returned, released once.
#[cfg(target_os = "ios")]
#[no_mangle]
pub unsafe extern "C" fn dure_alert_text_free(text: *mut std::ffi::c_char) {
    if !text.is_null() {
        // SAFETY: `text` came from `CString::into_raw` in `dure_alert_text`.
        drop(unsafe { std::ffi::CString::from_raw(text) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_hub_protocol::catalog::{
        HubCatalog, HubCatalogEntry, SessionApproval, SessionApprovalRequest, SessionPresentation,
        HUB_CATALOG_VERSION,
    };

    fn entry(
        session: &str,
        name: Option<&str>,
        presentation: SessionPresentation,
    ) -> HubCatalogEntry {
        HubCatalogEntry {
            session_id: session.into(),
            session_name: Some("hmux-name".into()),
            display_title: name.map(str::to_string),
            presentation: Some(presentation),
            workspace_id: "workspace_0123456789abcdef".into(),
            session_class: "managed".into(),
            lifecycle: "ready".into(),
            provider_id: "claude".into(),
            runner_principal: "me".into(),
            runner_instance: "runner".into(),
            channel_epoch: "1".into(),
            host_instance_id: "host".into(),
            terminal_epoch: "7".into(),
            capabilities: Vec::new(),
            launch_program: None,
            conversation: true,
            background_work: false,
            approval_answer: true,
            box_id: "this-laptop".into(),
            box_label: "Laptop".into(),
        }
    }

    fn probe(entries: Vec<HubCatalogEntry>) -> HubProbe {
        let catalog = HubCatalog {
            hub_catalog_version: HUB_CATALOG_VERSION,
            sessions: entries,
            unreachable: Vec::new(),
            layout: None,
            push_registration: None,
            chat_sessions: Vec::new(),
        };
        let ack = dure_hub_protocol::hello::HubHelloAck {
            hub_hello_version: dure_hub_protocol::hello::HUB_HELLO_VERSION,
            device_id: "device-1".into(),
            device_label: "phone".into(),
        };
        crate::describe("hub-1", "Laptop", true, ack, &catalog)
    }

    fn pending(attention: &str, tool: &str, summary: Option<&str>) -> SessionPresentation {
        SessionPresentation {
            project_name: Some("dure".into()),
            approval: Some(SessionApproval {
                attention_id: attention.into(),
                request: SessionApprovalRequest {
                    tool_name: tool.into(),
                    summary: summary.map(str::to_string),
                    choices: vec!["approve".into(), "deny".into()],
                },
            }),
            ..SessionPresentation::default()
        }
    }

    fn alerted(attention: &str) -> PushApproval {
        PushApproval {
            attention_id: attention.to_string().try_into().unwrap(),
            terminal_epoch: "7".to_string().try_into().unwrap(),
        }
    }

    #[test]
    fn an_approval_alert_names_the_agent_its_project_and_the_alerted_request() {
        let probe = probe(vec![entry(
            "managed_1",
            Some("Fix the login"),
            pending("attention-3", "Bash", Some("npm test\n  -- --watch=false")),
        )]);
        let row = &probe.sessions[0];
        let detail = approval_detail(row, Some(&alerted("attention-3")));
        assert_eq!(detail.as_deref(), Some("Bash: npm test"));
        assert_eq!(
            compose(
                &probe,
                row,
                "An agent is waiting for your approval.".into(),
                detail
            ),
            Some(AlertText {
                title: "Fix the login · dure".into(),
                subtitle: Some("An agent is waiting for your approval.".into()),
                body: "Bash: npm test".into(),
            })
        );
        // A newer approval than the alerted one is not what its Allow once answers.
        assert_eq!(approval_detail(row, Some(&alerted("attention-4"))), None);
        // An alert that offers no answer shows what the agent waits on.
        assert_eq!(
            approval_detail(row, None).as_deref(),
            Some("Bash: npm test")
        );
    }

    #[test]
    fn without_a_detail_the_alert_keeps_its_text_under_the_agents_name() {
        let presentation = SessionPresentation::default();
        let probe = probe(vec![
            entry("managed_1", Some("Fix the login"), presentation.clone()),
            entry("managed_2", None, presentation),
        ]);
        let text = compose(
            &probe,
            &probe.sessions[0],
            "An agent finished its turn.".into(),
            None,
        );
        assert_eq!(
            text,
            Some(AlertText {
                title: "Fix the login".into(),
                subtitle: None,
                body: "An agent finished its turn.".into(),
            })
        );
        assert_eq!(approval_detail(&probe.sessions[0], None), None);
        // No desktop title: the agent's Hmux name, as home lists it.
        assert_eq!(
            compose(&probe, &probe.sessions[1], "x".into(), None).map(|text| text.title),
            Some("hmux-name".into())
        );
    }

    #[test]
    fn shown_text_is_one_bounded_line_without_controls_or_reordering_characters() {
        assert_eq!(
            first_line("\n  \n\trm -rf\u{202E}gpj.exe\u{200B} build  \nnext").as_deref(),
            Some("rm -rfgpj.exe build")
        );
        assert_eq!(first_line(" \n\u{200B}\n"), None);
        let long = first_line(&"word ".repeat(100)).unwrap();
        assert_eq!(long.chars().count(), MAX_DETAIL_CHARS);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn an_answer_line_drops_the_markdown_that_only_formats_it() {
        for (answer, line) in [
            (
                "## **Done.** All tests pass.\n\nDetails…",
                "Done. All tests pass.",
            ),
            ("```rust\nfn main() {}\n```", "fn main() {}"),
            ("> Note\n", "Note"),
            ("- Fixed `login`\n- Added tests", "Fixed login"),
            ("1. Ran the suite", "Ran the suite"),
            ("2026. A year", "A year"),
        ] {
            assert_eq!(answer_line(answer).as_deref(), Some(line), "{answer}");
        }
        assert_eq!(answer_line("```\n```"), None);
    }

    #[test]
    fn the_relays_text_is_the_alert_body_and_an_older_relay_has_no_subject() {
        let payload = br#"{"aps":{"alert":{"title":"Dure","body":"An agent finished its turn."}},"dure":{"session":"managed_1"}}"#;
        assert_eq!(
            generic_body(payload).as_deref(),
            Some("An agent finished its turn.")
        );
        let root = tempfile::tempdir().unwrap();
        assert_eq!(read(payload, root.path()), None);
    }

    #[test]
    fn alerts_stay_generic_until_the_screen_allows_details() {
        let hub = dure_hub_protocol::fingerprint::of_der(b"hub");
        let payload = format!(
            r#"{{"aps":{{"alert":{{"title":"Dure","body":"x"}}}},"dure":{{"session":"managed_1","kind":"done","hub":"{hub}"}}}}"#
        );
        let root = tempfile::tempdir().unwrap();
        // Never mirrored, then mirrored off: no computer is asked, as no
        // paired computer is stored.
        assert_eq!(read(payload.as_bytes(), root.path()), None);
        let mirror = |details: bool| {
            serde_json::json!({
                "ownerCheck": false, "details": details, "approve": "Allow once",
                "deny": "Deny", "failed": "f", "reply": "Reply", "send": "Send",
                "placeholder": "p", "replyFailed": "r",
            })
        };
        for details in [false, true] {
            std::fs::write(
                AlertActions::path_in(root.path()),
                serde_json::to_vec(&mirror(details)).unwrap(),
            )
            .unwrap();
            assert!(AlertActions::load(&AlertActions::path_in(root.path()))
                .is_some_and(|actions| actions.details() == details));
            // On, but this computer is not paired: still the relay's text.
            assert_eq!(read(payload.as_bytes(), root.path()), None);
        }
    }
}
