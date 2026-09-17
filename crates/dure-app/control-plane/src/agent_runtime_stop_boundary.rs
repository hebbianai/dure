pub(crate) const SOURCE_RETAINED_CODE: &str = "agent_runtime_source_retained";

pub(crate) enum SourceStopFailure {
    SourceRetained,
    Failed(String),
}

impl From<String> for SourceStopFailure {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}
