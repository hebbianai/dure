//! Signed-app notification click evidence for the dedicated QA bundle identity.
//!
//! Production Dure never enables this surface: every command proves the exact
//! QA bundle identifier before reading or mutating its owner-only journal. The
//! journal survives the cold-start notification click so the fresh process can
//! correlate the native activation with the route that was dispatched.

#[cfg(target_os = "macos")]
use crate::desktop_notification::{query_native_authorization, request_native_authorization};
use crate::desktop_notification::{NotificationAuthorization, NotificationPaneTarget};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const QA_BUNDLE_IDENTIFIER: &str = "dev.dureai.qa.notification-click";
const JOURNAL_FILE: &str = "notification-click-qa-v1.json";
const JOURNAL_SCHEMA: &str = "dure.notification-click-qa.v1";
const MAX_JOURNAL_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NotificationClickQaScenario {
    ColdStart,
    Minimized,
    MultiWindow,
    OwnerChange,
}

impl NotificationClickQaScenario {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "cold-start" => Some(Self::ColdStart),
            "minimized" => Some(Self::Minimized),
            "multi-window" => Some(Self::MultiWindow),
            "owner-change" => Some(Self::OwnerChange),
            _ => None,
        }
    }

    fn route_desktop_id(self) -> &'static str {
        "notification-qa-desktop-b"
    }

    fn expected_desktop_id(self) -> &'static str {
        match self {
            Self::OwnerChange => "notification-qa-desktop-c",
            Self::ColdStart | Self::Minimized | Self::MultiWindow => self.route_desktop_id(),
        }
    }

    fn expected_pre_click_presentation(self) -> NotificationClickQaPresentation {
        match self {
            Self::ColdStart => NotificationClickQaPresentation::Terminating,
            Self::Minimized => NotificationClickQaPresentation::Minimized,
            Self::MultiWindow | Self::OwnerChange => NotificationClickQaPresentation::Hidden,
        }
    }

    fn requires_fresh_process(self) -> bool {
        self == Self::ColdStart
    }

    fn expected_window_label(self) -> &'static str {
        match self {
            Self::MultiWindow => "win-notification-click-target",
            Self::ColdStart | Self::Minimized | Self::OwnerChange => {
                "win-notification-click-controller"
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NotificationClickQaStage {
    Preparing,
    Dispatched,
    Armed,
    Completed,
    Skipped,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NotificationClickQaPresentation {
    Terminating,
    Minimized,
    Hidden,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationClickQaWindowState {
    visible: bool,
    minimized: bool,
    focused: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationClickQaObservation {
    window_label: String,
    active_desktop_id: String,
    panel_id: String,
    panel_active_count: u32,
    activation_queue_empty: bool,
    window: NotificationClickQaWindowState,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationClickQaJournal {
    schema: String,
    run_id: String,
    scenario: NotificationClickQaScenario,
    stage: NotificationClickQaStage,
    event_id: String,
    pane_target: NotificationPaneTarget,
    expected_target: NotificationPaneTarget,
    initial_desktop_id: String,
    initial_panel_id: String,
    authorization: String,
    initial_process_id: u32,
    initial_launch_token: String,
    activated_process_id: Option<u32>,
    activated_launch_token: Option<String>,
    fresh_process: Option<bool>,
    pre_click_presentation: Option<NotificationClickQaPresentation>,
    pre_click_window: Option<NotificationClickQaWindowState>,
    pre_click_panel_id: Option<String>,
    observation: Option<NotificationClickQaObservation>,
    reason: Option<String>,
    updated_at_ms: u128,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationClickQaContext {
    run_id: String,
    scenario: NotificationClickQaScenario,
    pane_target: NotificationPaneTarget,
    expected_target: NotificationPaneTarget,
    initial_desktop_id: String,
    initial_panel_id: String,
    authorize: bool,
    stage: Option<NotificationClickQaStage>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn launch_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN
        .get_or_init(|| {
            crate::server::gen_token()
                .unwrap_or_else(|_| format!("fallback-{}-{}", std::process::id(), now_ms()))
        })
        .as_str()
}

fn ready_target_windows() -> &'static Mutex<HashSet<(String, String)>> {
    static READY: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
    READY.get_or_init(|| Mutex::new(HashSet::new()))
}

fn ensure_qa_identity(app: &AppHandle) -> Result<(), String> {
    if app.config().identifier != QA_BUNDLE_IDENTIFIER {
        return Err("notification click QA is unavailable outside its dedicated bundle".into());
    }
    #[cfg(target_os = "macos")]
    {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        if !is_bundled_app_executable(&executable) {
            return Err("notification click QA requires a real app bundle executable".into());
        }
    }
    Ok(())
}

fn is_bundled_app_executable(executable: &Path) -> bool {
    let components: Vec<_> = executable.components().collect();
    components.len() >= 4
        && components[components.len() - 2].as_os_str() == "MacOS"
        && components[components.len() - 3].as_os_str() == "Contents"
        && components[components.len() - 4]
            .as_os_str()
            .to_string_lossy()
            .ends_with(".app")
}

fn valid_run_id(value: &str) -> bool {
    (16..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_window_label(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.contains('\0')
}

fn journal_path(app: &AppHandle) -> Result<PathBuf, String> {
    ensure_qa_identity(app)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    match fs::symlink_metadata(&root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("notification click QA app-data root is unsafe".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    if fs::symlink_metadata(&root)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Err("notification click QA app-data root is unsafe".into());
    }
    Ok(root.join(JOURNAL_FILE))
}

fn read_journal_path(path: &Path) -> Result<Option<NotificationClickQaJournal>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_JOURNAL_BYTES
    {
        return Err("notification click QA journal is unsafe or oversized".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .and_then(|file| file.take(MAX_JOURNAL_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err("notification click QA journal is oversized".into());
    }
    let journal: NotificationClickQaJournal =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if journal.schema != JOURNAL_SCHEMA || !valid_run_id(&journal.run_id) {
        return Err("notification click QA journal contract is invalid".into());
    }
    Ok(Some(journal))
}

fn read_journal(app: &AppHandle) -> Result<Option<NotificationClickQaJournal>, String> {
    read_journal_path(&journal_path(app)?)
}

fn write_journal_path(path: &Path, journal: &NotificationClickQaJournal) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("notification click QA journal cannot be a symlink".into());
    }
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err("notification click QA journal is oversized".into());
    }
    let temporary = path.with_extension(format!("tmp-{}-{}", std::process::id(), now_ms()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_journal(app: &AppHandle, journal: &NotificationClickQaJournal) -> Result<(), String> {
    write_journal_path(&journal_path(app)?, journal)
}

fn authorization_name(authorization: NotificationAuthorization) -> &'static str {
    match authorization {
        NotificationAuthorization::Authorized => "authorized",
        NotificationAuthorization::Denied => "denied",
        NotificationAuthorization::NotDetermined => "not-determined",
        NotificationAuthorization::Unknown => "unknown",
    }
}

fn scenario_context(
    run_id: String,
    scenario: NotificationClickQaScenario,
    authorize: bool,
    stage: Option<NotificationClickQaStage>,
) -> NotificationClickQaContext {
    let panel_id = "agent:notification-click-qa".to_string();
    NotificationClickQaContext {
        pane_target: NotificationPaneTarget {
            window_label: Some(scenario.expected_window_label().to_string()),
            desktop_id: scenario.route_desktop_id().to_string(),
            panel_id: panel_id.clone(),
        },
        expected_target: NotificationPaneTarget {
            window_label: Some(scenario.expected_window_label().to_string()),
            desktop_id: scenario.expected_desktop_id().to_string(),
            panel_id,
        },
        initial_desktop_id: "notification-qa-desktop-a".to_string(),
        initial_panel_id: "agent:notification-click-decoy".to_string(),
        run_id,
        scenario,
        authorize,
        stage,
    }
}

fn new_journal(
    run_id: String,
    scenario: NotificationClickQaScenario,
) -> NotificationClickQaJournal {
    let context = scenario_context(run_id.clone(), scenario, false, None);
    NotificationClickQaJournal {
        schema: JOURNAL_SCHEMA.to_string(),
        run_id: run_id.clone(),
        scenario,
        stage: NotificationClickQaStage::Preparing,
        event_id: format!("notification-click-qa:{run_id}:{scenario:?}"),
        pane_target: context.pane_target,
        expected_target: context.expected_target,
        initial_desktop_id: context.initial_desktop_id,
        initial_panel_id: context.initial_panel_id,
        authorization: "unknown".to_string(),
        initial_process_id: std::process::id(),
        initial_launch_token: launch_token().to_string(),
        activated_process_id: None,
        activated_launch_token: None,
        fresh_process: None,
        pre_click_presentation: None,
        pre_click_window: None,
        pre_click_panel_id: None,
        observation: None,
        reason: None,
        updated_at_ms: now_ms(),
    }
}

fn command_line_context() -> Result<Option<NotificationClickQaContext>, String> {
    let mut run_id = None;
    let mut scenario = None;
    let mut authorize = false;
    for argument in std::env::args().skip(1) {
        if let Some(value) = argument.strip_prefix("--dure-notification-click-qa-run=") {
            run_id = Some(value.to_string());
        } else if let Some(value) = argument.strip_prefix("--dure-notification-click-qa-scenario=")
        {
            scenario = Some(
                NotificationClickQaScenario::parse(value)
                    .ok_or_else(|| "notification click QA scenario is unsupported".to_string())?,
            );
        } else if argument == "--dure-notification-click-qa-authorize" {
            authorize = true;
        }
    }
    match (run_id, scenario) {
        (None, None) => Ok(None),
        (Some(run_id), Some(scenario)) if valid_run_id(&run_id) => {
            Ok(Some(scenario_context(run_id, scenario, authorize, None)))
        }
        _ => Err("notification click QA requires a valid run id and scenario".into()),
    }
}

/// Prepare the exact signed QA bundle and report whether the caller must skip
/// normal product services such as the Dure API server.
pub(crate) fn bootstrap(app: &AppHandle) -> Result<bool, String> {
    if app.config().identifier != QA_BUNDLE_IDENTIFIER {
        return Ok(false);
    }
    ensure_qa_identity(app)?;
    if let Some(context) = command_line_context()? {
        write_journal(app, &new_journal(context.run_id.clone(), context.scenario))?;
    } else {
        let journal = read_journal(app)?
            .ok_or_else(|| "notification click QA bootstrap has no launch context".to_string())?;
        if journal.stage != NotificationClickQaStage::Armed {
            return Err("notification click QA relaunch journal is not armed".into());
        }
    }
    for label in [
        "win-notification-click-controller",
        "win-notification-click-target",
    ] {
        app.get_webview_window(label)
            .ok_or_else(|| format!("notification click QA window is missing: {label}"))?;
    }
    eprintln!("[notification-click-qa] exact QA windows bootstrapped");
    Ok(true)
}

#[tauri::command]
pub(crate) fn notification_click_qa_context(
    app: AppHandle,
) -> Result<NotificationClickQaContext, String> {
    ensure_qa_identity(&app)?;
    if let Some(context) = command_line_context()? {
        return Ok(context);
    }
    let journal = read_journal(&app)?
        .ok_or_else(|| "notification click QA has no launch context".to_string())?;
    Ok(scenario_context(
        journal.run_id,
        journal.scenario,
        false,
        Some(journal.stage),
    ))
}

#[tauri::command]
pub(crate) fn notification_click_qa_target_ready(
    app: AppHandle,
    window: tauri::WebviewWindow,
    run_id: String,
) -> Result<(), String> {
    ensure_qa_identity(&app)?;
    let context = command_line_context()?
        .filter(|context| context.run_id == run_id)
        .ok_or_else(|| "notification click QA target has no launch context".to_string())?;
    let expected_window_label = context
        .expected_target
        .window_label
        .ok_or_else(|| "notification click QA target has no exact window".to_string())?;
    if context.scenario != NotificationClickQaScenario::MultiWindow
        || window.label() != expected_window_label
    {
        return Err("notification click QA target window identity is invalid".into());
    }
    ready_target_windows()
        .lock()
        .map_err(|_| "notification click QA target readiness lock is poisoned".to_string())?
        .insert((run_id, expected_window_label));
    Ok(())
}

#[tauri::command]
pub(crate) fn notification_click_qa_target_is_ready(
    app: AppHandle,
    run_id: String,
    window_label: String,
) -> Result<bool, String> {
    ensure_qa_identity(&app)?;
    if !valid_run_id(&run_id) || !valid_window_label(&window_label) {
        return Err("notification click QA target readiness identity is invalid".into());
    }
    ready_target_windows()
        .lock()
        .map(|ready| ready.contains(&(run_id, window_label)))
        .map_err(|_| "notification click QA target readiness lock is poisoned".to_string())
}

#[tauri::command(async)]
pub(crate) async fn notification_click_qa_authorize(
    app: AppHandle,
    run_id: String,
    explicit_user_opt_in: bool,
) -> Result<String, String> {
    ensure_qa_identity(&app)?;
    if !valid_run_id(&run_id) || !explicit_user_opt_in {
        return Err("notification click QA authorization requires explicit user opt-in".into());
    }
    #[cfg(target_os = "macos")]
    let authorization = request_native_authorization().await?;
    #[cfg(not(target_os = "macos"))]
    let authorization = NotificationAuthorization::Unknown;
    Ok(authorization_name(authorization).to_string())
}

#[tauri::command(async)]
pub(crate) async fn notification_click_qa_begin(
    app: AppHandle,
    run_id: String,
    scenario: NotificationClickQaScenario,
) -> Result<NotificationClickQaJournal, String> {
    ensure_qa_identity(&app)?;
    if !valid_run_id(&run_id) {
        return Err("notification click QA run id is invalid".into());
    }
    #[cfg(target_os = "macos")]
    crate::macos_notification_center::clear_all();
    let mut journal = match read_journal(&app)? {
        Some(current)
            if current.run_id == run_id
                && current.scenario == scenario
                && current.stage == NotificationClickQaStage::Preparing =>
        {
            current
        }
        Some(current) if current.run_id == run_id => return Ok(current),
        _ => new_journal(run_id.clone(), scenario),
    };
    write_journal(&app, &journal)?;

    #[cfg(target_os = "macos")]
    let authorization = query_native_authorization()
        .await
        .unwrap_or(NotificationAuthorization::Unknown);
    #[cfg(not(target_os = "macos"))]
    let authorization = NotificationAuthorization::Unknown;
    journal.authorization = authorization_name(authorization).to_string();
    if authorization != NotificationAuthorization::Authorized {
        journal.stage = NotificationClickQaStage::Skipped;
        journal.reason = Some(format!("notification-permission-{}", journal.authorization));
        journal.updated_at_ms = now_ms();
        write_journal(&app, &journal)?;
        return Ok(journal);
    }

    #[cfg(target_os = "macos")]
    let dispatch = crate::macos_notification_center::dispatch(
        &format!("Dure notification click QA · {scenario:?}"),
        &format!("Click this notification to verify run {}", &run_id[..12]),
        None,
        Some(&journal.event_id),
        Some(&journal.pane_target),
    );
    #[cfg(not(target_os = "macos"))]
    let dispatch: Result<(), String> = Err("notification click QA requires macOS".into());
    match dispatch {
        Ok(()) => journal.stage = NotificationClickQaStage::Dispatched,
        Err(error) => {
            journal.stage = NotificationClickQaStage::Failed;
            journal.reason = Some(format!("notification-dispatch-failed:{error}"));
        }
    }
    journal.updated_at_ms = now_ms();
    write_journal(&app, &journal)?;
    Ok(journal)
}

#[tauri::command]
pub(crate) fn notification_click_qa_fail(
    app: AppHandle,
    run_id: String,
    reason: String,
) -> Result<NotificationClickQaJournal, String> {
    ensure_qa_identity(&app)?;
    if !valid_run_id(&run_id) {
        return Err("notification click QA run id is invalid".into());
    }
    let mut journal = match read_journal(&app)? {
        Some(journal) if journal.run_id == run_id => journal,
        Some(_) => {
            return Err("notification click QA failure run does not match its journal".into());
        }
        None => {
            let context = command_line_context()?
                .filter(|context| context.run_id == run_id)
                .ok_or_else(|| "notification click QA failure has no launch context".to_string())?;
            new_journal(run_id, context.scenario)
        }
    };
    if journal.stage == NotificationClickQaStage::Completed {
        return Err("notification click QA cannot fail a completed run".into());
    }
    journal.stage = NotificationClickQaStage::Failed;
    journal.reason = Some(reason.chars().take(1024).collect());
    journal.updated_at_ms = now_ms();
    write_journal(&app, &journal)?;
    Ok(journal)
}

fn current_window_state(
    app: &AppHandle,
    window_label: &str,
) -> Result<NotificationClickQaWindowState, String> {
    let window = app
        .get_webview_window(window_label)
        .ok_or_else(|| "notification click QA target window is unavailable".to_string())?;
    Ok(NotificationClickQaWindowState {
        visible: window.is_visible().map_err(|error| error.to_string())?,
        minimized: window.is_minimized().map_err(|error| error.to_string())?,
        focused: window.is_focused().map_err(|error| error.to_string())?,
    })
}

#[tauri::command]
pub(crate) fn notification_click_qa_arm(
    app: AppHandle,
    run_id: String,
    presentation: NotificationClickQaPresentation,
    active_panel_id: String,
) -> Result<NotificationClickQaJournal, String> {
    let mut journal = read_journal(&app)?
        .ok_or_else(|| "notification click QA journal is unavailable".to_string())?;
    if journal.run_id != run_id || journal.stage != NotificationClickQaStage::Dispatched {
        return Err("notification click QA dispatch is not ready to arm".into());
    }
    if presentation != journal.scenario.expected_pre_click_presentation() {
        return Err("notification click QA presentation does not match the scenario".into());
    }
    if active_panel_id != journal.initial_panel_id {
        return Err("notification click QA target pane was active before the click".into());
    }
    let expected_window_label = journal
        .expected_target
        .window_label
        .as_deref()
        .ok_or_else(|| "notification click QA expected window is unavailable".to_string())?;
    let window = current_window_state(&app, expected_window_label)?;
    let presentation_matches = match presentation {
        NotificationClickQaPresentation::Terminating => window.visible,
        NotificationClickQaPresentation::Minimized => window.minimized,
        NotificationClickQaPresentation::Hidden => !window.visible,
    };
    if !presentation_matches {
        return Err("notification click QA could not prove the pre-click window state".into());
    }
    journal.stage = NotificationClickQaStage::Armed;
    journal.pre_click_presentation = Some(presentation);
    journal.pre_click_window = Some(window);
    journal.pre_click_panel_id = Some(active_panel_id);
    journal.updated_at_ms = now_ms();
    write_journal(&app, &journal)?;
    Ok(journal)
}

fn validate_completion(
    journal: &NotificationClickQaJournal,
    observation: &NotificationClickQaObservation,
    current_launch_token: &str,
) -> Result<bool, String> {
    if observation.active_desktop_id != journal.expected_target.desktop_id
        || observation.panel_id != journal.expected_target.panel_id
        || journal.expected_target.window_label.as_deref()
            != Some(observation.window_label.as_str())
    {
        return Err("notification click QA focused the wrong pane target".into());
    }
    if observation.panel_active_count != 1 || !observation.activation_queue_empty {
        return Err("notification click QA activation was not consumed exactly once".into());
    }
    if !observation.window.visible || observation.window.minimized || !observation.window.focused {
        return Err("notification click QA did not restore and focus the target window".into());
    }
    let fresh = journal.initial_launch_token != current_launch_token;
    if fresh != journal.scenario.requires_fresh_process() {
        return Err("notification click QA process generation does not match the scenario".into());
    }
    Ok(fresh)
}

#[tauri::command]
pub(crate) fn notification_click_qa_complete(
    app: AppHandle,
    window: tauri::WebviewWindow,
    run_id: String,
    observation: NotificationClickQaObservation,
) -> Result<NotificationClickQaJournal, String> {
    let mut journal = read_journal(&app)?
        .ok_or_else(|| "notification click QA journal is unavailable".to_string())?;
    if journal.run_id != run_id || journal.stage != NotificationClickQaStage::Armed {
        return Err("notification click QA is not armed".into());
    }
    if observation.window_label != window.label() {
        return Err("notification click QA observation came from the wrong window".into());
    }
    let native_window = current_window_state(&app, window.label())?;
    if native_window != observation.window {
        return Err("notification click QA renderer and native window state disagree".into());
    }
    let current_token = launch_token();
    let fresh = validate_completion(&journal, &observation, current_token)?;
    journal.stage = NotificationClickQaStage::Completed;
    journal.activated_process_id = Some(std::process::id());
    journal.activated_launch_token = Some(current_token.to_string());
    journal.fresh_process = Some(fresh);
    journal.observation = Some(observation);
    journal.updated_at_ms = now_ms();
    write_journal(&app, &journal)?;
    #[cfg(target_os = "macos")]
    crate::macos_notification_center::clear_all();
    Ok(journal)
}

#[tauri::command]
pub(crate) fn notification_click_qa_exit(app: AppHandle, run_id: String) -> Result<(), String> {
    let journal = read_journal(&app)?
        .ok_or_else(|| "notification click QA journal is unavailable".to_string())?;
    if journal.run_id != run_id {
        return Err("notification click QA exit run does not match its journal".into());
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        app.exit(0);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal(scenario: NotificationClickQaScenario) -> NotificationClickQaJournal {
        let context = scenario_context("a".repeat(32), scenario, false, None);
        NotificationClickQaJournal {
            schema: JOURNAL_SCHEMA.to_string(),
            run_id: context.run_id,
            scenario,
            stage: NotificationClickQaStage::Armed,
            event_id: "event".into(),
            pane_target: context.pane_target,
            expected_target: context.expected_target,
            initial_desktop_id: context.initial_desktop_id,
            initial_panel_id: context.initial_panel_id,
            authorization: "authorized".into(),
            initial_process_id: 10,
            initial_launch_token: "initial-generation".into(),
            activated_process_id: None,
            activated_launch_token: None,
            fresh_process: None,
            pre_click_presentation: Some(scenario.expected_pre_click_presentation()),
            pre_click_window: None,
            pre_click_panel_id: Some("agent:notification-click-decoy".into()),
            observation: None,
            reason: None,
            updated_at_ms: 1,
        }
    }

    fn observation(journal: &NotificationClickQaJournal) -> NotificationClickQaObservation {
        NotificationClickQaObservation {
            window_label: journal
                .expected_target
                .window_label
                .clone()
                .unwrap_or_else(|| "main".to_string()),
            active_desktop_id: journal.expected_target.desktop_id.clone(),
            panel_id: journal.expected_target.panel_id.clone(),
            panel_active_count: 1,
            activation_queue_empty: true,
            window: NotificationClickQaWindowState {
                visible: true,
                minimized: false,
                focused: true,
            },
        }
    }

    #[test]
    fn scenarios_bind_route_and_current_owner_explicitly() {
        let cold = scenario_context(
            "a".repeat(32),
            NotificationClickQaScenario::ColdStart,
            false,
            None,
        );
        let moved = scenario_context(
            "b".repeat(32),
            NotificationClickQaScenario::OwnerChange,
            false,
            None,
        );
        assert_eq!(cold.pane_target, cold.expected_target);
        assert_ne!(moved.pane_target, moved.expected_target);
        assert_eq!(moved.pane_target.panel_id, moved.expected_target.panel_id);
        let multi = scenario_context(
            "c".repeat(32),
            NotificationClickQaScenario::MultiWindow,
            false,
            None,
        );
        assert_eq!(
            multi.expected_target.window_label.as_deref(),
            Some("win-notification-click-target")
        );
    }

    #[test]
    fn completion_requires_the_expected_process_generation() {
        let cold = journal(NotificationClickQaScenario::ColdStart);
        assert!(validate_completion(&cold, &observation(&cold), "fresh-generation").unwrap());
        assert!(validate_completion(&cold, &observation(&cold), "initial-generation").is_err());

        let minimized = journal(NotificationClickQaScenario::Minimized);
        assert!(
            !validate_completion(&minimized, &observation(&minimized), "initial-generation")
                .unwrap()
        );
        assert!(
            validate_completion(&minimized, &observation(&minimized), "fresh-generation").is_err()
        );
    }

    #[test]
    fn completion_rejects_wrong_pane_duplicate_or_unfocused_window() {
        let journal = journal(NotificationClickQaScenario::Minimized);
        let mut wrong = observation(&journal);
        wrong.active_desktop_id = "wrong".into();
        assert!(validate_completion(&journal, &wrong, "initial-generation").is_err());

        let mut duplicate = observation(&journal);
        duplicate.panel_active_count = 2;
        assert!(validate_completion(&journal, &duplicate, "initial-generation").is_err());

        let mut hidden = observation(&journal);
        hidden.window.focused = false;
        assert!(validate_completion(&journal, &hidden, "initial-generation").is_err());
    }

    #[test]
    fn owner_only_journal_round_trips_and_rejects_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(JOURNAL_FILE);
        let expected = journal(NotificationClickQaScenario::OwnerChange);
        write_journal_path(&path, &expected).unwrap();
        let actual = read_journal_path(&path).unwrap().unwrap();
        assert_eq!(actual.run_id, expected.run_id);
        assert_eq!(actual.expected_target, expected.expected_target);

        fs::remove_file(&path).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(directory.path().join("elsewhere"), &path).unwrap();
            assert!(write_journal_path(&path, &expected).is_err());
        }
    }

    #[test]
    fn notification_click_qa_requires_a_real_app_bundle_executable() {
        assert!(is_bundled_app_executable(Path::new(
            "/Applications/Dure Notification Click QA.app/Contents/MacOS/agent-ide",
        )));
        assert!(!is_bundled_app_executable(Path::new(
            "/tmp/target/debug/agent-ide",
        )));
    }
}
