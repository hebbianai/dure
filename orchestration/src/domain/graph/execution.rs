//! Sequential admission for a dependency graph. Action effects belong to runtime
//! adapters. A persisted started dispatch is never treated as safe to repeat.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{ActionContract, ActionRef, CompiledWorkflow, GraphIssue, WorkflowVersion};
use crate::domain::{DispatchId, RunId, TaskId};

pub type ActionValues = BTreeMap<String, Value>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRun {
    pub schema_version: u16,
    pub run_id: RunId,
    pub workflow_id: String,
    pub workflow_version: u64,
    pub source_digest: String,
    pub revision: u64,
    pub trigger: RunTrigger,
    pub tasks: Vec<ActionTask>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RunTrigger {
    Manual,
    Schedule {
        #[serde(rename = "scheduledForMs")]
        scheduled_for_ms: i64,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionTask {
    pub task_id: TaskId,
    pub node_id: String,
    pub dispatch_id: DispatchId,
    pub action: ActionRef,
    pub state: ActionState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionTaskSummary {
    pub task_id: TaskId,
    pub node_id: String,
    pub dispatch_id: DispatchId,
    pub action: ActionRef,
    pub state: ActionStateSummary,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ActionStateSummary {
    Pending,
    Started,
    Completed,
    Failed { uncertain: bool, code: String },
}

impl ActionTask {
    pub fn summary(&self) -> ActionTaskSummary {
        let state = match &self.state {
            ActionState::Pending => ActionStateSummary::Pending,
            ActionState::Started { .. } => ActionStateSummary::Started,
            ActionState::Completed { .. } => ActionStateSummary::Completed,
            ActionState::Failed {
                uncertain, code, ..
            } => ActionStateSummary::Failed {
                uncertain: *uncertain,
                code: code.clone(),
            },
        };
        ActionTaskSummary {
            task_id: self.task_id.clone(),
            node_id: self.node_id.clone(),
            dispatch_id: self.dispatch_id.clone(),
            action: self.action.clone(),
            state,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ActionState {
    Pending,
    Started {
        owner: String,
        inputs: ActionValues,
        #[serde(rename = "startedAtMs")]
        started_at_ms: i64,
        #[serde(rename = "effectRef", skip_serializing_if = "Option::is_none")]
        effect_ref: Option<String>,
    },
    Completed {
        inputs: ActionValues,
        outputs: ActionValues,
        #[serde(rename = "completedAtMs")]
        completed_at_ms: i64,
        #[serde(rename = "effectRef", skip_serializing_if = "Option::is_none")]
        effect_ref: Option<String>,
    },
    Failed {
        inputs: ActionValues,
        #[serde(skip_serializing_if = "Option::is_none")]
        outputs: Option<ActionValues>,
        code: String,
        /// Effects may have happened, but no definitive result was retained.
        uncertain: bool,
        #[serde(rename = "completedAtMs")]
        completed_at_ms: i64,
        #[serde(rename = "effectRef", skip_serializing_if = "Option::is_none")]
        effect_ref: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Uncertain,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRunSummary {
    pub schema_version: u16,
    pub run_id: RunId,
    pub workflow_id: String,
    pub workflow_version: u64,
    pub source_digest: String,
    pub status: RunStatus,
    pub trigger: RunTrigger,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// A parsed execution snapshot. Runtime transitions accept this handle rather
/// than repeatedly trusting a serialized graph or adapter output.
pub struct ExecutingWorkflow {
    graph: CompiledWorkflow,
    run: WorkflowRun,
}

impl ExecutingWorkflow {
    pub fn admit(
        version: &WorkflowVersion,
        contracts: &[ActionContract],
        key: &str,
        trigger: RunTrigger,
        now: i64,
    ) -> Result<Self, Vec<GraphIssue>> {
        if !super::model::valid_id(key) || now < 0 {
            return Err(vec![issue("run_request_invalid")]);
        }
        let graph = CompiledWorkflow::parse(version.definition.clone(), contracts)?;
        let digest = format!(
            "{:x}",
            Sha256::digest(format!("{}:{}:{key}", version.workflow_id, version.version))
        );
        let run_id =
            RunId::new(format!("run.{digest}")).map_err(|_| vec![issue("run_request_invalid")])?;
        let tasks = graph
            .order()
            .iter()
            .map(|node_id| {
                let task_digest = format!("{:x}", Sha256::digest(format!("{run_id}:{node_id}")));
                Ok(ActionTask {
                    task_id: TaskId::new(format!("task.{task_digest}"))
                        .map_err(|_| issue("run_request_invalid"))?,
                    dispatch_id: DispatchId::new(format!("dispatch.{task_digest}"))
                        .map_err(|_| issue("run_request_invalid"))?,
                    node_id: node_id.clone(),
                    action: graph
                        .node(node_id)
                        .ok_or_else(|| issue("node_missing"))?
                        .action
                        .clone(),
                    state: ActionState::Pending,
                })
            })
            .collect::<Result<Vec<_>, GraphIssue>>()
            .map_err(|issue| vec![issue])?;
        Ok(Self {
            graph,
            run: WorkflowRun {
                schema_version: 1,
                run_id,
                workflow_id: version.workflow_id.clone(),
                workflow_version: version.version,
                source_digest: version.digest.clone(),
                revision: 1,
                trigger,
                tasks,
                created_at_ms: now,
                updated_at_ms: now,
            },
        })
    }

    pub fn restore(
        version: &WorkflowVersion,
        contracts: &[ActionContract],
        run: WorkflowRun,
    ) -> Result<Self, Vec<GraphIssue>> {
        let graph = CompiledWorkflow::parse(version.definition.clone(), contracts)?;
        if run.schema_version != 1
            || run.workflow_id != version.workflow_id
            || run.workflow_version != version.version
            || run.source_digest != version.digest
            || run.revision == 0
            || run.revision >= i64::MAX as u64
            || run.created_at_ms < 0
            || run.updated_at_ms < run.created_at_ms
            || run.tasks.len() != graph.order().len()
        {
            return Err(vec![issue("run_snapshot_invalid")]);
        }
        let mut started = 0;
        let mut unfinished = false;
        let mut outputs = BTreeMap::new();
        for (node_id, task) in graph.order().iter().zip(&run.tasks) {
            if task.node_id != *node_id
                || graph
                    .node(node_id)
                    .is_none_or(|node| node.action != task.action)
            {
                return Err(vec![issue("run_snapshot_invalid")]);
            }
            if unfinished && !matches!(task.state, ActionState::Pending) {
                return Err(vec![issue("run_snapshot_invalid")]);
            }
            unfinished = !matches!(task.state, ActionState::Completed { .. });
            let digest = format!("{:x}", Sha256::digest(format!("{}:{node_id}", run.run_id)));
            if task.task_id.as_str() != format!("task.{digest}")
                || task.dispatch_id.as_str() != format!("dispatch.{digest}")
            {
                return Err(vec![issue("run_snapshot_invalid")]);
            }
            match &task.state {
                ActionState::Pending => {}
                ActionState::Started { inputs, .. } => {
                    started += 1;
                    if graph.resolve_inputs(node_id, &outputs).as_ref() != Ok(inputs) {
                        return Err(vec![issue("run_inputs_invalid")]);
                    }
                }
                ActionState::Completed {
                    inputs,
                    outputs: values,
                    ..
                } => {
                    if graph.resolve_inputs(node_id, &outputs).as_ref() != Ok(inputs) {
                        return Err(vec![issue("run_inputs_invalid")]);
                    }
                    graph
                        .validate_outputs(node_id, values)
                        .map_err(|issue| vec![issue])?;
                    outputs.insert(node_id.clone(), values.clone());
                }
                ActionState::Failed {
                    inputs,
                    outputs: values,
                    ..
                } => {
                    if graph.resolve_inputs(node_id, &outputs).as_ref() != Ok(inputs) {
                        return Err(vec![issue("run_inputs_invalid")]);
                    }
                    if let Some(outputs) = values {
                        graph
                            .validate_outputs(node_id, outputs)
                            .map_err(|issue| vec![issue])?;
                    }
                }
            }
        }
        if started > 1 {
            return Err(vec![issue("run_snapshot_invalid")]);
        }
        Ok(Self { graph, run })
    }

    pub fn run(&self) -> &WorkflowRun {
        &self.run
    }
    pub fn into_run(self) -> WorkflowRun {
        self.run
    }

    pub fn start_next(&mut self, owner: &str, now: i64) -> Result<Option<&ActionTask>, GraphIssue> {
        self.check_transition(now)?;
        if owner.is_empty() || owner.len() > 256 || now < self.run.created_at_ms {
            return Err(issue("run_request_invalid"));
        }
        if !matches!(self.run.status(), RunStatus::Pending | RunStatus::Running)
            || self
                .run
                .tasks
                .iter()
                .any(|task| matches!(task.state, ActionState::Started { .. }))
        {
            return Ok(None);
        }
        let Some(index) = self
            .run
            .tasks
            .iter()
            .position(|task| matches!(task.state, ActionState::Pending))
        else {
            return Ok(None);
        };
        let outputs = self
            .run
            .tasks
            .iter()
            .filter_map(|task| match &task.state {
                ActionState::Completed { outputs, .. } => {
                    Some((task.node_id.clone(), outputs.clone()))
                }
                _ => None,
            })
            .collect();
        let inputs = self
            .graph
            .resolve_inputs(&self.run.tasks[index].node_id, &outputs)?;
        self.run.tasks[index].state = ActionState::Started {
            owner: owner.into(),
            inputs,
            started_at_ms: now,
            effect_ref: None,
        };
        self.touch(now);
        Ok(Some(&self.run.tasks[index]))
    }

    pub fn bind_effect(
        &mut self,
        dispatch: &DispatchId,
        effect: &str,
        now: i64,
    ) -> Result<(), GraphIssue> {
        self.check_transition(now)?;
        if effect.is_empty() || effect.len() > 256 || effect.chars().any(char::is_control) {
            return Err(issue("effect_reference_invalid"));
        }
        let task = self
            .run
            .tasks
            .iter_mut()
            .find(|task| &task.dispatch_id == dispatch)
            .ok_or_else(|| issue("dispatch_missing"))?;
        let ActionState::Started { effect_ref, .. } = &mut task.state else {
            return Err(issue("dispatch_not_started"));
        };
        if effect_ref
            .as_deref()
            .is_some_and(|current| current != effect)
        {
            return Err(issue("effect_reference_conflict"));
        }
        if effect_ref.as_deref() == Some(effect) {
            return Ok(());
        }
        *effect_ref = Some(effect.into());
        self.touch(now);
        Ok(())
    }

    pub fn complete(
        &mut self,
        dispatch: &DispatchId,
        outputs: ActionValues,
        now: i64,
    ) -> Result<(), GraphIssue> {
        self.check_transition(now)?;
        let task = self
            .run
            .tasks
            .iter_mut()
            .find(|task| &task.dispatch_id == dispatch)
            .ok_or_else(|| issue("dispatch_missing"))?;
        self.graph.validate_outputs(&task.node_id, &outputs)?;
        let ActionState::Started {
            inputs, effect_ref, ..
        } = &task.state
        else {
            return Err(issue("dispatch_not_started"));
        };
        task.state = ActionState::Completed {
            inputs: inputs.clone(),
            outputs,
            completed_at_ms: now,
            effect_ref: effect_ref.clone(),
        };
        self.touch(now);
        Ok(())
    }

    pub fn fail(
        &mut self,
        dispatch: &DispatchId,
        code: &str,
        uncertain: bool,
        outputs: Option<ActionValues>,
        now: i64,
    ) -> Result<(), GraphIssue> {
        self.check_transition(now)?;
        if !super::model::valid_id(code) {
            return Err(issue("action_error_invalid"));
        }
        let task = self
            .run
            .tasks
            .iter_mut()
            .find(|task| &task.dispatch_id == dispatch)
            .ok_or_else(|| issue("dispatch_missing"))?;
        if let Some(outputs) = &outputs {
            self.graph.validate_outputs(&task.node_id, outputs)?;
        }
        let ActionState::Started {
            inputs, effect_ref, ..
        } = &task.state
        else {
            return Err(issue("dispatch_not_started"));
        };
        task.state = ActionState::Failed {
            inputs: inputs.clone(),
            outputs,
            code: code.into(),
            uncertain,
            completed_at_ms: now,
            effect_ref: effect_ref.clone(),
        };
        self.touch(now);
        Ok(())
    }

    fn check_transition(&self, now: i64) -> Result<(), GraphIssue> {
        if now < self.run.created_at_ms || self.run.revision >= i64::MAX as u64 - 1 {
            return Err(issue("run_request_invalid"));
        }
        Ok(())
    }

    fn touch(&mut self, now: i64) {
        self.run.revision += 1;
        self.run.updated_at_ms = self.run.updated_at_ms.max(now);
    }
}

impl WorkflowRun {
    pub fn summary(&self) -> WorkflowRunSummary {
        WorkflowRunSummary {
            schema_version: 1,
            run_id: self.run_id.clone(),
            workflow_id: self.workflow_id.clone(),
            workflow_version: self.workflow_version,
            source_digest: self.source_digest.clone(),
            status: self.status(),
            trigger: self.trigger.clone(),
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
        }
    }

    pub fn status(&self) -> RunStatus {
        if self.tasks.iter().any(|task| {
            matches!(
                task.state,
                ActionState::Failed {
                    uncertain: true,
                    ..
                }
            )
        }) {
            return RunStatus::Uncertain;
        }
        if self
            .tasks
            .iter()
            .any(|task| matches!(task.state, ActionState::Failed { .. }))
        {
            return RunStatus::Failed;
        }
        if self
            .tasks
            .iter()
            .all(|task| matches!(task.state, ActionState::Completed { .. }))
        {
            return RunStatus::Completed;
        }
        if self
            .tasks
            .iter()
            .all(|task| matches!(task.state, ActionState::Pending))
        {
            return RunStatus::Pending;
        }
        RunStatus::Running
    }
}

fn issue(code: &str) -> GraphIssue {
    GraphIssue::new(code, None, None)
}
