use crate::local_protocol::{AgentIdentitySource, AgentProvider};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentIdentityObservation {
    pub agent: Option<AgentProvider>,
    pub source: AgentIdentitySource,
}

impl AgentIdentityObservation {
    #[must_use]
    pub fn process_inspection(agent: Option<AgentProvider>) -> Self {
        Self {
            agent,
            source: AgentIdentitySource::ProcessInspection,
        }
    }
}
