#[cfg(target_os = "ios")]
use crate::hub_store;
use crate::{
    hub_client,
    hub_conversation::{ApprovalAnswerInput, PromptInput},
    CommandError, HubProbe,
};
use dure_hub_protocol::{
    conversation::{AgentPromptState, HubAgentPromptResult},
    frame,
    hello::HubRequest,
    push::{
        PushAlertContext, PushApproval, PushId, PushLanguage, PushPreference, PushReply,
        PushSubscription, PushSubscriptionResult, PUSH_APPROVAL_CATEGORY, PUSH_REPLY_CATEGORY,
    },
};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{ipc::Channel, Manager};
use tauri_plugin_notification::{Action, ActionType, NotificationExt};

/// A tapped alert, for the screen to open its agent as a tap on its row would.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushActivation {
    /// The phone's catalog key for the agent (`PushId`).
    session_id: String,
    /// Allow once or Deny, pressed while approvals need Face ID: the screen
    /// answers it past its approval sheet, as a Needs you card does.
    #[serde(skip_serializing_if = "Option::is_none")]
    answer: Option<ActivationAnswer>,
}

/// The approval an alert's action answers, and how.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationAnswer {
    choice: &'static str,
    attention_id: String,
    terminal_epoch: String,
}

impl PushActivation {
    /// The activation a tap on this delivered alert asks for, read from the
    /// alert's whole JSON payload. None for an alert that names no agent.
    pub fn from_payload(payload: &[u8]) -> Option<Self> {
        PushAlertContext::from_payload(payload)
            .session
            .map(|session| Self {
                session_id: session.into(),
                answer: None,
            })
    }
}

/// The alert actions [`push_alert_actions`] registers under
/// [`PUSH_APPROVAL_CATEGORY`], and the Host choice each one sends.
const APPROVAL_ACTIONS: [(&str, &str); 2] = [
    ("dure.approval.approve", "approve"),
    ("dure.approval.deny", "deny"),
];

/// The Host choice an alert action sends, or none for any other action.
pub fn action_choice(action: &str) -> Option<&'static str> {
    APPROVAL_ACTIONS
        .iter()
        .find(|(id, _)| *id == action)
        .map(|(_, choice)| *choice)
}

/// The text action [`push_alert_actions`] registers under [`PUSH_REPLY_CATEGORY`].
pub const REPLY_ACTION: &str = "dure.reply.send";

/// The screen's approval preference and alert copy, kept here for alert
/// actions, which run when no screen does. The screen owns them and sends
/// them again whenever they change; this file is only their mirror.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlertActions {
    /// Face ID before an approval (the screen's `approvalBiometric`). The
    /// approval actions then open the app, whose approval sheet asks.
    owner_check: bool,
    approve: String,
    deny: String,
    /// What the phone says when an answer from an alert did not land.
    failed: String,
    /// The reply action, its send button and its field's placeholder.
    reply: String,
    send: String,
    placeholder: String,
    /// What the phone says when a reply from an alert did not land.
    reply_failed: String,
}

impl AlertActions {
    fn path(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
        Ok(crate::config_root(app)?.join("push-alert-actions.json"))
    }

    fn load(path: &Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }

    fn load_for(app: &tauri::AppHandle) -> Option<Self> {
        Self::load(&Self::path(app).ok()?)
    }

    /// Written whole and swapped in, so an alert never reads half a file.
    fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, serde_json::to_vec(self)?)?;
        std::fs::rename(&temporary, path)
    }
}

/// What the phone tells the person when an answer from an alert did not land.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailureNotice {
    pub body: String,
    /// The agent, so a tap on the notice opens it.
    pub session: String,
}

/// What an Allow once or Deny on an alert becomes.
#[derive(Debug, PartialEq, Eq)]
enum AlertAnswer {
    /// The screen answers it past its approval sheet: the action opened the app.
    Screen(PushActivation),
    /// Answered from here, on the computer the alert came from.
    Here {
        hub: String,
        session: PushId,
        approval: PushApproval,
    },
    /// Nothing this alert can answer.
    Unanswerable,
}

fn alert_answer(
    context: &PushAlertContext,
    actions: Option<&AlertActions>,
    choice: &'static str,
) -> AlertAnswer {
    let Some((hub, session, approval)) = context.answerable() else {
        return AlertAnswer::Unanswerable;
    };
    // An unknown preference counts as Face ID: no answer skips a sheet it may need.
    if actions.is_none_or(|actions| actions.owner_check) {
        return AlertAnswer::Screen(PushActivation {
            session_id: session.as_str().to_string(),
            answer: Some(ActivationAnswer {
                choice,
                attention_id: approval.attention_id.as_str().to_string(),
                terminal_epoch: approval.terminal_epoch.as_str().to_string(),
            }),
        });
    }
    AlertAnswer::Here {
        hub: hub.to_string(),
        session: session.clone(),
        approval: approval.clone(),
    }
}

/// The answer the screen's card for this agent would send: the catalog
/// names the box and workspace, the alert the approval. The Host admits it
/// only while that exact approval of that process is still pending.
fn approval_target(
    probe: &HubProbe,
    session: &PushId,
    approval: &PushApproval,
    choice: &str,
) -> Option<ApprovalAnswerInput> {
    let row = probe
        .sessions
        .iter()
        .find(|row| row.session.session_id == session.as_str() && row.approval_answer)?;
    Some(ApprovalAnswerInput {
        box_id: row.box_id.clone(),
        workspace_id: row.session.workspace_id.clone(),
        session_id: row.session.session_id.clone(),
        expected_terminal_epoch: approval.terminal_epoch.as_str().to_string(),
        attention_id: approval.attention_id.as_str().to_string(),
        choice: choice.to_string(),
    })
}

/// Allow once or Deny pressed on an alert. `done` is called once, when
/// nothing more will happen, with what to tell the person if it failed.
pub fn answer_from_alert(
    app: &tauri::AppHandle,
    payload: &[u8],
    choice: &'static str,
    done: impl FnOnce(Option<FailureNotice>) + Send + 'static,
) {
    let context = PushAlertContext::from_payload(payload);
    let actions = AlertActions::load_for(app);
    let notice = |actions: Option<&AlertActions>| {
        Some(FailureNotice {
            body: actions?.failed.clone(),
            session: context.session.as_ref()?.as_str().to_string(),
        })
    };
    match alert_answer(&context, actions.as_ref(), choice) {
        AlertAnswer::Screen(activation) => {
            app.state::<PushActivations>().offer(activation);
            done(None);
        }
        AlertAnswer::Unanswerable => done(notice(actions.as_ref())),
        AlertAnswer::Here {
            hub,
            session,
            approval,
        } => {
            let failed = notice(actions.as_ref());
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let landed = answer_here(&app, hub, &session, &approval, choice).await;
                done(if landed { None } else { failed });
            });
        }
    }
}

async fn answer_here(
    app: &tauri::AppHandle,
    hub: String,
    session: &PushId,
    approval: &PushApproval,
    choice: &str,
) -> bool {
    let Some(probe) = catalog_of(app, &hub).await else {
        return false;
    };
    let Some(input) = approval_target(&probe, session, approval, choice) else {
        return false;
    };
    written(crate::hub_conversation::answer_approval(app, &hub, input).await)
}

/// The prompt the chat's composer would send to this agent: the catalog
/// names the box and workspace and must serve the agent's conversation, the
/// alert names the process. The Host admits it only while that process is
/// idle with nothing raised.
fn reply_target(
    probe: &HubProbe,
    session: &PushId,
    reply: &PushReply,
    text: &str,
) -> Option<PromptInput> {
    let row = probe
        .sessions
        .iter()
        .find(|row| row.session.session_id == session.as_str() && row.conversation)?;
    Some(PromptInput {
        box_id: row.box_id.clone(),
        workspace_id: row.session.workspace_id.clone(),
        session_id: row.session.session_id.clone(),
        text: text.to_string(),
        expected_terminal_epoch: reply.terminal_epoch.as_str().to_string(),
        expected_conversation_id: None,
    })
}

/// Text sent from a finished turn's alert. `done` is called once, when
/// nothing more will happen, with what to tell the person if it failed. An
/// empty reply sends nothing and says nothing.
pub fn reply_from_alert(
    app: &tauri::AppHandle,
    payload: &[u8],
    text: String,
    done: impl FnOnce(Option<FailureNotice>) + Send + 'static,
) {
    let context = PushAlertContext::from_payload(payload);
    let failed = AlertActions::load_for(app).and_then(|actions| {
        Some(FailureNotice {
            body: actions.reply_failed,
            session: context.session.as_ref()?.as_str().to_string(),
        })
    });
    if text.trim().is_empty() {
        return done(None);
    }
    let Some((hub, session, reply)) = context.repliable() else {
        return done(failed);
    };
    let (app, hub, session, reply) = (app.clone(), hub.to_string(), session.clone(), reply.clone());
    tauri::async_runtime::spawn(async move {
        let landed = reply_here(&app, hub, &session, &reply, &text).await;
        done(if landed { None } else { failed });
    });
}

async fn reply_here(
    app: &tauri::AppHandle,
    hub: String,
    session: &PushId,
    reply: &PushReply,
    text: &str,
) -> bool {
    let Some(probe) = catalog_of(app, &hub).await else {
        return false;
    };
    let Some(input) = reply_target(&probe, session, reply, text) else {
        return false;
    };
    written(crate::hub_conversation::send_prompt(app, &hub, input).await)
}

/// The paired computer's catalog, read the way the screen's `hub_open` reads it.
async fn catalog_of(app: &tauri::AppHandle, hub: &str) -> Option<HubProbe> {
    let entry = crate::hub_target(app, hub).ok()?;
    tauri::async_runtime::spawn_blocking(move || crate::connect_to(&entry))
        .await
        .ok()?
        .ok()
}

/// Whether the Host confirmed it wrote the answer or prompt.
fn written(result: Result<HubAgentPromptResult, CommandError>) -> bool {
    matches!(
        result,
        Ok(HubAgentPromptResult {
            state: AgentPromptState::WrittenToPty,
            ..
        })
    )
}

/// The screen's approval preference or copy changed, or it started: keep
/// the mirror and register the alert actions to match. With Face ID on, the
/// approval actions open the app; otherwise they answer without it, once the
/// phone is unlocked. A reply always needs the phone unlocked.
#[tauri::command]
pub fn push_alert_actions(
    app: tauri::AppHandle,
    actions: AlertActions,
) -> Result<(), CommandError> {
    let error = |message: String| CommandError {
        code: "push_actions_failed".into(),
        message,
    };
    if [
        &actions.approve,
        &actions.deny,
        &actions.failed,
        &actions.reply,
        &actions.send,
        &actions.placeholder,
        &actions.reply_failed,
    ]
    .iter()
    .any(|text| text.trim().is_empty() || text.len() > 512)
    {
        return Err(error("Alert action copy is missing or too long".into()));
    }
    actions
        .save(&AlertActions::path(&app)?)
        .map_err(|failure| error(failure.to_string()))?;
    let titles = [&actions.approve, &actions.deny];
    let buttons = APPROVAL_ACTIONS
        .iter()
        .zip(titles)
        .map(|((id, _), title)| {
            Action::builder(*id, title.as_str())
                .foreground(actions.owner_check)
                .requires_authentication(!actions.owner_check)
                .build()
        })
        .collect();
    let reply = Action::builder(REPLY_ACTION, actions.reply.as_str())
        .input(true)
        .input_button_title(actions.send.as_str())
        .input_placeholder(actions.placeholder.as_str())
        .requires_authentication(true)
        .build();
    app.notification()
        .register_action_types(vec![
            ActionType::builder(PUSH_APPROVAL_CATEGORY)
                .actions(buttons)
                .build(),
            ActionType::builder(PUSH_REPLY_CATEGORY)
                .actions(vec![reply])
                .build(),
        ])
        .map_err(|failure| error(failure.to_string()))
}

type ActivationReceiver = Box<dyn Fn(PushActivation) -> bool + Send>;

/// Taps on alerts, between the system and the screen. A tap that launches
/// the app arrives before the WebView listens, so the latest one waits here;
/// an earlier unread tap is superseded, as only one agent can be opened.
#[derive(Default)]
pub struct PushActivations {
    inner: Mutex<(Option<PushActivation>, Option<ActivationReceiver>)>,
}

impl PushActivations {
    /// The system reported a tap.
    pub fn offer(&self, activation: PushActivation) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(receiver) = &inner.1 {
            if receiver(activation.clone()) {
                return;
            }
            // The screen that listened is gone; the next one reads this tap.
            inner.1 = None;
        }
        inner.0 = Some(activation);
    }

    /// The screen listens. A waiting tap is delivered first; a newer screen
    /// replaces an older one.
    fn listen(&self, receiver: ActivationReceiver) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(waiting) = inner.0.take() {
            if !receiver(waiting.clone()) {
                inner.0 = Some(waiting);
                return;
            }
        }
        inner.1 = Some(receiver);
    }
}

/// The screen's channel for alert taps (`PushActivations`).
#[tauri::command]
pub fn push_activations(
    activations: tauri::State<'_, PushActivations>,
    channel: Channel<PushActivation>,
) {
    activations.listen(Box::new(move |activation| channel.send(activation).is_ok()));
}

#[derive(Serialize)]
pub struct PushSyncResult {
    supported: bool,
    outcomes: Vec<HubPushOutcome>,
}

#[derive(Serialize)]
struct HubPushOutcome {
    id: String,
    error: Option<String>,
}

pub fn update_on_stream(
    stream: &mut (impl Read + Write),
    pairing_token: &str,
    subscription: Option<PushSubscription>,
) -> Result<(), hub_client::HubClientError> {
    hub_client::handshake_for(
        stream,
        pairing_token,
        HubRequest::UpdatePushSubscriptionV1 { subscription },
    )?;
    let result: PushSubscriptionResult = frame::read(stream, 4096)
        .map_err(|error| hub_client::HubClientError::Protocol(error.to_string()))?;
    match result {
        PushSubscriptionResult::Saved => Ok(()),
        PushSubscriptionResult::Refused { detail } => {
            Err(hub_client::HubClientError::Protocol(detail))
        }
    }
}

#[cfg(target_os = "ios")]
fn synchronize(
    entry: &hub_store::HubEntry,
    subscription: Option<PushSubscription>,
) -> Result<(), hub_client::HubClientError> {
    let relay = entry
        .relay_endpoint
        .as_deref()
        .zip(entry.server_id.as_deref());
    let mut stream = hub_client::dial_tls(&entry.endpoint, relay, &entry.fingerprint)?;
    update_on_stream(&mut stream, &entry.token, subscription)
}

#[tauri::command]
pub async fn sync_push_notifications(
    app: tauri::AppHandle,
    preference: Option<PushPreference>,
    language: PushLanguage,
) -> Result<PushSyncResult, CommandError> {
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, preference, language);
        Ok(PushSyncResult {
            supported: false,
            outcomes: Vec::new(),
        })
    }
    #[cfg(target_os = "ios")]
    {
        let error = |message: String| CommandError {
            code: "push_registration_failed".into(),
            message,
        };
        let hubs = hub_store::load(&crate::hub_store_path(&app)?)?.hubs;
        let subscription = if let Some(preference) = preference {
            if hubs.is_empty() {
                return Ok(PushSyncResult {
                    supported: true,
                    outcomes: Vec::new(),
                });
            }
            let (token, environment) = crate::push_ios::register(&app).await.map_err(error)?;
            Some(PushSubscription {
                token,
                environment,
                preference,
                language,
            })
        } else {
            crate::push_ios::unregister(&app).map_err(error)?;
            None
        };
        let outcomes = tauri::async_runtime::spawn_blocking(move || {
            hubs.into_iter()
                .map(|entry| HubPushOutcome {
                    id: entry.id.clone(),
                    error: synchronize(&entry, subscription.clone())
                        .err()
                        .map(|error| error.to_string()),
                })
                .collect()
        })
        .await
        .map_err(|_| error("Push synchronization was interrupted".into()))?;
        Ok(PushSyncResult {
            supported: true,
            outcomes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_hub_protocol::{
        hello,
        push::{ApnsEnvironment, PushLanguage, PushPreference},
    };
    use std::io::Cursor;

    struct Stream {
        reply: Cursor<Vec<u8>>,
        request: Vec<u8>,
    }
    impl Read for Stream {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            self.reply.read(bytes)
        }
    }
    impl Write for Stream {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.request.write(bytes)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    fn stream(result: Option<PushSubscriptionResult>) -> Stream {
        let mut reply = hello::encode_ack("device-1", "Phone").unwrap();
        if let Some(result) = result {
            reply.extend(frame::encode(&result, 4096).unwrap());
        }
        Stream {
            reply: Cursor::new(reply),
            request: Vec::new(),
        }
    }

    #[test]
    fn registration_and_off_use_the_paired_request_without_terminal_attachment() {
        let subscription = PushSubscription {
            token: "aa12".to_string().try_into().unwrap(),
            environment: ApnsEnvironment::Sandbox,
            preference: PushPreference::Approvals,
            language: PushLanguage::Ko,
        };
        for subscription in [Some(subscription), None] {
            let mut stream = stream(Some(PushSubscriptionResult::Saved));
            update_on_stream(&mut stream, "paired-token", subscription.clone()).unwrap();
            let hello = hello::read_hello(&mut Cursor::new(stream.request)).unwrap();
            assert_eq!(hello.token, "paired-token");
            assert_eq!(
                hello.request,
                HubRequest::UpdatePushSubscriptionV1 { subscription }
            );
        }
    }

    #[test]
    fn a_tap_that_launched_the_app_waits_for_the_screen_and_the_latest_wins() {
        use std::sync::{Arc, Mutex};
        let tap = |session: &str| {
            PushActivation::from_payload(
                format!(r#"{{"aps":{{}},"dure":{{"session":"{session}"}}}}"#).as_bytes(),
            )
            .unwrap()
        };
        assert_eq!(PushActivation::from_payload(br#"{"aps":{}}"#), None);
        let activations = PushActivations::default();
        activations.offer(tap("agent-1"));
        activations.offer(tap("agent-2"));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let screen = |seen: &Arc<Mutex<Vec<String>>>, open: bool| -> ActivationReceiver {
            let seen = seen.clone();
            Box::new(move |activation: PushActivation| {
                if open {
                    seen.lock().unwrap().push(activation.session_id);
                }
                open
            })
        };
        activations.listen(screen(&seen, true));
        activations.offer(tap("agent-3"));
        assert_eq!(*seen.lock().unwrap(), ["agent-2", "agent-3"]);
        // A screen that stopped listening loses no tap: the next one reads it.
        activations.listen(screen(&seen, false));
        activations.offer(tap("agent-4"));
        activations.listen(screen(&seen, true));
        assert_eq!(*seen.lock().unwrap(), ["agent-2", "agent-3", "agent-4"]);
    }

    fn approval_alert(owner_check: Option<bool>) -> (PushAlertContext, Option<AlertActions>) {
        let hub = dure_hub_protocol::fingerprint::of_der(b"hub");
        let context = PushAlertContext::from_payload(
            format!(
                r#"{{"aps":{{}},"dure":{{"session":"managed_1","hub":"{hub}","approval":{{"attentionId":"attention-3","terminalEpoch":"7"}}}}}}"#
            )
            .as_bytes(),
        );
        let actions = owner_check.map(|owner_check| AlertActions {
            owner_check,
            approve: "Allow once".into(),
            deny: "Deny".into(),
            failed: "Dure could not answer that approval.".into(),
            reply: "Reply".into(),
            send: "Send".into(),
            placeholder: "Message the agent".into(),
            reply_failed: "Dure could not send that reply.".into(),
        });
        (context, actions)
    }

    #[test]
    fn an_alert_action_is_answered_here_only_when_approvals_need_no_face_id() {
        assert_eq!(action_choice("dure.approval.approve"), Some("approve"));
        assert_eq!(action_choice("dure.approval.deny"), Some("deny"));
        assert_eq!(
            action_choice("com.apple.UNNotificationDefaultActionIdentifier"),
            None
        );

        let (context, actions) = approval_alert(Some(false));
        assert!(matches!(
            alert_answer(&context, actions.as_ref(), "approve"),
            AlertAnswer::Here { hub, session, approval }
                if hub == dure_hub_protocol::fingerprint::of_der(b"hub")
                    && session.as_str() == "managed_1"
                    && approval.attention_id.as_str() == "attention-3"
        ));
        // Face ID on, or a preference never mirrored: the screen answers past its sheet.
        for owner_check in [Some(true), None] {
            let (context, actions) = approval_alert(owner_check);
            assert_eq!(
                alert_answer(&context, actions.as_ref(), "deny"),
                AlertAnswer::Screen(PushActivation {
                    session_id: "managed_1".into(),
                    answer: Some(ActivationAnswer {
                        choice: "deny",
                        attention_id: "attention-3".into(),
                        terminal_epoch: "7".into(),
                    }),
                })
            );
        }
        let tap_only =
            PushAlertContext::from_payload(br#"{"aps":{},"dure":{"session":"managed_1"}}"#);
        let (_, actions) = approval_alert(Some(false));
        assert_eq!(
            alert_answer(&tap_only, actions.as_ref(), "approve"),
            AlertAnswer::Unanswerable
        );
    }

    /// A computer's catalog as the phone reads it: each session with whether
    /// it serves the agent's conversation and answers its approvals.
    fn probe_of(sessions: &[(&str, bool, bool)]) -> HubProbe {
        let entry = |&(session, conversation, approval_answer): &(&str, bool, bool)| {
            dure_hub_protocol::catalog::HubCatalogEntry {
                session_id: session.into(),
                session_name: None,
                display_title: None,
                presentation: None,
                workspace_id: "workspace_0123456789abcdef".into(),
                session_class: "managed".into(),
                lifecycle: "ready".into(),
                provider_id: "claude".into(),
                runner_principal: "me".into(),
                runner_instance: "runner".into(),
                channel_epoch: "1".into(),
                host_instance_id: "host".into(),
                // The catalog's process; the alert's epoch is what an answer fences on.
                terminal_epoch: "8".into(),
                capabilities: Vec::new(),
                launch_program: None,
                conversation,
                background_work: false,
                approval_answer,
                box_id: "this-laptop".into(),
                box_label: "Laptop".into(),
            }
        };
        let catalog = dure_hub_protocol::catalog::HubCatalog {
            hub_catalog_version: dure_hub_protocol::catalog::HUB_CATALOG_VERSION,
            sessions: sessions.iter().map(entry).collect(),
            unreachable: Vec::new(),
            layout: None,
            chat_sessions: Vec::new(),
        };
        let ack = dure_hub_protocol::hello::HubHelloAck {
            hub_hello_version: dure_hub_protocol::hello::HUB_HELLO_VERSION,
            device_id: "device-1".into(),
            device_label: "phone".into(),
        };
        crate::describe("hub-1", "Laptop", false, ack, &catalog)
    }

    #[test]
    fn a_reply_from_an_alert_is_the_composers_prompt_fenced_on_the_alerted_process() {
        assert_eq!(REPLY_ACTION, "dure.reply.send");
        assert_eq!(action_choice(REPLY_ACTION), None);
        let hub = dure_hub_protocol::fingerprint::of_der(b"hub");
        let context = PushAlertContext::from_payload(
            format!(
                r#"{{"aps":{{}},"dure":{{"session":"managed_1","hub":"{hub}","reply":{{"terminalEpoch":"7"}}}}}}"#
            )
            .as_bytes(),
        );
        let (computer, session, reply) = context.repliable().unwrap();
        assert_eq!(computer, hub);
        let probe = probe_of(&[("managed_1", true, false), ("managed_2", false, false)]);
        let input = reply_target(&probe, session, reply, "Now run the tests").unwrap();
        assert_eq!(
            (
                input.box_id.as_str(),
                input.workspace_id.as_str(),
                input.session_id.as_str(),
                input.text.as_str(),
                input.expected_terminal_epoch.as_str(),
                input.expected_conversation_id.as_deref(),
            ),
            (
                "this-laptop",
                "workspace_0123456789abcdef",
                "managed_1",
                "Now run the tests",
                "7",
                None
            )
        );
        // A computer that does not serve this agent's prompts is not asked.
        let other: PushId = "managed_2".to_string().try_into().unwrap();
        assert!(reply_target(&probe, &other, reply, "Now run the tests").is_none());
    }

    #[test]
    fn an_alert_answer_names_the_catalog_target_and_the_alerted_approval() {
        let probe = probe_of(&[("managed_1", true, true), ("managed_2", true, false)]);
        let (context, _) = approval_alert(Some(false));
        let (_, session, approval) = context.answerable().unwrap();
        let input = approval_target(&probe, session, approval, "approve").unwrap();
        assert_eq!(
            (
                input.box_id.as_str(),
                input.workspace_id.as_str(),
                input.session_id.as_str(),
                input.expected_terminal_epoch.as_str(),
                input.attention_id.as_str(),
                input.choice.as_str(),
            ),
            (
                "this-laptop",
                "workspace_0123456789abcdef",
                "managed_1",
                "7",
                "attention-3",
                "approve"
            )
        );
        // A computer that does not answer this agent's approvals is not asked.
        let other: PushId = "managed_2".to_string().try_into().unwrap();
        assert!(approval_target(&probe, &other, approval, "approve").is_none());
        let missing: PushId = "managed_9".to_string().try_into().unwrap();
        assert!(approval_target(&probe, &missing, approval, "approve").is_none());
    }

    #[test]
    fn the_approval_preference_mirror_is_written_whole_and_read_back() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("config").join("push-alert-actions.json");
        assert_eq!(AlertActions::load(&path), None);
        let (_, actions) = approval_alert(Some(true));
        let actions = actions.unwrap();
        actions.save(&path).unwrap();
        assert_eq!(AlertActions::load(&path), Some(actions));
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::write(&path, br#"{"ownerCheck":false}"#).unwrap();
        assert_eq!(AlertActions::load(&path), None);
    }

    #[test]
    fn old_hubs_and_refused_registrations_are_not_reported_as_saved() {
        let mut old_hub = stream(None);
        assert!(update_on_stream(&mut old_hub, "paired-token", None).is_err());
        let mut refused = stream(Some(PushSubscriptionResult::Refused {
            detail: "Service unavailable".into(),
        }));
        let error = update_on_stream(&mut refused, "paired-token", None).unwrap_err();
        assert!(error.to_string().contains("Service unavailable"));
    }
}
