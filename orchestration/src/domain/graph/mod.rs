//! Versioned workflow definitions and typed data dependencies.
//!
//! Action adapters supply their contracts. The graph never interprets provider,
//! process, workspace, or canvas state.

mod compile;
mod execution;
mod lifecycle;
mod model;
mod records;

pub use compile::CompiledWorkflow;
pub use execution::{
    ActionState, ActionStateSummary, ActionTask, ActionTaskSummary, ActionValues,
    ExecutingWorkflow, RunStatus, RunTrigger, WorkflowRun, WorkflowRunSummary,
};
pub use model::{
    ActionContract, ActionRef, FieldContract, FieldType, GraphIssue, InputBinding,
    WorkflowDefinition, WorkflowEdge, WorkflowNode,
};
pub use records::{
    WorkflowChangeRequest, WorkflowPutRequest, WorkflowRecord, WorkflowSummary, WorkflowTrigger,
    WorkflowVersion,
};

#[cfg(test)]
mod tests;
