use crate::browser_engine::runtime::{
    BrowserAction, BrowserLaunchScripts, BrowserPageUrl, BrowserQuery, BrowserWait, ImageCapture,
};
use dure_app::{
    BrowserProfileIdV1, BrowserProfileScopeV1, BrowserProfileUserAgentModeV1, OperationIdV1,
    WorkspaceIdV1,
};
use hmux_session_protocol::browser_dialog::{BrowserDialogIdentity, BrowserDialogResponse};
use hmux_session_protocol::browser_resource::*;
use hmux_session_protocol::browser_tracing::BrowserTracingStopAuthority;
use hmux_session_protocol::browser_workspace::BrowserWorkspaceTarget;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum BrowserRequest {
    Workspaces {
        after: Option<WorkspaceIdV1>,
    },
    ProfileSet {
        caller: BrowserControllerId,
        authority: BrowserActionAuthority,
        profile_id: BrowserProfileIdV1,
    },
    ProfileClone {
        caller: BrowserControllerId,
        authority: BrowserActionAuthority,
        profile_id: BrowserProfileIdV1,
    },
    ProfileNewPage {
        caller: BrowserControllerId,
        authority: BrowserActionAuthority,
        profile_id: BrowserProfileIdV1,
        url: BrowserPageUrl,
        label: Option<BrowserPageLabel>,
    },
    ProfileList,
    ProfileDelete {
        operation_id: OperationIdV1,
        profile_id: BrowserProfileIdV1,
    },
    ProfileCreate {
        operation_id: OperationIdV1,
        label: String,
        #[serde(default = "isolated_profile_scope")]
        scope: BrowserProfileScopeV1,
        #[serde(default)]
        user_agent_mode: BrowserProfileUserAgentModeV1,
    },
    UploadChunk {
        resource: BrowserResourceIdentity,
        chunk: crate::browser_engine::runtime::BrowserUploadChunk,
    },
    Create {
        workspace_id: Option<WorkspaceIdV1>,
        workspace_path: Option<String>,
        operation_id: OperationIdV1,
        #[serde(default)]
        profile_id: Option<BrowserProfileIdV1>,
        #[serde(default)]
        init_scripts: BrowserLaunchScripts,
        #[serde(default)]
        features: Vec<crate::browser_engine::runtime::BrowserLaunchFeature>,
    },
    List {
        workspace_id: Option<WorkspaceIdV1>,
        workspace_path: Option<String>,
    },
    Observe {
        resource_id: BrowserResourceId,
    },
    SelectResource {
        resource: BrowserResourceIdentity,
        expected: BrowserWorkspaceTarget,
        operation_id: OperationIdV1,
    },
    ControlState {
        resource_id: BrowserResourceId,
    },
    DialogState {
        resource_id: BrowserResourceId,
        page_id: BrowserPageId,
    },
    DialogRespond {
        caller: BrowserControllerId,
        authority: BrowserActionAuthority,
        dialog: BrowserDialogIdentity,
        response: BrowserDialogResponse,
    },
    Control {
        resource: BrowserResourceIdentity,
        controller_id: BrowserControllerId,
        expected: Option<BrowserControllerLease>,
        operation_id: OperationIdV1,
    },
    Action {
        caller: BrowserControllerId,
        authority: BrowserActionAuthority,
        action: Box<BrowserAction>,
    },
    Snapshot {
        page: BrowserPageIdentity,
        #[serde(default)]
        options: crate::browser_engine::runtime::BrowserSnapshotOptions,
    },
    Screenshot {
        page: BrowserPageIdentity,
    },
    Frame {
        page: BrowserPageIdentity,
    },
    Capture {
        page: BrowserPageIdentity,
        options: ImageCapture,
        operation_id: OperationIdV1,
    },
    CaptureDiff {
        page: BrowserPageIdentity,
        options: ImageCapture,
        baseline: crate::browser_engine::runtime::BrowserUploadId,
        threshold: f64,
        operation_id: OperationIdV1,
    },
    Artifact {
        operation_id: OperationIdV1,
        offset: u64,
    },
    Query {
        page: BrowserPageIdentity,
        query: BrowserQuery,
    },
    Wait {
        page: BrowserPageIdentity,
        wait: BrowserWait,
    },
    Network {
        page: BrowserPageIdentity,
    },
    NetworkState {
        resource: BrowserResourceIdentity,
        page_id: BrowserPageId,
    },
    NetworkDetail {
        page: BrowserPageIdentity,
        sequence: hmux_session_protocol::browser_network::BrowserNetworkSequence,
        operation_id: OperationIdV1,
        #[serde(default)]
        export_file: bool,
    },
    InterceptionState {
        resource: BrowserResourceIdentity,
        page_id: BrowserPageId,
    },
    NetworkCaptureState {
        resource: BrowserResourceIdentity,
        page_id: BrowserPageId,
    },
    RecordingState {
        resource: BrowserResourceIdentity,
        page_id: BrowserPageId,
    },
    TracingState {
        resource: BrowserResourceIdentity,
        page_id: BrowserPageId,
    },
    TracingIntervals {
        resource: BrowserResourceIdentity,
    },
    TracingStop {
        caller: BrowserControllerId,
        authority: BrowserTracingStopAuthority,
    },
    Console {
        resource: BrowserResourceIdentity,
        page_id: BrowserPageId,
        #[serde(default)]
        query: hmux_session_protocol::browser_console::BrowserConsoleQuery,
    },
    Close {
        resource: BrowserResourceIdentity,
        operation_id: OperationIdV1,
    },
    Receipt {
        operation_id: OperationIdV1,
    },
}

impl BrowserRequest {
    pub(super) fn operation_id(&self) -> Option<OperationIdV1> {
        match self {
            Self::TracingStop { authority, .. } => Some(
                OperationIdV1::new(authority.operation_id.as_str())
                    .expect("browser and domain identifiers share the same grammar"),
            ),
            Self::Create { operation_id, .. }
            | Self::SelectResource { operation_id, .. }
            | Self::ProfileCreate { operation_id, .. }
            | Self::ProfileDelete { operation_id, .. }
            | Self::Control { operation_id, .. }
            | Self::Capture { operation_id, .. }
            | Self::CaptureDiff { operation_id, .. }
            | Self::NetworkDetail { operation_id, .. }
            | Self::Close { operation_id, .. } => Some(operation_id.clone()),
            Self::Action { authority, .. }
            | Self::DialogRespond { authority, .. }
            | Self::ProfileSet { authority, .. }
            | Self::ProfileNewPage { authority, .. }
            | Self::ProfileClone { authority, .. } => Some(
                OperationIdV1::new(authority.operation_id.as_str())
                    .expect("browser and domain identifiers share the same grammar"),
            ),
            _ => None,
        }
    }
}

fn isolated_profile_scope() -> BrowserProfileScopeV1 {
    BrowserProfileScopeV1::Isolated
}
