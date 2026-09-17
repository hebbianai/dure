use crate::AppState;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    webview::PageLoadEvent,
    AppHandle, Emitter, LogicalSize, Manager, Runtime, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Wry,
};

mod scrollback_evidence;
mod storage_probe;
mod terminal_resize_render;

use scrollback_evidence::canonical_snapshot_scrollback_history_line_count;
pub use terminal_resize_render::TerminalResizeScreenModel;
use terminal_resize_render::{
    TerminalSnapshotSeed, TerminalSnapshotSeedReceipt, activate_fixture, fixture_launch,
    install_snapshot_seed, load_snapshot_seed_from_environment, validate_provider,
};

const QA_PLUGIN_NAME: &str = "window-focus-qa";
const QA_ACTION_EVENT: &str = "qa:hmux-window-focus-action";
const QA_RESIZE_BASELINE_EVENT: &str = "qa:hmux-window-focus-resize-baseline";
const QA_MARKER_PREFIX: &str = "HMUX_WINDOW_QA";
const QA_WINDOW_WIDTH: f64 = 700.0;
const QA_WINDOW_HEIGHT: f64 = 620.0;
const QA_GRACEFUL_FINISH_TIMEOUT: Duration = Duration::from_secs(1);
const QA_TERMINATION_TIMEOUT: Duration = Duration::from_secs(2);
const QA_FINISH_POLL_INTERVAL: Duration = Duration::from_millis(50);
const QA_MARKER_LIMIT: usize = 64;
const QA_INPUT_RECEIPT_MAX_LATENCY_MS: u64 = 30_000;
const QA_SCROLLBACK_LINES: u16 = 600;
const QA_SCROLLBACK_TIMEOUT: Duration = Duration::from_secs(5);
const QA_COMMAND_INPUT_TIMEOUT: Duration = Duration::from_secs(5);
const QA_SCROLLBACK_SOFT_WRAP_SEGMENT: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

fn input_echo_fixture_command() -> Vec<String> {
    vec![
        "/bin/sh".to_string(),
        "-c".to_string(),
        "stty -echo -icanon min 1 time 0; exec /bin/cat".to_string(),
    ]
}

fn scrollback_preload_command(marker: &str, soft_wrap_marker: &str) -> String {
    format!(
        "printf '{soft_wrap_marker}\\n'; \
         i=1; while [ \"$i\" -le {QA_SCROLLBACK_LINES} ]; do \
         printf '\\033[31mHMUX_SCROLL_QA_LINE_%04d\\033[0m canonical-history\\n' \"$i\"; \
         i=$((i+1)); done; printf '{marker}\\n'; trap '' WINCH; \
         PS1= PS2= ENV=/dev/null exec /bin/sh -s"
    )
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowFocusProfile {
    #[default]
    Smoke,
    Background,
    Soak,
    Scrollback,
    LargeView,
    ExternalInput,
}

impl WindowFocusProfile {
    fn query_value(self) -> &'static str {
        match self {
            Self::Smoke => "smoke",
            Self::Background => "background",
            Self::Soak => "soak",
            Self::Scrollback => "scrollback",
            Self::LargeView => "large_view",
            Self::ExternalInput => "external_input",
        }
    }

    fn allows_os_focus(self) -> bool {
        !matches!(self, Self::Background)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowSize {
    Compact,
    Wide,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowPresentation {
    #[default]
    Visible,
    Minimized,
    Hidden,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowRole {
    A,
    B,
}

struct WindowBuildRequest<'a> {
    proof: &'a str,
    run_id: &'a str,
    profile: WindowFocusProfile,
    windows: &'a HashMap<WindowRole, String>,
    role: WindowRole,
    visible: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum WindowControlState {
    Viewing,
    Waiting,
    Controlling,
    Error,
}

impl WindowRole {
    fn label(self, run_id: &str) -> String {
        format!(
            "desktop-hmux-qa-{run_id}-{}",
            match self {
                Self::A => "a",
                Self::B => "b",
            }
        )
    }

    fn marker_component(self) -> &'static str {
        match self {
            Self::A => "A",
            Self::B => "B",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowReport {
    proof: String,
    role: WindowRole,
    webview_instance_id: String,
    webview_started_at: String,
    webview_uptime_ms: u64,
    mounted: bool,
    latest_surface_attachment_id: Option<String>,
    latest_retired_surface_attachment_id: Option<String>,
    listening: bool,
    synchronized: bool,
    hydrating: bool,
    document_focused: bool,
    terminal_input_focused: bool,
    control_state: WindowControlState,
    transport_markers: BTreeMap<String, bool>,
    marker_write_receipts: BTreeMap<String, WindowInputReceipt>,
    marker_counts: BTreeMap<String, u32>,
    first_seen_focused: BTreeMap<String, bool>,
    first_seen_at_ms: BTreeMap<String, u64>,
    first_paint_at_ms: BTreeMap<String, u64>,
    received_action_id: Option<u64>,
    completed_action_id: Option<u64>,
    heartbeat_count: u64,
    max_heartbeat_lag_ms: u64,
    render_metrics: Option<WindowRenderMetrics>,
    buffer_state: Option<WindowBufferState>,
    first_presented_buffer_state: Option<WindowBufferState>,
    synchronization_count: u64,
    presented_count: u64,
    visible_frame_count: u64,
    visible_frame_violations: u64,
    resize_render_integrity: Option<ResizeRenderFrameIntegrity>,
    concealment_observed: bool,
    large_view_return_preparation_count: u64,
    errors: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowInputReceipt {
    request_id: String,
    attachment_identity: String,
    state: WindowInputReceiptState,
    input_started_at_ms: u64,
    host_receipt_at_ms: u64,
    observation_at_host_receipt: WindowInputReceiptObservation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowInputReceiptObservation {
    snapshot_collapses: u64,
    scrollback_rows: u64,
    at_bottom: bool,
    concealed: bool,
    history_hydrating: bool,
    visible_scrollback_marker: Option<String>,
    visible_frame_count: u64,
    visible_frame_violations: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum WindowInputReceiptState {
    WrittenToPty,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowRenderMetrics {
    queued_writes: u64,
    queued_bytes: u64,
    active_bytes: u64,
    completed_writes: u64,
    snapshot_collapses: u64,
    max_write_latency_ms: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowBufferState {
    columns: u16,
    rows: u16,
    fit_columns: Option<u16>,
    fit_rows: Option<u16>,
    fit_dimensions_match: Option<bool>,
    viewport_fill: Option<WindowViewportFill>,
    vertical_scrollbar: Option<WindowVerticalScrollbarPosition>,
    buffer_length: u64,
    scrollback_rows: u64,
    viewport_y: u64,
    at_bottom: bool,
    concealed: bool,
    visible_scrollback_marker: Option<String>,
    logical_scrollback_marker_present: Option<bool>,
    styled_scrollback_marker_present: Option<bool>,
    resize_render_seed_visible: bool,
    resize_render: Option<TerminalResizeRenderObservation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowViewportFill {
    container_height: f64,
    grid_height: f64,
    effective_grid_height: f64,
    row_height: Option<f64>,
    unfilled_height: f64,
    overflow_height: f64,
    fills_container: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowVerticalScrollbarPosition {
    track_height_px: f64,
    slider_top_px: f64,
    slider_height_px: f64,
    bottom_gap_px: f64,
    normalized_position: f64,
    at_bottom: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResizeRenderObservation {
    provider: String,
    buffer: TerminalResizeScreenModel,
    generation: u64,
    reported_columns: u16,
    reported_rows: u16,
    terminal_columns: u16,
    terminal_rows: u16,
    dimensions_match: bool,
    footer_visible: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResizeRenderFrameIntegrity {
    samples: u64,
    visible_frames: u64,
    concealed_frames: u64,
    valid_frames: u64,
    violation_frames: u64,
    last_generation: Option<u64>,
    violations: ResizeRenderFrameViolations,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResizeRenderFrameViolations {
    missing_observation: u64,
    provider_mismatch: u64,
    buffer_mismatch: u64,
    dimensions_mismatch: u64,
    container_fit_mismatch: u64,
    footer_missing: u64,
    generation_regression: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowContext {
    proof: String,
    role: WindowRole,
    session_id: String,
    workspace_id: String,
    profile: WindowFocusProfile,
    #[serde(skip_serializing_if = "Option::is_none")]
    resize_render_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resize_render_screen_model: Option<TerminalResizeScreenModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scrollback_marker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scrollback_soft_wrap_marker: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowAction {
    proof: String,
    role: WindowRole,
    action_id: u64,
    kind: WindowActionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    marker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rows: Option<i32>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum WindowActionKind {
    Focus,
    Marker,
    ExternalInput,
    ReleaseControl,
    ScrollRows,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeWebviewLoadEvidence {
    started_count: u64,
    finished_count: u64,
    first_started_at_ms: Option<u64>,
    last_finished_at_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum PredecessorFenceOutcome {
    Accepted,
    StaleRejected,
    OtherError,
}

#[derive(Clone, Debug)]
struct PredecessorFenceProbe {
    role: WindowRole,
    instance_id: String,
    armed_after_started_count: u64,
    attempted_started_count: Option<u64>,
    outcome: Option<PredecessorFenceOutcome>,
}

impl NativeWebviewLoadEvidence {
    fn observe(&mut self, event: PageLoadEvent, observed_at_ms: u64) {
        match event {
            PageLoadEvent::Started => {
                self.started_count = self.started_count.saturating_add(1);
                self.first_started_at_ms.get_or_insert(observed_at_ms);
            }
            PageLoadEvent::Finished => {
                self.finished_count = self.finished_count.saturating_add(1);
                self.last_finished_at_ms = Some(observed_at_ms);
            }
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControllerPageEvidence {
    native_started_count: u64,
    native_finished_count: u64,
    native_url: Option<String>,
}

impl ControllerPageEvidence {
    fn observe_native_load(&mut self, event: PageLoadEvent, url: String) {
        match event {
            PageLoadEvent::Started => {
                self.native_started_count = self.native_started_count.saturating_add(1);
            }
            PageLoadEvent::Finished => {
                self.native_finished_count = self.native_finished_count.saturating_add(1);
            }
        }
        self.native_url = Some(url);
    }
}

#[derive(Clone, Debug)]
struct SmokeRun {
    proof: String,
    run_id: String,
    session_id: String,
    workspace_id: String,
    profile: WindowFocusProfile,
    resize_render_provider: Option<String>,
    resize_render_screen_model: Option<TerminalResizeScreenModel>,
    resize_render_seed: Option<TerminalSnapshotSeedReceipt>,
    resize_render_fixture_activated: bool,
    resize_render_activation_request_id: Option<String>,
    presentation: WindowPresentation,
    windows: HashMap<WindowRole, String>,
    native_webview_loads: HashMap<WindowRole, NativeWebviewLoadEvidence>,
    predecessor_fence_probe: Option<PredecessorFenceProbe>,
    reports: HashMap<WindowRole, WindowReport>,
    expected_markers: Vec<String>,
    scrollback_marker: Option<String>,
    scrollback_soft_wrap_marker: Option<String>,
    next_action_id: u64,
}

#[derive(Default)]
pub struct WindowFocusQa {
    controller_page: Mutex<ControllerPageEvidence>,
    run: Mutex<Option<SmokeRun>>,
}

impl WindowFocusQa {
    pub fn controller_page_status<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<Value, String> {
        let page = self
            .controller_page
            .lock()
            .map_err(|_| "QA controller page lock poisoned")?
            .clone();
        Ok(json!({
            "ok": true,
            "page": page,
            "nativeWindow": native_window_state(app, "main"),
        }))
    }

    pub fn prepare_runtime<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Value, String> {
        let build_id = app
            .state::<AppState>()
            .hmux
            .prepare_runtime_fixture(app)?;
        Ok(json!({
            "schemaVersion": 1,
            "kind": "fixture_setup",
            "buildId": build_id,
        }))
    }

    pub fn start<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        profile: WindowFocusProfile,
        requested_proof: Option<String>,
        requested_resize_render_provider: Option<String>,
        requested_resize_render_screen_model: Option<TerminalResizeScreenModel>,
    ) -> Result<Value, String> {
        self.ensure_controller_native_page_loaded()?;
        let (resize_render_provider, resize_render_screen_model) = match (
            profile,
            requested_resize_render_provider,
            requested_resize_render_screen_model,
        ) {
            (WindowFocusProfile::LargeView, Some(provider), Some(screen_model)) => {
                validate_provider(&provider)?;
                (Some(provider), Some(screen_model))
            }
            (WindowFocusProfile::LargeView, _, _) => {
                return Err(
                    "terminal resize profiles require provider and screenModel".to_string()
                );
            }
            (_, None, None) => (None, None),
            (_, _, _) => {
                return Err(
                    "provider and screenModel are only valid for terminal resize profiles"
                        .to_string(),
                );
            }
        };
        let resize_render_seed = if profile == WindowFocusProfile::LargeView {
            load_snapshot_seed_from_environment()?
        } else {
            None
        };
        let resize_render_seed_receipt = resize_render_seed
            .as_ref()
            .map(|seed| seed.receipt.clone());
        let mut run_slot = self.run.lock().map_err(|_| "QA run lock poisoned")?;
        if run_slot.is_some() {
            return Err("a Hmux window focus smoke is already running".to_string());
        }

        let proof = resolve_qa_proof(requested_proof)?;
        let run_id = proof
            .get(..12)
            .ok_or_else(|| "generated QA proof is unexpectedly short".to_string())?
            .to_string();
        let cwd = std::env::current_dir()
            .map_err(|error| format!("resolve QA working directory failed: {error}"))?;
        let state = app.state::<AppState>();
        let fixture_launch = match (
            resize_render_provider.as_deref(),
            resize_render_screen_model,
        ) {
            (Some(provider), Some(screen_model)) => Some(fixture_launch(
                provider,
                screen_model,
                resize_render_seed.as_ref(),
            )?),
            _ => None,
        };
        let session = match (profile, fixture_launch) {
            (_, Some(fixture)) => state.hmux.create_standalone_command(
                app,
                cwd.to_string_lossy().into_owned(),
                fixture.rows,
                fixture.columns,
                fixture.command,
                hmux_client::TerminalEnvironment::default(),
            )?,
            (WindowFocusProfile::Smoke, None) => state.hmux.create_standalone_command(
                app,
                cwd.to_string_lossy().into_owned(),
                30,
                100,
                input_echo_fixture_command(),
                hmux_client::TerminalEnvironment::default(),
            )?,
            (_, None) => state.hmux.create_standalone(
                app,
                cwd.to_string_lossy().into_owned(),
                30,
                100,
                hmux_client::TerminalEnvironment::default(),
            )?,
        };
        let large_view_agent_id = format!("qa-large-view-{run_id}");
        let windows = HashMap::from([
            (WindowRole::A, WindowRole::A.label(&run_id)),
            (
                WindowRole::B,
                if profile == WindowFocusProfile::LargeView {
                    format!("win-session-{large_view_agent_id}")
                } else {
                    WindowRole::B.label(&run_id)
                },
            ),
        ]);
        let scrollback_marker = (profile == WindowFocusProfile::Scrollback)
            .then(|| format!("HMUX_SCROLL_QA_{}_READY", run_id.to_ascii_uppercase()));
        let scrollback_soft_wrap_marker = (profile == WindowFocusProfile::Scrollback).then(|| {
            format!(
                "HMUX_SCROLL_QA_{}_SOFT_WRAP_{}",
                run_id.to_ascii_uppercase(),
                QA_SCROLLBACK_SOFT_WRAP_SEGMENT.repeat(6)
            )
        });
        let smoke_run = SmokeRun {
            proof: proof.clone(),
            run_id: run_id.clone(),
            session_id: session.session_id.clone(),
            workspace_id: session.workspace_id.clone(),
            profile,
            resize_render_provider: resize_render_provider.clone(),
            resize_render_screen_model,
            resize_render_seed: resize_render_seed_receipt.clone(),
            resize_render_fixture_activated: false,
            resize_render_activation_request_id: None,
            presentation: if matches!(profile, WindowFocusProfile::Background) {
                WindowPresentation::Hidden
            } else {
                WindowPresentation::Visible
            },
            windows: windows.clone(),
            native_webview_loads: HashMap::new(),
            predecessor_fence_probe: None,
            reports: HashMap::new(),
            expected_markers: scrollback_marker.clone().into_iter().collect(),
            scrollback_marker: scrollback_marker.clone(),
            scrollback_soft_wrap_marker: scrollback_soft_wrap_marker.clone(),
            next_action_id: 1,
        };
        *run_slot = Some(smoke_run);
        drop(run_slot);

        let build_result = (|| {
            activate_focus_profile(app, profile)?;
            if let (Some(marker), Some(soft_wrap_marker)) = (
                scrollback_marker.as_deref(),
                scrollback_soft_wrap_marker.as_deref(),
            ) {
                self.preload_scrollback(app, &proof, marker, soft_wrap_marker)?;
            }
            if let Some(seed) = resize_render_seed.as_ref() {
                self.preload_terminal_snapshot_seed(app, &proof, seed)?;
            }
            // The fixture command is input, so send it before WebViews can own
            // the single controller. Activating through a temporary controller
            // after mount silently displaced the focused pane and made the
            // resize measurement exercise a stale logical route.
            if profile == WindowFocusProfile::LargeView {
                self.activate_resize_render(app, &proof)?;
            }
            self.build_windows(
                app,
                &proof,
                &run_id,
                profile,
                &windows,
            )
        })();
        if let Err(error) = build_result {
            let cleanup = self.terminate_temporary_session_with_retry(app, &proof);
            self.close_windows(app, &windows);
            if cleanup.is_ok() {
                if let Ok(mut run) = self.run.lock() {
                    *run = None;
                }
            }
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup_error) => format!(
                    "{error}; temporary Hmux cleanup also failed: {cleanup_error}; \
                     recovery proof: {proof}"
                ),
            });
        }

        Ok(json!({
            "ok": true,
            "proof": proof,
            "sessionId": session.session_id,
            "workspaceId": session.workspace_id,
            "profile": profile,
            "agentId": (profile == WindowFocusProfile::LargeView)
                .then_some(large_view_agent_id),
            "resizeRenderProvider": resize_render_provider,
            "resizeRenderScreenModel": resize_render_screen_model,
            "resizeRenderSeed": resize_render_seed_receipt,
            "scrollbackMarker": scrollback_marker,
            "scrollbackSoftWrapMarker": scrollback_soft_wrap_marker,
            "windows": {
                "a": windows[&WindowRole::A],
                "b": windows[&WindowRole::B],
            }
        }))
    }

    pub fn status<R: Runtime>(&self, app: &AppHandle<R>, proof: &str) -> Result<Value, String> {
        let (
            session_id,
            workspace_id,
            profile,
            resize_render_provider,
            resize_render_screen_model,
            resize_render_seed,
            resize_render_fixture_activated,
            resize_render_activation_request_id,
            presentation,
            windows,
            native_webview_loads,
            predecessor_fence_probe,
            expected_markers,
            reports,
        ) = {
            let run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run(run.as_ref(), proof)?;
            (
                run.session_id.clone(),
                run.workspace_id.clone(),
                run.profile,
                run.resize_render_provider.clone(),
                run.resize_render_screen_model,
                run.resize_render_seed.clone(),
                run.resize_render_fixture_activated,
                run.resize_render_activation_request_id.clone(),
                run.presentation,
                run.windows.clone(),
                run.native_webview_loads.clone(),
                run.predecessor_fence_probe.clone(),
                run.expected_markers.clone(),
                run.reports.clone(),
            )
        };
        let manager = &app.state::<AppState>().hmux;
        let controller_page = self
            .controller_page
            .lock()
            .map_err(|_| "QA controller page lock poisoned")?
            .clone();
        // A 100ms QA status poll must not run the full catalog census. Its
        // health probes attach short-lived observers and perturb the exact
        // controller/resize path this harness measures.
        let lifecycle = manager
            .exact_session_lifecycle(&session_id, &workspace_id)?
            .unwrap_or("missing");

        Ok(json!({
            "ok": true,
            "sessionId": session_id,
            "lifecycle": lifecycle,
            "profile": profile,
            "resizeRenderProvider": resize_render_provider,
            "resizeRenderScreenModel": resize_render_screen_model,
            "resizeRenderSeed": resize_render_seed,
            "resizeRenderFixtureActivated": resize_render_fixture_activated,
            "resizeRenderActivationRequestId": resize_render_activation_request_id,
            "presentation": presentation,
            "expectedMarkers": expected_markers,
            "terminalSurfaceCount": manager.structured_terminal_count()?,
            "controllerPage": controller_page,
            "controllerWindow": native_window_state(app, "main"),
            "nativeWindows": {
                "a": native_window_state(app, &windows[&WindowRole::A]),
                "b": native_window_state(app, &windows[&WindowRole::B]),
            },
            "nativeWebviews": {
                "a": native_webview_loads.get(&WindowRole::A).cloned().unwrap_or_default(),
                "b": native_webview_loads.get(&WindowRole::B).cloned().unwrap_or_default(),
            },
            "predecessorFence": predecessor_fence_probe.as_ref().map(predecessor_fence_value),
            "windows": {
                "a": reports.get(&WindowRole::A).map(report_value),
                "b": reports.get(&WindowRole::B).map(report_value),
            }
        }))
    }

    pub fn snapshot_evidence<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
    ) -> Result<Value, String> {
        let (session_id, workspace_id, marker, expected_markers) = {
            let run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run(run.as_ref(), proof)?;
            (
                run.session_id.clone(),
                run.workspace_id.clone(),
                run.scrollback_marker.clone(),
                run.expected_markers.clone(),
            )
        };
        let manager = &app.state::<AppState>().hmux;
        let snapshot = manager.inspect_session_snapshot(&session_id, &workspace_id)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(snapshot.data)
            .map_err(|error| format!("decode QA snapshot failed: {error}"))?;
        let marker_present = marker.as_ref().is_some_and(|marker| {
            bytes
                .windows(marker.len())
                .any(|window| window == marker.as_bytes())
        });
        let scrollback_history_line_count =
            canonical_snapshot_scrollback_history_line_count(&bytes);
        let marker_counts = expected_markers
            .into_iter()
            .map(|marker| {
                let count = bytes
                    .windows(marker.len())
                    .filter(|window| *window == marker.as_bytes())
                    .count();
                (marker, count)
            })
            .collect::<BTreeMap<_, _>>();
        Ok(json!({
            "ok": true,
            "rows": snapshot.rows,
            "columns": snapshot.columns,
            "sequenceThrough": snapshot.sequence_through,
            "truncated": snapshot.truncated,
            "repaintBytes": bytes.len(),
            "scrollbackMarkerPresent": marker_present,
            "scrollbackHistoryLineCount": scrollback_history_line_count,
            "markerCounts": marker_counts,
        }))
    }

    pub fn step<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
        role: WindowRole,
    ) -> Result<Value, String> {
        let (window_label, action) = {
            let mut run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run_mut(run.as_mut(), proof)?;
            ensure_os_focus_profile(run)?;
            ensure_marker_capacity(run)?;
            let action_id = run.next_action_id;
            run.next_action_id = run.next_action_id.saturating_add(1);
            let marker = format!(
                "{QA_MARKER_PREFIX}_{}_{}_{action_id:04}",
                run.run_id.to_ascii_uppercase(),
                role.marker_component(),
            );
            run.expected_markers.push(marker.clone());
            let window_label = run
                .windows
                .get(&role)
                .cloned()
                .ok_or_else(|| "QA target window is missing".to_string())?;
            (
                window_label,
                WindowAction {
                    proof: run.proof.clone(),
                    role,
                    action_id,
                    kind: if run.profile == WindowFocusProfile::ExternalInput {
                        WindowActionKind::ExternalInput
                    } else {
                        WindowActionKind::Marker
                    },
                    marker: Some(marker),
                    rows: None,
                },
            )
        };
        self.dispatch_action(app, role, window_label, action)
    }

    pub fn inject<R: Runtime>(&self, _app: &AppHandle<R>, proof: &str) -> Result<Value, String> {
        let (session_id, workspace_id, action_id, marker) = {
            let mut run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run_mut(run.as_mut(), proof)?;
            ensure_marker_capacity(run)?;
            let action_id = run.next_action_id;
            run.next_action_id = run.next_action_id.saturating_add(1);
            let marker = format!(
                "{QA_MARKER_PREFIX}_{}_S_{action_id:04}",
                run.run_id.to_ascii_uppercase(),
            );
            run.expected_markers.push(marker.clone());
            (
                run.session_id.clone(),
                run.workspace_id.clone(),
                action_id,
                marker,
            )
        };
        let escaped = marker
            .bytes()
            .map(|byte| format!("\\{byte:03o}"))
            .collect::<String>();
        let write_result = crate::hmux::command_input::send_local_standalone_commands(
            &session_id,
            &workspace_id,
            [format!("printf '{escaped}\\n'")],
            QA_COMMAND_INPUT_TIMEOUT,
        );
        if let Err(error) = write_result {
            if let Ok(mut slot) = self.run.lock() {
                if let Ok(run) = matching_run_mut(slot.as_mut(), proof) {
                    run.expected_markers.retain(|expected| expected != &marker);
                }
            }
            return Err(error);
        }
        Ok(json!({
            "ok": true,
            "actionId": action_id,
            "marker": marker,
            "issuedAtMs": unix_time_ms()?,
        }))
    }

    pub fn set_presentation<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
        presentation: WindowPresentation,
    ) -> Result<Value, String> {
        let windows = {
            let run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run(run.as_ref(), proof)?;
            ensure_os_focus_profile(run)?;
            run.windows.clone()
        };
        for label in windows.values() {
            let window = app
                .get_webview_window(label)
                .ok_or_else(|| format!("QA window {label} is unavailable"))?;
            match presentation {
                WindowPresentation::Visible => {
                    window
                        .show()
                        .map_err(|error| format!("show QA window failed: {error}"))?;
                    window
                        .unminimize()
                        .map_err(|error| format!("restore QA window failed: {error}"))?;
                }
                WindowPresentation::Minimized => {
                    window
                        .show()
                        .map_err(|error| format!("show QA window failed: {error}"))?;
                    window
                        .minimize()
                        .map_err(|error| format!("minimize QA window failed: {error}"))?;
                }
                WindowPresentation::Hidden => {
                    window
                        .hide()
                        .map_err(|error| format!("hide QA window failed: {error}"))?;
                }
            }
        }
        let mut run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
        matching_run_mut(run.as_mut(), proof)?.presentation = presentation;
        Ok(json!({ "ok": true, "presentation": presentation }))
    }

    pub fn focus<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
        role: WindowRole,
    ) -> Result<Value, String> {
        let (window_label, action) = {
            let mut run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run_mut(run.as_mut(), proof)?;
            ensure_os_focus_profile(run)?;
            let action_id = run.next_action_id;
            run.next_action_id = run.next_action_id.saturating_add(1);
            let window_label = run
                .windows
                .get(&role)
                .cloned()
                .ok_or_else(|| "QA target window is missing".to_string())?;
            (
                window_label,
                WindowAction {
                    proof: run.proof.clone(),
                    role,
                    action_id,
                    kind: WindowActionKind::Focus,
                    marker: None,
                    rows: None,
                },
            )
        };
        self.dispatch_action(app, role, window_label, action)
    }

    pub fn release_control<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
        role: WindowRole,
    ) -> Result<Value, String> {
        let (window_label, action) = {
            let mut run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run_mut(run.as_mut(), proof)?;
            if run.profile != WindowFocusProfile::ExternalInput {
                return Err("controller release requires the external_input QA profile".to_string());
            }
            let action_id = run.next_action_id;
            run.next_action_id = run.next_action_id.saturating_add(1);
            let window_label = run
                .windows
                .get(&role)
                .cloned()
                .ok_or_else(|| "QA target window is missing".to_string())?;
            (
                window_label,
                WindowAction {
                    proof: run.proof.clone(),
                    role,
                    action_id,
                    kind: WindowActionKind::ReleaseControl,
                    marker: None,
                    rows: None,
                },
            )
        };
        self.dispatch_action(app, role, window_label, action)
    }

    pub fn scroll_rows<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
        role: WindowRole,
        rows: i32,
    ) -> Result<Value, String> {
        if rows == 0 {
            return Err("viewport scroll rows must be non-zero".to_string());
        }
        let (window_label, action) = {
            let mut run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run_mut(run.as_mut(), proof)?;
            if run.profile != WindowFocusProfile::Scrollback {
                return Err("viewport scroll requires the scrollback QA profile".to_string());
            }
            let action_id = run.next_action_id;
            run.next_action_id = run.next_action_id.saturating_add(1);
            let window_label = run
                .windows
                .get(&role)
                .cloned()
                .ok_or_else(|| "QA target window is missing".to_string())?;
            (
                window_label,
                WindowAction {
                    proof: run.proof.clone(),
                    role,
                    action_id,
                    kind: WindowActionKind::ScrollRows,
                    marker: None,
                    rows: Some(rows),
                },
            )
        };
        self.dispatch_action(app, role, window_label, action)
    }

    fn dispatch_action<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        role: WindowRole,
        window_label: String,
        action: WindowAction,
    ) -> Result<Value, String> {
        let window = app
            .get_webview_window(&window_label)
            .ok_or_else(|| format!("QA window {window_label} is unavailable"))?;
        window
            .show()
            .map_err(|error| format!("show QA window failed: {error}"))?;
        // The WebView action consumer owns focus acquisition and acknowledges it
        // in its report. Focusing here as well races the JavaScript request with
        // a second native focus transition and can transiently blur the target
        // between controller acquisition and the marker write.
        window
            .emit(QA_ACTION_EVENT, &action)
            .map_err(|error| format!("deliver QA window action failed: {error}"))?;
        Ok(json!({
            "ok": true,
            "actionId": action.action_id,
            "kind": action.kind,
            "marker": action.marker,
            "rows": action.rows,
            "window": role,
        }))
    }

    pub fn finish<R: Runtime>(&self, app: &AppHandle<R>, proof: &str) -> Result<Value, String> {
        let windows = {
            let run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            matching_run(run.as_ref(), proof)?.windows.clone()
        };
        self.terminate_temporary_session_with_retry(app, proof)?;
        self.close_windows(app, &windows);
        let mut run_slot = self.run.lock().map_err(|_| "QA run lock poisoned")?;
        let session_id = matching_run(run_slot.as_ref(), proof)?.session_id.clone();
        *run_slot = None;
        Ok(json!({ "ok": true, "sessionId": session_id, "lifecycle": "exited" }))
    }

    pub fn abort_active<R: Runtime>(&self, app: &AppHandle<R>) -> Result<Value, String> {
        let active = {
            let run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            run.as_ref().map(|run| {
                (
                    run.session_id.clone(),
                    run.workspace_id.clone(),
                    run.windows.clone(),
                )
            })
        };
        let Some((session_id, workspace_id, windows)) = active else {
            return Ok(json!({ "ok": true, "cleaned": false }));
        };

        self.terminate_temporary_session_identity_with_retry(app, &session_id, &workspace_id)?;
        self.close_windows(app, &windows);
        let mut run_slot = self.run.lock().map_err(|_| "QA run lock poisoned")?;
        if run_slot
            .as_ref()
            .is_some_and(|run| run.session_id == session_id && run.workspace_id == workspace_id)
        {
            *run_slot = None;
        }
        Ok(json!({ "ok": true, "cleaned": true, "sessionId": session_id }))
    }

    fn context(&self, window_label: &str, proof: &str) -> Result<WindowContext, String> {
        let run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
        let run = matching_run(run.as_ref(), proof)?;
        let role = run
            .windows
            .iter()
            .find_map(|(role, label)| (label == window_label).then_some(*role))
            .ok_or_else(|| "the calling window does not belong to this QA run".to_string())?;
        Ok(WindowContext {
            proof: run.proof.clone(),
            role,
            session_id: run.session_id.clone(),
            workspace_id: run.workspace_id.clone(),
            profile: run.profile,
            resize_render_provider: run.resize_render_provider.clone(),
            resize_render_screen_model: run.resize_render_screen_model,
            scrollback_marker: run.scrollback_marker.clone(),
            scrollback_soft_wrap_marker: run.scrollback_soft_wrap_marker.clone(),
        })
    }

    pub fn resize_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
        role: WindowRole,
        size: WindowSize,
    ) -> Result<Value, String> {
        let label = {
            let run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run(run.as_ref(), proof)?;
            ensure_os_focus_profile(run)?;
            run
                .windows
                .get(&role)
                .cloned()
                .ok_or_else(|| "QA target window is missing".to_string())?
        };
        let window = app
            .get_webview_window(&label)
            .ok_or_else(|| format!("QA window {label} is unavailable"))?;
        let (width, height) = match size {
            WindowSize::Compact => (520.0, 420.0),
            WindowSize::Wide => (920.0, 700.0),
        };
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|error| format!("resize QA window failed: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("focus resized QA window failed: {error}"))?;
        Ok(json!({
            "ok": true,
            "window": role,
            "size": size,
            "issuedAtMs": unix_time_ms()?,
        }))
    }

    pub fn close_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
        role: WindowRole,
    ) -> Result<Value, String> {
        let label = {
            let run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run(run.as_ref(), proof)?;
            if run.profile != WindowFocusProfile::LargeView {
                return Err("window close is reserved for large-view QA".to_string());
            }
            run
                .windows
                .get(&role)
                .cloned()
                .ok_or_else(|| "QA target window is missing".to_string())?
        };
        let issued_at_ms = unix_time_ms()?;
        // The product WebView owns prepare/conceal/unmount/release/restore.
        // A backend-side release here would let the smoke bypass user behavior.
        app.get_webview_window(&label)
            .ok_or_else(|| format!("QA window {label} is unavailable"))?
            .close()
            .map_err(|error| format!("request large-view close failed: {error}"))?;
        Ok(json!({
            "ok": true,
            "window": role,
            "issuedAtMs": issued_at_ms,
            "path": "agent_session_window",
        }))
    }

    pub fn open_large_view_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
    ) -> Result<Value, String> {
        let (run_id, windows) = {
            let run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run(run.as_ref(), proof)?;
            if run.profile != WindowFocusProfile::LargeView {
                return Err("large-view open requires its QA profile".to_string());
            }
            (run.run_id.clone(), run.windows.clone())
        };
        let label = &windows[&WindowRole::B];
        if app.get_webview_window(label).is_some() {
            return Err("detached large-view QA window is already open".to_string());
        }
        self.build_window(app, WindowBuildRequest {
            proof,
            run_id: &run_id,
            profile: WindowFocusProfile::LargeView,
            windows: &windows,
            role: WindowRole::B,
            visible: true,
        })?;
        Ok(json!({
            "ok": true,
            "window": WindowRole::B,
            "issuedAtMs": unix_time_ms()?,
            "path": "agent_session_window",
        }))
    }

    pub fn activate_resize_render<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
    ) -> Result<Value, String> {
        let (session_id, workspace_id, provider, existing_request_id) = {
            let run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run(run.as_ref(), proof)?;
            if run.profile != WindowFocusProfile::LargeView {
                return Err("resize render activation requires its QA profile".to_string());
            }
            (
                run.session_id.clone(),
                run.workspace_id.clone(),
                run.resize_render_provider
                    .clone()
                    .ok_or_else(|| "resize render provider is missing".to_string())?,
                run.resize_render_activation_request_id.clone(),
            )
        };
        let baseline_requested = existing_request_id.is_some();
        let request_id = match existing_request_id {
            Some(request_id) => request_id,
            None => activate_fixture(&session_id, &workspace_id)?,
        };

        let mut run_slot = self.run.lock().map_err(|_| "QA run lock poisoned")?;
        let run = matching_run_mut(run_slot.as_mut(), proof)?;
        run.resize_render_fixture_activated = true;
        run.resize_render_activation_request_id = Some(request_id.clone());
        let windows = run.windows.clone();
        drop(run_slot);
        if baseline_requested {
            for (role, label) in &windows {
                let Some(window) = app.get_webview_window(label) else {
                    if *role == WindowRole::B {
                        continue;
                    }
                    return Err(format!("QA window {label} is unavailable"));
                };
                window
                    .emit(QA_RESIZE_BASELINE_EVENT, json!({ "proof": proof }))
                    .map_err(|error| {
                        format!("deliver terminal resize QA baseline failed: {error}")
                    })?;
            }
        }
        Ok(json!({
            "ok": true,
            "provider": provider,
            "requestId": request_id,
            "issuedAtMs": unix_time_ms()?,
        }))
    }

    pub fn restart_webview<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
        role: WindowRole,
    ) -> Result<Value, String> {
        let (label, previous_webview_instance_id, armed_after_started_count) = {
            let mut run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run_mut(run.as_mut(), proof)?;
            if !matches!(
                run.profile,
                WindowFocusProfile::Smoke | WindowFocusProfile::Background
            ) {
                return Err("webview recovery QA requires a recovery profile".to_string());
            }
            let report = run
                .reports
                .get(&role)
                .ok_or_else(|| "QA target window has not reported ready".to_string())?;
            let ready = match run.profile {
                WindowFocusProfile::Smoke => {
                    report.mounted && report.listening && report.synchronized && !report.hydrating
                }
                _ => report.synchronized && !report.hydrating && !report.document_focused,
            };
            if !ready {
                return Err("QA target window is not ready for restart".to_string());
            }
            let label = run
                .windows
                .get(&role)
                .cloned()
                .ok_or_else(|| "QA target window is missing".to_string())?;
            let previous_webview_instance_id = report.webview_instance_id.clone();
            let armed_after_started_count = run
                .native_webview_loads
                .get(&role)
                .map_or(0, |evidence| evidence.started_count);
            run.predecessor_fence_probe = Some(PredecessorFenceProbe {
                role,
                instance_id: previous_webview_instance_id.clone(),
                armed_after_started_count,
                attempted_started_count: None,
                outcome: None,
            });
            (
                label,
                previous_webview_instance_id,
                armed_after_started_count,
            )
        };
        let window = app
            .get_webview_window(&label)
            .ok_or_else(|| format!("QA window {label} is unavailable"))?;
        window
            .eval("window.location.reload()")
            .map_err(|error| format!("reload QA WebView failed: {error}"))?;
        Ok(json!({
            "ok": true,
            "window": role,
            "previousWebviewInstanceId": previous_webview_instance_id,
            "predecessorFenceArmedAfterStartedCount": armed_after_started_count,
            "issuedAtMs": unix_time_ms()?,
        }))
    }

    fn report(&self, window_label: &str, report: WindowReport) -> Result<(), String> {
        validate_report(&report)?;
        let mut run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
        let run = matching_run_mut(run.as_mut(), &report.proof)?;
        let expected_label = run
            .windows
            .get(&report.role)
            .ok_or_else(|| "QA report role is not registered".to_string())?;
        if expected_label != window_label {
            return Err("QA report caller does not match its claimed role".to_string());
        }
        if report
            .marker_counts
            .keys()
            .chain(report.transport_markers.keys())
            .chain(report.marker_write_receipts.keys())
            .chain(report.first_seen_focused.keys())
            .chain(report.first_seen_at_ms.keys())
            .chain(report.first_paint_at_ms.keys())
            .any(|marker| !run.expected_markers.contains(marker))
        {
            return Err("QA report contains a marker not issued by this run".to_string());
        }
        if report
            .buffer_state
            .as_ref()
            .and_then(|state| state.visible_scrollback_marker.as_ref())
            .into_iter()
            .chain(
                report
                    .first_presented_buffer_state
                    .as_ref()
                    .and_then(|state| state.visible_scrollback_marker.as_ref()),
            )
            .chain(
                report
                    .marker_write_receipts
                    .values()
                    .filter_map(|receipt| {
                        receipt
                            .observation_at_host_receipt
                            .visible_scrollback_marker
                            .as_ref()
                    }),
            )
            .any(|marker| !run.expected_markers.contains(marker))
        {
            return Err("QA report contains a scrollback marker not issued by this run".to_string());
        }
        if [report.received_action_id, report.completed_action_id]
            .into_iter()
            .flatten()
            .any(|action_id| action_id == 0 || action_id >= run.next_action_id)
        {
            return Err("QA report contains an action id not issued by this run".to_string());
        }
        run.reports.insert(report.role, report);
        Ok(())
    }

    fn record_controller_native_load(&self, event: PageLoadEvent, url: String) {
        let Ok(mut controller) = self.controller_page.lock() else {
            return;
        };
        controller.observe_native_load(event, url);
    }

    fn ensure_controller_native_page_loaded(&self) -> Result<(), String> {
        if self
            .controller_page
            .lock()
            .map_err(|_| "QA controller page lock poisoned")?
            .native_finished_count
            > 0
        {
            Ok(())
        } else {
            Err("QA controller native page has not loaded".to_string())
        }
    }

    fn record_native_webview_load<R: Runtime>(
        &self,
        window: &WebviewWindow<R>,
        role: WindowRole,
        event: PageLoadEvent,
    ) {
        let Ok(observed_at_ms) = unix_time_ms() else {
            return;
        };
        let (instance_id, attempted_started_count) = {
            let Ok(mut run) = self.run.lock() else {
                return;
            };
            let Some(run) = run.as_mut() else {
                return;
            };
            if run.windows.get(&role).map(String::as_str) != Some(window.label()) {
                return;
            }
            let started_count = {
                let evidence = run.native_webview_loads.entry(role).or_default();
                evidence.observe(event, observed_at_ms);
                evidence.started_count
            };
            let Some(probe) = run.predecessor_fence_probe.as_mut() else {
                return;
            };
            if !matches!(event, PageLoadEvent::Started)
                || probe.role != role
                || probe.attempted_started_count.is_some()
                || started_count <= probe.armed_after_started_count
            {
                return;
            }
            probe.attempted_started_count = Some(started_count);
            (probe.instance_id.clone(), started_count)
        };
        // Tauri dispatches the app-level page-load hook before this per-window
        // hook, so the Hmux lifecycle has already opened the successor
        // generation. Replaying the outgoing realm's exact ID here makes the
        // otherwise timing-dependent renderer-to-native race deterministic.
        let outcome = match window
            .state::<AppState>()
            .hmux
            .capture_observer_webview(window.label(), &instance_id)
        {
            Ok(_) => PredecessorFenceOutcome::Accepted,
            Err(error) if error.starts_with("hmux_webview_instance_stale:") => {
                PredecessorFenceOutcome::StaleRejected
            }
            Err(_) => PredecessorFenceOutcome::OtherError,
        };
        let Ok(mut run) = self.run.lock() else {
            return;
        };
        let Some(run) = run.as_mut() else {
            return;
        };
        let Some(probe) = run.predecessor_fence_probe.as_mut() else {
            return;
        };
        if probe.role == role
            && probe.instance_id == instance_id
            && probe.attempted_started_count == Some(attempted_started_count)
        {
            probe.outcome = Some(outcome);
        }
    }

    fn build_windows<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
        run_id: &str,
        profile: WindowFocusProfile,
        windows: &HashMap<WindowRole, String>,
    ) -> Result<(), String> {
        let roles: &[WindowRole] = if profile == WindowFocusProfile::LargeView {
            &[WindowRole::A]
        } else {
            &[WindowRole::A, WindowRole::B]
        };
        for role in roles {
            self.build_window(app, WindowBuildRequest {
                proof,
                run_id,
                profile,
                windows,
                role: *role,
                visible: profile.allows_os_focus(),
            })?;
        }
        Ok(())
    }

    fn build_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: WindowBuildRequest<'_>,
    ) -> Result<(), String> {
        let WindowBuildRequest {
            proof,
            run_id,
            profile,
            windows,
            role,
            visible,
        } = request;
        let label = windows
            .get(&role)
            .ok_or_else(|| "QA window label is missing".to_string())?;
        let url = if profile == WindowFocusProfile::LargeView && role == WindowRole::B {
            let agent_id = format!("qa-large-view-{run_id}");
            let mut url = tauri::Url::parse("http://localhost/index.html")
                .map_err(|error| format!("create large-view QA URL failed: {error}"))?;
            url.query_pairs_mut()
                .append_pair("sessionWindow", &agent_id)
                .append_pair("sourceWindow", &windows[&WindowRole::A])
                .append_pair("qaLargeView", proof);
            WebviewUrl::App(format!("index.html?{}", url.query().unwrap_or_default()).into())
        } else {
            WebviewUrl::App(
                format!(
                    "index.html?qaWindowSmoke={proof}&run={run_id}&qaProfile={}",
                    profile.query_value()
                )
                .into(),
            )
        };
        let (width, height, x) = if profile == WindowFocusProfile::LargeView {
            match role {
                WindowRole::A => (520.0, 420.0, 30.0),
                WindowRole::B => (1_180.0, 880.0, 750.0),
            }
        } else {
            let x = if role == WindowRole::A { 30.0 } else { 750.0 };
            (QA_WINDOW_WIDTH, QA_WINDOW_HEIGHT, x)
        };
        let config = crate::webview_storage::window_config(app.config(), label, url)?;
        WebviewWindowBuilder::from_config(app, &config)
            .map_err(|error| format!("configure QA window {label} failed: {error}"))?
            .title(format!("Dure Hmux QA {}", role.marker_component()))
            .inner_size(width, height)
            .position(x, 80.0)
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
            .visible(visible)
            .focused(visible)
            .focusable(profile.allows_os_focus())
            .on_page_load(move |window, payload| {
                let state = window.state::<WindowFocusQa>();
                state.record_native_webview_load(&window, role, payload.event());
            })
            .build()
            .map_err(|error| format!("create QA window {label} failed: {error}"))?;
        Ok(())
    }

    fn preload_scrollback<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
        marker: &str,
        soft_wrap_marker: &str,
    ) -> Result<(), String> {
        let (session_id, workspace_id) = {
            let run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run(run.as_ref(), proof)?;
            (run.session_id.clone(), run.workspace_id.clone())
        };
        let manager = &app.state::<AppState>().hmux;
        let command = scrollback_preload_command(marker, soft_wrap_marker);
        crate::hmux::command_input::send_local_standalone_commands(
            &session_id,
            &workspace_id,
            ["stty -echo".to_string(), command],
            QA_COMMAND_INPUT_TIMEOUT,
        )?;
        let deadline = Instant::now() + QA_SCROLLBACK_TIMEOUT;
        while Instant::now() < deadline {
            let snapshot = manager.inspect_session_snapshot(&session_id, &workspace_id)?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(snapshot.data)
                .map_err(|error| format!("decode QA snapshot failed: {error}"))?;
            if bytes
                .windows(marker.len())
                .any(|window| window == marker.as_bytes())
            {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(20));
        }
        Err("timed out waiting for the QA scrollback sentinel".to_string())
    }

    fn preload_terminal_snapshot_seed<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
        seed: &TerminalSnapshotSeed,
    ) -> Result<(), String> {
        let (session_id, workspace_id) = {
            let run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run(run.as_ref(), proof)?;
            (run.session_id.clone(), run.workspace_id.clone())
        };
        install_snapshot_seed(app, &session_id, &workspace_id, seed)
    }

    fn terminate_temporary_session<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
    ) -> Result<(), String> {
        let (session_id, workspace_id) = {
            let run = self.run.lock().map_err(|_| "QA run lock poisoned")?;
            let run = matching_run(run.as_ref(), proof)?;
            (run.session_id.clone(), run.workspace_id.clone())
        };
        self.terminate_temporary_session_identity(app, &session_id, &workspace_id)
    }

    fn terminate_temporary_session_identity<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        session_id: &str,
        workspace_id: &str,
    ) -> Result<(), String> {
        let manager = &app.state::<AppState>().hmux;
        let mut graceful_error = crate::hmux::command_input::send_local_standalone_commands(
            session_id,
            workspace_id,
            ["exit".to_string()],
            QA_COMMAND_INPUT_TIMEOUT,
        )
        .err();

        let deadline = Instant::now() + QA_GRACEFUL_FINISH_TIMEOUT;
        while Instant::now() < deadline {
            match manager.exact_session_lifecycle(session_id, workspace_id) {
                Ok(None) => return Ok(()),
                Ok(Some("exited")) => break,
                Ok(Some(_)) => {}
                Err(error) => {
                    graceful_error.get_or_insert(error);
                }
            }
            thread::sleep(QA_FINISH_POLL_INTERVAL);
        }
        manager
            .terminate_standalone_session(session_id, workspace_id, QA_TERMINATION_TIMEOUT)
            .map_err(|termination_error| match graceful_error {
                Some(graceful_error) => format!(
                    "temporary Hmux session {session_id} cleanup failed; graceful exit: \
                     {graceful_error}; fenced termination: {termination_error}"
                ),
                None => format!(
                    "temporary Hmux session {session_id} ignored graceful exit and fenced \
                     termination failed: {termination_error}"
                ),
            })
    }

    fn terminate_temporary_session_identity_with_retry<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        session_id: &str,
        workspace_id: &str,
    ) -> Result<(), String> {
        let first_error = match self.terminate_temporary_session_identity(
            app,
            session_id,
            workspace_id,
        ) {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        thread::sleep(Duration::from_millis(250));
        self.terminate_temporary_session_identity(app, session_id, workspace_id)
            .map_err(|retry_error| {
                format!("{first_error}; cleanup retry also failed: {retry_error}")
            })
    }

    fn terminate_temporary_session_with_retry<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        proof: &str,
    ) -> Result<(), String> {
        let first_error = match self.terminate_temporary_session(app, proof) {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        thread::sleep(Duration::from_millis(250));
        self.terminate_temporary_session(app, proof)
            .map_err(|retry_error| {
                format!("{first_error}; cleanup retry also failed: {retry_error}")
            })
    }

    fn close_windows<R: Runtime>(&self, app: &AppHandle<R>, windows: &HashMap<WindowRole, String>) {
        for label in windows.values() {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.close();
            }
        }
    }
}

pub fn configure_activation_policy(app: &AppHandle<Wry>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    if std::env::var("HEBBIAN_QA_LAYER")
        .ok()
        .is_some_and(|layer| layer == "background" || layer.starts_with("exclusive_focus"))
    {
        app.set_activation_policy(tauri::ActivationPolicy::Accessory)?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

fn activate_focus_profile<R: Runtime>(
    app: &AppHandle<R>,
    profile: WindowFocusProfile,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if profile.allows_os_focus() {
        app.set_activation_policy(tauri::ActivationPolicy::Regular)
            .map_err(|error| format!("activate exclusive QA app failed: {error}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, profile);
    Ok(())
}

fn resolve_qa_proof(requested: Option<String>) -> Result<String, String> {
    let proof = match requested {
        Some(proof) => proof,
        None => crate::server::gen_token().map_err(|error| error.to_string())?,
    };
    if proof.len() != 64
        || !proof
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("QA proof must be 64 lowercase hexadecimal characters".to_string());
    }
    Ok(proof)
}

fn native_window_state<R: Runtime>(app: &AppHandle<R>, label: &str) -> Value {
    let Some(window) = app.get_webview_window(label) else {
        return json!({ "exists": false });
    };
    let inner_size = window.inner_size().ok().map(|size| {
        json!({
            "width": size.width,
            "height": size.height,
        })
    });
    json!({
        "exists": true,
        "visible": window.is_visible().ok(),
        "focused": window.is_focused().ok(),
        "innerPhysicalSize": inner_size,
    })
}

fn matching_run<'a>(run: Option<&'a SmokeRun>, proof: &str) -> Result<&'a SmokeRun, String> {
    let run = run.ok_or_else(|| "no Hmux window focus smoke is running".to_string())?;
    if run.proof != proof {
        return Err("QA proof does not match the active run".to_string());
    }
    Ok(run)
}

fn ensure_os_focus_profile(run: &SmokeRun) -> Result<(), String> {
    run.profile
        .allows_os_focus()
        .then_some(())
        .ok_or_else(|| "background QA profile refuses OS-focus actions".to_string())
}

fn matching_run_mut<'a>(
    run: Option<&'a mut SmokeRun>,
    proof: &str,
) -> Result<&'a mut SmokeRun, String> {
    let run = run.ok_or_else(|| "no Hmux window focus smoke is running".to_string())?;
    if run.proof != proof {
        return Err("QA proof does not match the active run".to_string());
    }
    Ok(run)
}

fn validate_report(report: &WindowReport) -> Result<(), String> {
    if report.webview_instance_id.is_empty()
        || report.webview_instance_id.len() > 128
        || report.webview_started_at.is_empty()
        || report.webview_started_at.len() > 64
        || report.errors.len() > 16
        || report.errors.iter().any(|error| error.len() > 512)
        || report.marker_counts.len() > QA_MARKER_LIMIT
        || report.transport_markers.len() > QA_MARKER_LIMIT
        || report.transport_markers.values().any(|present| !present)
        || report.marker_write_receipts.len() > QA_MARKER_LIMIT
        || report.marker_write_receipts.values().any(|receipt| {
            receipt.request_id.is_empty()
                || receipt.request_id.len() > 128
                || receipt.attachment_identity.is_empty()
                || receipt.attachment_identity.len() > 128
                || receipt.host_receipt_at_ms < receipt.input_started_at_ms
                || receipt
                    .host_receipt_at_ms
                    .saturating_sub(receipt.input_started_at_ms)
                    > QA_INPUT_RECEIPT_MAX_LATENCY_MS
        })
        || report.large_view_return_preparation_count > 1
        || report.first_seen_focused.len() > QA_MARKER_LIMIT
        || report.first_seen_at_ms.len() > QA_MARKER_LIMIT
        || report.first_paint_at_ms.len() > QA_MARKER_LIMIT
    {
        return Err("QA report exceeds its bounded schema".to_string());
    }
    Ok(())
}

fn ensure_marker_capacity(run: &SmokeRun) -> Result<(), String> {
    (run.expected_markers.len() < QA_MARKER_LIMIT)
        .then_some(())
        .ok_or_else(|| format!("QA run cannot issue more than {QA_MARKER_LIMIT} markers"))
}

fn unix_time_ms() -> Result<u64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock is before the Unix epoch: {error}"))?
        .as_millis();
    u64::try_from(millis).map_err(|_| "current Unix time does not fit in u64".to_string())
}

fn report_value(report: &WindowReport) -> Value {
    json!({
        "webviewInstanceId": report.webview_instance_id,
        "webviewStartedAt": report.webview_started_at,
        "webviewUptimeMs": report.webview_uptime_ms,
        "mounted": report.mounted,
        "latestSurfaceAttachmentId": report.latest_surface_attachment_id,
        "latestRetiredSurfaceAttachmentId": report.latest_retired_surface_attachment_id,
        "listening": report.listening,
        "synchronized": report.synchronized,
        "hydrating": report.hydrating,
        "documentFocused": report.document_focused,
        "terminalInputFocused": report.terminal_input_focused,
        "controlState": report.control_state,
        "transportMarkers": report.transport_markers,
        "markerWriteReceipts": report.marker_write_receipts,
        "markerCounts": report.marker_counts,
        "firstSeenFocused": report.first_seen_focused,
        "firstSeenAtMs": report.first_seen_at_ms,
        "firstPaintAtMs": report.first_paint_at_ms,
        "receivedActionId": report.received_action_id,
        "completedActionId": report.completed_action_id,
        "heartbeatCount": report.heartbeat_count,
        "maxHeartbeatLagMs": report.max_heartbeat_lag_ms,
        "renderMetrics": report.render_metrics,
        "bufferState": report.buffer_state,
        "firstPresentedBufferState": report.first_presented_buffer_state,
        "synchronizationCount": report.synchronization_count,
        "presentedCount": report.presented_count,
        "visibleFrameCount": report.visible_frame_count,
        "visibleFrameViolations": report.visible_frame_violations,
        "resizeRenderIntegrity": report.resize_render_integrity,
        "concealmentObserved": report.concealment_observed,
        "largeViewReturnPreparationCount": report.large_view_return_preparation_count,
        "errors": report.errors,
    })
}

fn predecessor_fence_value(probe: &PredecessorFenceProbe) -> Value {
    json!({
        "window": probe.role,
        "instanceId": probe.instance_id,
        "armedAfterStartedCount": probe.armed_after_started_count,
        "attemptedStartedCount": probe.attempted_started_count,
        "outcome": probe.outcome,
    })
}

#[tauri::command]
fn window_context(
    window: WebviewWindow,
    state: State<'_, WindowFocusQa>,
    proof: String,
) -> Result<WindowContext, String> {
    state.context(window.label(), &proof)
}

#[tauri::command]
fn report_window(
    window: WebviewWindow,
    state: State<'_, WindowFocusQa>,
    report: WindowReport,
) -> Result<(), String> {
    state.report(window.label(), report)
}

pub fn plugin() -> TauriPlugin<Wry> {
    PluginBuilder::new(QA_PLUGIN_NAME)
        .invoke_handler(tauri::generate_handler![
            window_context, report_window,
            storage_probe::storage_snapshot, storage_probe::storage_native_peer
        ])
        .on_page_load(|webview, payload| {
            if webview.label() == "main" {
                let state = webview.state::<WindowFocusQa>();
                state.record_controller_native_load(payload.event(), payload.url().to_string());
            }
        })
        .on_event(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                let _ = app.state::<WindowFocusQa>().abort_active(app);
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input_receipt_observation() -> WindowInputReceiptObservation {
        WindowInputReceiptObservation {
            snapshot_collapses: 1,
            scrollback_rows: 600,
            at_bottom: true,
            concealed: false,
            history_hydrating: false,
            visible_scrollback_marker: None,
            visible_frame_count: 2,
            visible_frame_violations: 0,
        }
    }

    fn run() -> SmokeRun {
        SmokeRun {
            proof: "proof".into(),
            run_id: "0123456789ab".into(),
            session_id: "session".into(),
            workspace_id: "workspace".into(),
            profile: WindowFocusProfile::Smoke,
            resize_render_provider: None,
            resize_render_screen_model: None,
            resize_render_seed: None,
            resize_render_fixture_activated: false,
            resize_render_activation_request_id: None,
            presentation: WindowPresentation::Visible,
            windows: HashMap::from([
                (WindowRole::A, "window-a".into()),
                (WindowRole::B, "window-b".into()),
            ]),
            native_webview_loads: HashMap::new(),
            predecessor_fence_probe: None,
            reports: HashMap::new(),
            expected_markers: vec!["HMUX_WINDOW_QA_0123456789AB_A_0001".into()],
            scrollback_marker: None,
            scrollback_soft_wrap_marker: None,
            next_action_id: 2,
        }
    }

    fn report(role: WindowRole) -> WindowReport {
        WindowReport {
            proof: "proof".into(),
            role,
            webview_instance_id: "webview-test".into(),
            webview_started_at: "2026-07-28T00:00:00.000Z".into(),
            webview_uptime_ms: 1,
            mounted: true,
            latest_surface_attachment_id: None,
            latest_retired_surface_attachment_id: None,
            listening: true,
            synchronized: true,
            hydrating: false,
            document_focused: false,
            terminal_input_focused: false,
            control_state: WindowControlState::Viewing,
            transport_markers: BTreeMap::new(),
            marker_write_receipts: BTreeMap::new(),
            marker_counts: BTreeMap::new(),
            first_seen_focused: BTreeMap::new(),
            first_seen_at_ms: BTreeMap::new(),
            first_paint_at_ms: BTreeMap::new(),
            received_action_id: None,
            completed_action_id: None,
            heartbeat_count: 1,
            max_heartbeat_lag_ms: 0,
            render_metrics: None,
            buffer_state: None,
            first_presented_buffer_state: None,
            synchronization_count: 1,
            presented_count: 1,
            visible_frame_count: 1,
            visible_frame_violations: 0,
            resize_render_integrity: None,
            concealment_observed: false,
            large_view_return_preparation_count: 0,
            errors: Vec::new(),
        }
    }

    #[test]
    fn proof_and_window_role_both_guard_reports() {
        let state = WindowFocusQa {
            controller_page: Mutex::new(ControllerPageEvidence::default()),
            run: Mutex::new(Some(run())),
        };
        assert!(state.report("window-a", report(WindowRole::A)).is_ok());
        assert!(state.report("window-b", report(WindowRole::A)).is_err());
        let mut wrong_proof = report(WindowRole::B);
        wrong_proof.proof = "wrong".into();
        assert!(state.report("window-b", wrong_proof).is_err());
    }

    #[test]
    fn requested_proof_requires_exact_lowercase_hex() {
        let proof = "0123456789abcdef".repeat(4);
        assert_eq!(resolve_qa_proof(Some(proof.clone())).unwrap(), proof);
        assert!(resolve_qa_proof(Some("a".repeat(63))).is_err());
        assert!(resolve_qa_proof(Some("A".repeat(64))).is_err());
        assert!(resolve_qa_proof(Some("g".repeat(64))).is_err());
    }

    #[test]
    fn native_webview_load_evidence_keeps_started_and_finished_distinct() {
        let mut evidence = NativeWebviewLoadEvidence::default();
        evidence.observe(PageLoadEvent::Started, 100);
        evidence.observe(PageLoadEvent::Started, 110);
        evidence.observe(PageLoadEvent::Finished, 120);

        assert_eq!(evidence.started_count, 2);
        assert_eq!(evidence.finished_count, 1);
        assert_eq!(evidence.first_started_at_ms, Some(100));
        assert_eq!(evidence.last_finished_at_ms, Some(120));
    }

    #[test]
    fn scrollback_fixture_keeps_a_live_normal_buffer_command_stream() {
        let command = scrollback_preload_command("BOTTOM", "SOFT_WRAP");

        assert!(command.contains("-le 600"));
        assert!(command.contains("BOTTOM"));
        assert!(command.contains("SOFT_WRAP"));
        assert!(command.contains("exec /bin/sh -s"));
        assert!(!command.contains("exec cat"));
        assert!(!command.contains("\\033[?1049"));
    }

    #[test]
    fn buffer_geometry_evidence_round_trips_through_the_qa_report_contract() {
        let mut wire = serde_json::to_value(report(WindowRole::A)).unwrap();
        wire["bufferState"] = json!({
            "columns": 87,
            "rows": 29,
            "fitColumns": 87,
            "fitRows": 29,
            "fitDimensionsMatch": true,
            "viewportFill": {
                "containerHeight": 580.0,
                "gridHeight": 578.0,
                "effectiveGridHeight": 580.0,
                "rowHeight": 19.93,
                "unfilledHeight": 0.0,
                "overflowHeight": 0.0,
                "fillsContainer": true
            },
            "verticalScrollbar": {
                "trackHeightPx": 580.0,
                "sliderTopPx": 550.0,
                "sliderHeightPx": 30.0,
                "bottomGapPx": 0.0,
                "normalizedPosition": 1.0,
                "atBottom": true
            },
            "bufferLength": 614,
            "scrollbackRows": 585,
            "viewportY": 585,
            "atBottom": true,
            "concealed": false,
            "resizeRenderSeedVisible": false,
            "resizeRender": null
        });
        let decoded: WindowReport = serde_json::from_value(wire).unwrap();
        let projected = report_value(&decoded);

        assert_eq!(
            projected["bufferState"]["verticalScrollbar"]["atBottom"],
            json!(true)
        );
        assert_eq!(
            projected["bufferState"]["viewportFill"]["fillsContainer"],
            json!(true)
        );
    }

    #[test]
    fn host_receipt_observation_round_trips_through_the_qa_report_contract() {
        let marker = "HMUX_WINDOW_QA_0123456789AB_A_0001";
        let mut source = report(WindowRole::A);
        source.latest_surface_attachment_id = Some("attachment-a".into());
        source.latest_retired_surface_attachment_id = Some("attachment-a".into());
        source.marker_write_receipts.insert(
            marker.into(),
            WindowInputReceipt {
                request_id: "request-1".into(),
                attachment_identity: "attachment-a:terminal-a".into(),
                state: WindowInputReceiptState::WrittenToPty,
                input_started_at_ms: 100,
                host_receipt_at_ms: 110,
                observation_at_host_receipt: input_receipt_observation(),
            },
        );

        let wire = serde_json::to_value(source).unwrap();
        let decoded: WindowReport = serde_json::from_value(wire).unwrap();

        assert!(validate_report(&decoded).is_ok());
        assert_eq!(
            report_value(&decoded)["latestSurfaceAttachmentId"],
            json!("attachment-a")
        );
        assert_eq!(
            report_value(&decoded)["latestRetiredSurfaceAttachmentId"],
            json!("attachment-a")
        );
        assert_eq!(
            report_value(&decoded)["markerWriteReceipts"][marker]["attachmentIdentity"],
            json!("attachment-a:terminal-a")
        );
        assert_eq!(
            report_value(&decoded)["markerWriteReceipts"][marker]
                ["observationAtHostReceipt"]["snapshotCollapses"],
            json!(1)
        );
    }

    #[test]
    fn reports_cannot_invent_unissued_markers() {
        let state = WindowFocusQa {
            controller_page: Mutex::new(ControllerPageEvidence::default()),
            run: Mutex::new(Some(run())),
        };
        let mut candidate = report(WindowRole::A);
        candidate
            .marker_counts
            .insert("HMUX_WINDOW_QA_OTHER_A_9999".into(), 1);
        assert!(state.report("window-a", candidate).is_err());

        let mut candidate = report(WindowRole::A);
        candidate
            .first_seen_focused
            .insert("HMUX_WINDOW_QA_OTHER_A_9999".into(), false);
        assert!(state.report("window-a", candidate).is_err());

        let mut candidate = report(WindowRole::A);
        candidate
            .first_seen_at_ms
            .insert("HMUX_WINDOW_QA_OTHER_A_9999".into(), 1);
        assert!(state.report("window-a", candidate).is_err());

        let mut candidate = report(WindowRole::A);
        candidate
            .transport_markers
            .insert("HMUX_WINDOW_QA_OTHER_A_9999".into(), true);
        assert!(state.report("window-a", candidate).is_err());

        let mut candidate = report(WindowRole::A);
        candidate.marker_write_receipts.insert(
            "HMUX_WINDOW_QA_OTHER_A_9999".into(),
            WindowInputReceipt {
                request_id: "request-1".into(),
                attachment_identity: "attachment-a:terminal-a".into(),
                state: WindowInputReceiptState::WrittenToPty,
                input_started_at_ms: 100,
                host_receipt_at_ms: 110,
                observation_at_host_receipt: input_receipt_observation(),
            },
        );
        assert!(state.report("window-a", candidate).is_err());

        let mut candidate = report(WindowRole::A);
        let mut observation = input_receipt_observation();
        observation.visible_scrollback_marker =
            Some("HMUX_SCROLL_QA_OTHER_READY".into());
        candidate.marker_write_receipts.insert(
            "HMUX_WINDOW_QA_0123456789AB_A_0001".into(),
            WindowInputReceipt {
                request_id: "request-1".into(),
                attachment_identity: "attachment-a:terminal-a".into(),
                state: WindowInputReceiptState::WrittenToPty,
                input_started_at_ms: 100,
                host_receipt_at_ms: 110,
                observation_at_host_receipt: observation,
            },
        );
        assert!(state.report("window-a", candidate).is_err());
    }

    #[test]
    fn reports_reject_unbounded_or_false_pipeline_evidence() {
        let mut candidate = report(WindowRole::A);
        candidate
            .transport_markers
            .insert("HMUX_WINDOW_QA_0123456789AB_A_0001".into(), false);
        assert!(validate_report(&candidate).is_err());

        let mut candidate = report(WindowRole::A);
        candidate.marker_write_receipts.insert(
            "HMUX_WINDOW_QA_0123456789AB_A_0001".into(),
            WindowInputReceipt {
                request_id: "x".repeat(129),
                attachment_identity: "attachment-a:terminal-a".into(),
                state: WindowInputReceiptState::WrittenToPty,
                input_started_at_ms: 100,
                host_receipt_at_ms: 110,
                observation_at_host_receipt: input_receipt_observation(),
            },
        );
        assert!(validate_report(&candidate).is_err());

        let mut candidate = report(WindowRole::A);
        candidate.marker_write_receipts.insert(
            "HMUX_WINDOW_QA_0123456789AB_A_0001".into(),
            WindowInputReceipt {
                request_id: "request-1".into(),
                attachment_identity: "attachment-a:terminal-a".into(),
                state: WindowInputReceiptState::WrittenToPty,
                input_started_at_ms: 200,
                host_receipt_at_ms: 100,
                observation_at_host_receipt: input_receipt_observation(),
            },
        );
        assert!(validate_report(&candidate).is_err());

    }

    #[test]
    fn reports_cannot_acknowledge_unissued_actions() {
        let state = WindowFocusQa {
            controller_page: Mutex::new(ControllerPageEvidence::default()),
            run: Mutex::new(Some(run())),
        };
        let mut candidate = report(WindowRole::A);
        candidate.completed_action_id = Some(2);
        assert!(state.report("window-a", candidate).is_err());

        let mut candidate = report(WindowRole::A);
        candidate.received_action_id = Some(2);
        assert!(state.report("window-a", candidate).is_err());
    }

    #[test]
    fn action_payload_omits_unrelated_optional_fields() {
        let focus = WindowAction {
            proof: "proof".into(),
            role: WindowRole::A,
            action_id: 1,
            kind: WindowActionKind::Focus,
            marker: None,
            rows: None,
        };
        let marker = WindowAction {
            kind: WindowActionKind::Marker,
            marker: Some("HMUX_WINDOW_QA_0123456789AB_A_0001".into()),
            ..focus.clone()
        };
        let scroll = WindowAction {
            kind: WindowActionKind::ScrollRows,
            rows: Some(1),
            ..focus.clone()
        };

        assert!(serde_json::to_value(&focus)
            .unwrap()
            .get("marker")
            .is_none());
        assert_eq!(
            serde_json::to_value(marker).unwrap()["marker"],
            "HMUX_WINDOW_QA_0123456789AB_A_0001"
        );
        assert_eq!(serde_json::to_value(&focus).unwrap()["kind"], "focus");
        assert_eq!(
            serde_json::to_value(&scroll).unwrap()["rows"],
            1
        );
        assert!(serde_json::to_value(scroll)
            .unwrap()
            .get("marker")
            .is_none());
    }

    #[test]
    fn background_profile_refuses_every_os_focus_action() {
        let mut background = run();
        background.profile = WindowFocusProfile::Background;
        assert!(ensure_os_focus_profile(&background).is_err());
        assert_eq!(background.profile.query_value(), "background");
        assert!(!background.profile.allows_os_focus());
    }

    #[test]
    fn context_is_only_available_to_registered_run_windows() {
        let state = WindowFocusQa {
            controller_page: Mutex::new(ControllerPageEvidence::default()),
            run: Mutex::new(Some(run())),
        };
        assert_eq!(
            state.context("window-b", "proof").unwrap().role,
            WindowRole::B
        );
        assert!(state.context("main", "proof").is_err());
        assert!(state.context("window-a", "wrong").is_err());
    }

    #[test]
    fn controller_native_page_load_is_required_before_start() {
        let state = WindowFocusQa::default();
        assert!(state.ensure_controller_native_page_loaded().is_err());
        state.record_controller_native_load(
            PageLoadEvent::Finished,
            "http://127.0.0.1:1420/index.html?qaWindowSmokeController=1".into(),
        );
        assert!(state.ensure_controller_native_page_loaded().is_ok());
        let evidence = state.controller_page.lock().unwrap().clone();
        assert_eq!(evidence.native_started_count, 0);
        assert_eq!(evidence.native_finished_count, 1);
        assert!(evidence.native_url.as_deref().is_some_and(|url| {
            url.ends_with("/index.html?qaWindowSmokeController=1")
        }));
    }
}
