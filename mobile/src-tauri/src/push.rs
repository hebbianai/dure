use crate::{
    hub_conversation::{ApprovalAnswerInput, PromptInput},
    hub_store::HubEntry,
    CommandError, HubProbe,
};
use dure_hub_protocol::{
    conversation::{AgentPromptState, HubAgentPromptResult},
    push::{
        PushAlertContext, PushApproval, PushId, PushLanguage, PushPreference, PushRefusal,
        PushReply, PUSH_APPROVAL_CATEGORY, PUSH_REPLY_CATEGORY,
    },
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{ipc::Channel, Manager};
use tauri_plugin_notification::{Action, ActionType, NotificationExt};

/// A tapped alert, for the screen to open its agent as a tap on its row would.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushActivation {
    /// The paired computer the alert came from (`HubEntry::id`): another
    /// computer may list an agent under the same key.
    hub: String,
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
    /// alert's whole JSON payload. None for an alert that names no agent, or
    /// no computer in `hubs`.
    fn from_payload(payload: &[u8], hubs: &[HubEntry]) -> Option<Self> {
        let context = PushAlertContext::from_payload(payload);
        Some(Self {
            hub: paired(hubs, context.hub.as_deref()?)?.id.clone(),
            session_id: context.session?.into(),
            answer: None,
        })
    }
}

/// The paired computer `hub` names (`HubEntry::id`), or None.
///
/// Every tap, answer and reply from an alert goes through here: an alert
/// from a computer this phone does not hold, such as one it forgot, opens
/// nothing and answers nothing. The push service fills in the alert's
/// computer from the certificate that signed the request, so the computer
/// cannot name another.
fn paired<'a>(hubs: &'a [HubEntry], hub: &str) -> Option<&'a HubEntry> {
    hubs.iter().find(|entry| entry.id == hub)
}

/// The computers this phone is paired with. Empty when the store cannot be
/// read: no alert is then from a paired computer.
fn paired_hubs(app: &tauri::AppHandle) -> Vec<HubEntry> {
    crate::hub_store_path(app)
        .ok()
        .and_then(|path| crate::hub_store::load(&path).ok())
        .map(|document| document.hubs)
        .unwrap_or_default()
}

/// A tap on a delivered alert, or on a notice this phone posted about one:
/// the screen opens its agent.
pub fn open_from_alert(app: &tauri::AppHandle, payload: &[u8]) {
    if let Some(activation) = PushActivation::from_payload(payload, &paired_hubs(app)) {
        app.state::<PushActivations>().offer(activation);
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
    /// Name the agent and what it asks or said in its alerts (the screen's
    /// `alertDetails`). Off, or from a mirror older than the setting, the
    /// notification service extension leaves every alert generic.
    #[serde(default)]
    details: bool,
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
        Ok(Self::path_in(&crate::config_root(app)?))
    }

    /// The mirror's file in the device configuration directory, which the
    /// notification service extension reads too.
    pub(crate) fn path_in(root: &Path) -> PathBuf {
        root.join("push-alert-actions.json")
    }

    pub(crate) fn load(path: &Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }

    /// Whether alerts may name the agent and what it asks or said.
    #[cfg(any(target_os = "ios", test))]
    pub(crate) fn details(&self) -> bool {
        self.details
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
    /// The agent and its computer, so a tap on the notice opens it.
    pub session: String,
    pub hub: Option<String>,
}

impl FailureNotice {
    /// The notice for an alert that names an agent, with this `body`.
    fn about(context: &PushAlertContext, body: String) -> Option<Self> {
        Some(Self {
            body,
            session: context.session.as_ref()?.as_str().to_string(),
            hub: context.hub.clone(),
        })
    }
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
    hubs: &[HubEntry],
    actions: Option<&AlertActions>,
    choice: &'static str,
) -> AlertAnswer {
    let Some((hub, session, approval)) = context
        .answerable()
        .filter(|(hub, _, _)| paired(hubs, hub).is_some())
    else {
        return AlertAnswer::Unanswerable;
    };
    // An unknown preference counts as Face ID: no answer skips a sheet it may need.
    if actions.is_none_or(|actions| actions.owner_check) {
        return AlertAnswer::Screen(PushActivation {
            hub: hub.to_string(),
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
    let notice =
        |actions: Option<&AlertActions>| FailureNotice::about(&context, actions?.failed.clone());
    match alert_answer(&context, &paired_hubs(app), actions.as_ref(), choice) {
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
    let failed = AlertActions::load_for(app)
        .and_then(|actions| FailureNotice::about(&context, actions.reply_failed));
    if text.trim().is_empty() {
        return done(None);
    }
    let Some((hub, session, reply)) = reply_to(&context, &paired_hubs(app)) else {
        return done(failed);
    };
    let (app, hub, session, reply) = (app.clone(), hub.to_string(), session.clone(), reply.clone());
    tauri::async_runtime::spawn(async move {
        let landed = reply_here(&app, hub, &session, &reply, &text).await;
        done(if landed { None } else { failed });
    });
}

/// What a reply from this alert reaches: the agent and its process on a
/// paired computer. None for an alert that takes no reply, or comes from a
/// computer this phone does not hold.
fn reply_to<'a>(
    context: &'a PushAlertContext,
    hubs: &[HubEntry],
) -> Option<(&'a str, &'a PushId, &'a PushReply)> {
    context
        .repliable()
        .filter(|(hub, _, _)| paired(hubs, hub).is_some())
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
    let generation = crate::device_reset::current_generation();
    let entry = crate::hub_target(app, hub).ok()?;
    let probe = tauri::async_runtime::spawn_blocking(move || crate::connect_to(&entry))
        .await
        .ok()?
        .ok()?;
    crate::remember_push_registration(app, &probe, generation);
    Some(probe)
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

/// How long forgetting a computer waits for it to hear that alerts stop.
#[cfg(target_os = "ios")]
const FORGET_BUDGET: std::time::Duration = std::time::Duration::from_secs(3);

/// Asks a computer about to be forgotten to stop sending this phone alerts,
/// waiting at most [`FORGET_BUDGET`]. Best effort: a computer that is off or
/// slow keeps its subscription until the epoch the forget raises supersedes
/// its grant, so the forget never waits on it.
pub async fn stop_alerts_before_forget(entry: HubEntry) {
    #[cfg(target_os = "ios")]
    {
        let stopped = tauri::async_runtime::spawn_blocking(move || {
            crate::push_sync::within(FORGET_BUDGET, move || crate::push_sync::stop_alerts(&entry))
        })
        .await;
        if let Ok(Some(Err(detail))) = stopped {
            eprintln!("A forgotten computer was not told to stop alerts: {detail}");
        }
    }
    #[cfg(not(target_os = "ios"))]
    {
        // Only iOS registers alerts with a computer: nothing to stop.
        let _ = entry;
    }
}

#[derive(Serialize)]
pub struct PushSyncResult {
    supported: bool,
    outcomes: Vec<HubPushOutcome>,
}

/// One computer's part of a sync, as the screen reports it. Built by
/// [`crate::push_sync`].
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct HubPushOutcome {
    pub(crate) id: String,
    /// The computer's name, for the note that says which computer it was.
    pub(crate) computer: String,
    pub(crate) error: Option<String>,
    /// Why, when the phone or the computer could name it. The screen picks
    /// its note by this; `error` is the computer's own sentence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) code: Option<SyncCode>,
}

/// Why one computer's registration did not finish.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncCode {
    /// The service challenged this phone's key and the challenge alert did
    /// not arrive in time to be signed back; the next sync finishes it.
    SetupPending,
    /// The connection ended before the computer answered. Retried on the
    /// next sync, never by asking in the older version.
    ComputerUnreachable,
    /// A computer that reads only the first version refused: updating Dure
    /// there is what makes alerts work.
    ComputerUpdate,
    /// The computer or its push service named the reason.
    #[serde(untagged)]
    Refused(PushRefusal),
}

/// The preference a sync registers with `hubs`, or None to stop alerts: Off,
/// or no computer left to send them. With none left, alerts stop as Off stops
/// them and the token stops working, so no grant a forgotten computer still
/// holds reaches this phone (#660).
#[cfg(any(target_os = "ios", test))]
fn registered_preference(
    preference: Option<PushPreference>,
    hubs: &[HubEntry],
) -> Option<PushPreference> {
    preference.filter(|_| !hubs.is_empty())
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
        let generation = crate::device_reset::current_generation();
        let hubs = crate::hub_store::load(&crate::hub_store_path(&app)?)?.hubs;
        let subscription = match registered_preference(preference, &hubs) {
            Some(preference) => {
                let (token, environment) = crate::push_ios::register(&app).await.map_err(error)?;
                Some(dure_hub_protocol::push::PushSubscription {
                    token,
                    environment,
                    preference,
                    language,
                })
            }
            None => {
                crate::push_ios::unregister(&app).map_err(error)?;
                None
            }
        };
        let push_root = crate::push_root(&app)?;
        let outcomes = tauri::async_runtime::spawn_blocking(move || {
            // Loaded and readied under the reset guard, so a key or epoch
            // written after a reset cannot undo it, and a forget's epoch rise
            // is never read half done.
            let key = match &subscription {
                Some(subscription) => {
                    let _guard = crate::device_reset::mutation_guard(generation)
                        .map_err(|failure| error(failure.to_string()))?;
                    let mut key =
                        crate::push_key::PushKey::load_or_create(&push_root).map_err(error)?;
                    key.prepare_grants(&push_root, subscription.preference)
                        .map_err(error)?;
                    Some(key)
                }
                None => None,
            };
            let alerts = subscription
                .as_ref()
                .zip(key.as_ref())
                .map(|(subscription, key)| crate::push_sync::Alerts { subscription, key });
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_secs());
            let challenges = app.state::<crate::push_sync::PushChallenges>();
            Ok::<_, CommandError>(crate::push_sync::synchronize(
                &hubs,
                alerts,
                &challenges,
                now,
            ))
        })
        .await
        .map_err(|_| error("Push synchronization was interrupted".into()))??;
        Ok(PushSyncResult {
            supported: true,
            outcomes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The computer every alert in these tests comes from, as the phone
    /// paired it.
    fn hub() -> String {
        dure_hub_protocol::fingerprint::of_der(b"hub")
    }

    fn paired_with(hub: &str) -> Vec<HubEntry> {
        vec![HubEntry {
            id: hub.to_string(),
            box_label: "Laptop".into(),
            endpoint: "192.168.0.12:47823".into(),
            fingerprint: hub.to_string(),
            token: "paired-token".into(),
            relay_endpoint: Some("relay.example:8787".into()),
            server_id: Some("server-1".into()),
            push_registration: None,
        }]
    }

    #[test]
    fn a_tap_that_launched_the_app_waits_for_the_screen_and_the_latest_wins() {
        use std::sync::{Arc, Mutex};
        let hubs = paired_with(&hub());
        let tap = |session: &str| {
            PushActivation::from_payload(
                format!(
                    r#"{{"aps":{{}},"dure":{{"session":"{session}","hub":"{}"}}}}"#,
                    hub()
                )
                .as_bytes(),
                &hubs,
            )
            .unwrap()
        };
        assert_eq!(PushActivation::from_payload(br#"{"aps":{}}"#, &hubs), None);
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
        let hub = hub();
        let context = PushAlertContext::from_payload(
            format!(
                r#"{{"aps":{{}},"dure":{{"session":"managed_1","hub":"{hub}","approval":{{"attentionId":"attention-3","terminalEpoch":"7"}}}}}}"#
            )
            .as_bytes(),
        );
        let actions = owner_check.map(|owner_check| AlertActions {
            owner_check,
            details: true,
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

        let hubs = paired_with(&hub());
        let (context, actions) = approval_alert(Some(false));
        assert!(matches!(
            alert_answer(&context, &hubs, actions.as_ref(), "approve"),
            AlertAnswer::Here { hub: answered, session, approval }
                if answered == hub()
                    && session.as_str() == "managed_1"
                    && approval.attention_id.as_str() == "attention-3"
        ));
        // Face ID on, or a preference never mirrored: the screen answers past its sheet.
        for owner_check in [Some(true), None] {
            let (context, actions) = approval_alert(owner_check);
            assert_eq!(
                alert_answer(&context, &hubs, actions.as_ref(), "deny"),
                AlertAnswer::Screen(PushActivation {
                    hub: hub(),
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
            alert_answer(&tap_only, &hubs, actions.as_ref(), "approve"),
            AlertAnswer::Unanswerable
        );
    }

    /// #660: an alert from a computer this phone does not hold, such as one
    /// it forgot, opens nothing and answers nothing, with or without Face ID.
    #[test]
    fn an_alert_from_a_computer_that_is_not_paired_opens_and_answers_nothing() {
        let other = paired_with(&dure_hub_protocol::fingerprint::of_der(b"other"));
        let tap = format!(
            r#"{{"aps":{{}},"dure":{{"session":"managed_1","hub":"{}"}}}}"#,
            hub()
        );
        assert_eq!(PushActivation::from_payload(tap.as_bytes(), &other), None);
        assert_eq!(PushActivation::from_payload(tap.as_bytes(), &[]), None);
        // An alert from a relay that names no computer is no paired computer's.
        let unnamed = br#"{"aps":{},"dure":{"session":"managed_1"}}"#;
        assert_eq!(
            PushActivation::from_payload(unnamed, &paired_with(&hub())),
            None
        );
        for owner_check in [Some(false), Some(true), None] {
            let (context, actions) = approval_alert(owner_check);
            assert_eq!(
                alert_answer(&context, &other, actions.as_ref(), "approve"),
                AlertAnswer::Unanswerable
            );
        }
        let reply = PushAlertContext::from_payload(
            format!(
                r#"{{"aps":{{}},"dure":{{"session":"managed_1","hub":"{}","reply":{{"terminalEpoch":"7"}}}}}}"#,
                hub()
            )
            .as_bytes(),
        );
        assert!(reply_to(&reply, &other).is_none());
        assert!(reply_to(&reply, &paired_with(&hub())).is_some());
    }

    /// Forgetting the last computer stops alerts as Off does: the sync then
    /// unregisters the token instead of registering it.
    #[test]
    fn with_no_computer_left_a_sync_stops_alerts_as_off_does() {
        let hubs = paired_with(&hub());
        for preference in [PushPreference::All, PushPreference::Approvals] {
            assert_eq!(
                registered_preference(Some(preference), &hubs),
                Some(preference)
            );
            assert_eq!(registered_preference(Some(preference), &[]), None);
        }
        assert_eq!(registered_preference(None, &hubs), None);
    }

    /// A tap on the notice that an answer did not land opens the agent on
    /// the computer the alert came from.
    #[test]
    fn a_failure_notice_names_the_alerts_computer_and_its_tap_opens_there() {
        let (context, _) = approval_alert(Some(false));
        let notice =
            FailureNotice::about(&context, "Dure could not answer that approval.".into()).unwrap();
        assert_eq!(
            (notice.session.as_str(), notice.hub.as_deref()),
            ("managed_1", Some(hub().as_str()))
        );
        // What `push_ios` posts and reads back when the notice is tapped.
        let posted = serde_json::to_vec(&serde_json::json!({
            dure_hub_protocol::push::PUSH_ALERT_CONTEXT_KEY: {
                "session": notice.session, "hub": notice.hub,
            }
        }))
        .unwrap();
        assert_eq!(
            PushActivation::from_payload(&posted, &paired_with(&hub())),
            Some(PushActivation {
                hub: hub(),
                session_id: "managed_1".into(),
                answer: None,
            })
        );
        let unnamed = PushAlertContext::from_payload(br#"{"aps":{},"dure":{}}"#);
        assert_eq!(FailureNotice::about(&unnamed, "body".into()), None);
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
            push_registration: None,
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
        let hub = hub();
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
        assert_eq!(AlertActions::load(&path), Some(actions.clone()));
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::write(&path, br#"{"ownerCheck":false}"#).unwrap();
        assert_eq!(AlertActions::load(&path), None);
        // A mirror written before the details setting keeps alerts generic.
        let mut older = serde_json::to_value(&actions).unwrap();
        older.as_object_mut().unwrap().remove("details");
        std::fs::write(&path, serde_json::to_vec(&older).unwrap()).unwrap();
        assert!(!AlertActions::load(&path).unwrap().details());
    }
}
