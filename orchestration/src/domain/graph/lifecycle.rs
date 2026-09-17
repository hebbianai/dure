use sha2::{Digest, Sha256};

use super::{
    CompiledWorkflow, GraphIssue, WorkflowChangeRequest, WorkflowPutRequest, WorkflowRecord,
    WorkflowVersion,
};

impl WorkflowRecord {
    pub fn save(
        current: Option<&Self>,
        request: &WorkflowPutRequest,
        now: i64,
    ) -> Result<Self, GraphIssue> {
        request.validate()?;
        if current.map_or(0, |record| record.revision) != request.expected_revision
            || current.is_some_and(|record| record.workflow_id != request.workflow_id)
        {
            return Err(GraphIssue::new("workflow_revision_conflict", None, None));
        }
        if now < 0 {
            return Err(GraphIssue::new("workflow_time_invalid", None, None));
        }
        Ok(Self {
            schema_version: 1,
            workflow_id: request.workflow_id.clone(),
            revision: request.expected_revision + 1,
            name: request.name.clone(),
            definition: request.definition.clone(),
            trigger: request.trigger.clone(),
            enabled: current.is_some_and(|record| record.enabled),
            active_version: current.and_then(|record| record.active_version),
            created_at_ms: current.map_or(now, |record| record.created_at_ms),
            updated_at_ms: current.map_or(now, |record| record.updated_at_ms.max(now)),
        })
    }

    pub fn check_change(&self, request: &WorkflowChangeRequest) -> Result<(), GraphIssue> {
        request.validate()?;
        if self.workflow_id != request.workflow_id || self.revision != request.expected_revision {
            return Err(GraphIssue::new("workflow_revision_conflict", None, None));
        }
        Ok(())
    }

    pub fn snapshot(
        &self,
        graph: &CompiledWorkflow,
        version: u64,
        now: i64,
    ) -> Result<WorkflowVersion, GraphIssue> {
        if !graph.compiled_from(&self.definition)
            || version == 0
            || version > i64::MAX as u64
            || now < 0
        {
            return Err(GraphIssue::new("workflow_snapshot_invalid", None, None));
        }
        // Compilation normalizes ordering. Configuration and its trigger are
        // pinned together; canvas presentation is never part of this identity.
        let identity = serde_json::to_vec(&(graph.digest(), &self.name, &self.trigger))
            .map_err(|_| GraphIssue::new("workflow_snapshot_invalid", None, None))?;
        Ok(WorkflowVersion {
            schema_version: 1,
            workflow_id: self.workflow_id.clone(),
            version,
            source_revision: self.revision,
            name: self.name.clone(),
            definition: graph.definition().clone(),
            trigger: self.trigger.clone(),
            digest: format!("{:x}", Sha256::digest(identity)),
            created_at_ms: now,
        })
    }

    pub fn activate(
        &self,
        request: &WorkflowChangeRequest,
        version: &WorkflowVersion,
        now: i64,
    ) -> Result<Self, GraphIssue> {
        self.check_change(request)?;
        if version.workflow_id != self.workflow_id
            || version.source_revision != self.revision
            || now < 0
        {
            return Err(GraphIssue::new("workflow_snapshot_invalid", None, None));
        }
        Ok(Self {
            revision: self.revision + 1,
            active_version: Some(version.version),
            enabled: true,
            updated_at_ms: self.updated_at_ms.max(now),
            ..self.clone()
        })
    }

    pub fn pause(&self, request: &WorkflowChangeRequest, now: i64) -> Result<Self, GraphIssue> {
        self.check_change(request)?;
        if now < 0 {
            return Err(GraphIssue::new("workflow_time_invalid", None, None));
        }
        Ok(Self {
            revision: self.revision + 1,
            enabled: false,
            updated_at_ms: self.updated_at_ms.max(now),
            ..self.clone()
        })
    }
}
