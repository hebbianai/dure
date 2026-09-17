use super::{
    AgentIdentityProjection, AgentRuntimeStateProjection, AgentStateReport,
    AgentStateReportReceipt, ControlReceipt, ControlRelease, ControlRequest, Detach, ErrorFrame,
    Exit, Hello, HelloAck, Input, InputReceipt, ManagedAuthorizationGrantReceipt,
    ManagedAuthorizationGrantRequest, ManagedProviderStop, ManagedProviderStopReceipt, OutputDelta,
    ProtocolVersion, ProviderConversationIdentityProjection, ReplayGap, Resize, ResizeReceipt,
    ScreenSnapshot, ScreenSnapshotRequest, SessionRetirementReceipt, SessionRetirementRequest,
    StandaloneTerminate, StandaloneTerminateReceipt, WorkingDirectoryProjection,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WireFrame {
    pub protocol_version: ProtocolVersion,
    #[serde(with = "super::json_u64")]
    pub frame_id: u64,
    pub body: FrameBody,
}

impl WireFrame {
    #[must_use]
    pub fn kind(&self) -> FrameKind {
        self.body.kind()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum FrameBody {
    Hello(Hello),
    HelloAck(HelloAck),
    ScreenSnapshot(ScreenSnapshot),
    ScreenSnapshotRequest(ScreenSnapshotRequest),
    OutputDelta(OutputDelta),
    WorkingDirectory(WorkingDirectoryProjection),
    AgentIdentity(AgentIdentityProjection),
    AgentRuntimeState(AgentRuntimeStateProjection),
    ProviderConversationIdentity(ProviderConversationIdentityProjection),
    ReplayGap(ReplayGap),
    Input(Input),
    InputReceipt(InputReceipt),
    Resize(Resize),
    ResizeReceipt(ResizeReceipt),
    StandaloneTerminate(StandaloneTerminate),
    StandaloneTerminateReceipt(StandaloneTerminateReceipt),
    ManagedProviderStop(ManagedProviderStop),
    ManagedProviderStopReceipt(ManagedProviderStopReceipt),
    ManagedAuthorizationGrantRequest(ManagedAuthorizationGrantRequest),
    ManagedAuthorizationGrantReceipt(ManagedAuthorizationGrantReceipt),
    AgentStateReport(AgentStateReport),
    AgentStateReportReceipt(AgentStateReportReceipt),
    ControlRequest(ControlRequest),
    ControlRelease(ControlRelease),
    ControlReceipt(ControlReceipt),
    SessionRetirementRequest(SessionRetirementRequest),
    SessionRetirementReceipt(SessionRetirementReceipt),
    Detach(Detach),
    Exit(Exit),
    Error(ErrorFrame),
}

impl FrameBody {
    #[must_use]
    pub fn kind(&self) -> FrameKind {
        match self {
            Self::Hello(_) => FrameKind::Hello,
            Self::HelloAck(_) => FrameKind::HelloAck,
            Self::ScreenSnapshot(_) => FrameKind::ScreenSnapshot,
            Self::ScreenSnapshotRequest(_) => FrameKind::ScreenSnapshotRequest,
            Self::OutputDelta(_) => FrameKind::OutputDelta,
            Self::WorkingDirectory(_) => FrameKind::WorkingDirectory,
            Self::AgentIdentity(_) => FrameKind::AgentIdentity,
            Self::AgentRuntimeState(_) => FrameKind::AgentRuntimeState,
            Self::ProviderConversationIdentity(_) => FrameKind::ProviderConversationIdentity,
            Self::ReplayGap(_) => FrameKind::ReplayGap,
            Self::Input(_) => FrameKind::Input,
            Self::InputReceipt(_) => FrameKind::InputReceipt,
            Self::Resize(_) => FrameKind::Resize,
            Self::ResizeReceipt(_) => FrameKind::ResizeReceipt,
            Self::StandaloneTerminate(_) => FrameKind::StandaloneTerminate,
            Self::StandaloneTerminateReceipt(_) => FrameKind::StandaloneTerminateReceipt,
            Self::ManagedProviderStop(_) => FrameKind::ManagedProviderStop,
            Self::ManagedProviderStopReceipt(_) => FrameKind::ManagedProviderStopReceipt,
            Self::ManagedAuthorizationGrantRequest(_) => {
                FrameKind::ManagedAuthorizationGrantRequest
            }
            Self::ManagedAuthorizationGrantReceipt(_) => {
                FrameKind::ManagedAuthorizationGrantReceipt
            }
            Self::AgentStateReport(_) => FrameKind::AgentStateReport,
            Self::AgentStateReportReceipt(_) => FrameKind::AgentStateReportReceipt,
            Self::ControlRequest(_) => FrameKind::ControlRequest,
            Self::ControlRelease(_) => FrameKind::ControlRelease,
            Self::ControlReceipt(_) => FrameKind::ControlReceipt,
            Self::SessionRetirementRequest(_) => FrameKind::SessionRetirementRequest,
            Self::SessionRetirementReceipt(_) => FrameKind::SessionRetirementReceipt,
            Self::Detach(_) => FrameKind::Detach,
            Self::Exit(_) => FrameKind::Exit,
            Self::Error(_) => FrameKind::Error,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameKind {
    Hello,
    HelloAck,
    ScreenSnapshot,
    ScreenSnapshotRequest,
    OutputDelta,
    WorkingDirectory,
    AgentIdentity,
    AgentRuntimeState,
    ProviderConversationIdentity,
    ReplayGap,
    Input,
    InputReceipt,
    Resize,
    ResizeReceipt,
    StandaloneTerminate,
    StandaloneTerminateReceipt,
    ManagedProviderStop,
    ManagedProviderStopReceipt,
    ManagedAuthorizationGrantRequest,
    ManagedAuthorizationGrantReceipt,
    AgentStateReport,
    AgentStateReportReceipt,
    ControlRequest,
    ControlRelease,
    ControlReceipt,
    SessionRetirementRequest,
    SessionRetirementReceipt,
    Detach,
    Exit,
    Error,
}
