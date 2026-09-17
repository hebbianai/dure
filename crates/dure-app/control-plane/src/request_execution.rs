use std::future::Future;
use std::time::Duration;

use tokio::sync::OwnedSemaphorePermit;
use tokio::time::timeout;

use crate::agent_conversation_api;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ResponseDeadlineAction {
    CancelOperation,
    FinishJournaledOperation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct RequestExecutionPolicy {
    response_deadline: Duration,
    action: ResponseDeadlineAction,
}

#[derive(Debug)]
pub(super) enum RequestExecutionOutcome<T> {
    Completed(T),
    ResponseDeadlineExceeded,
    WorkerFailed,
}

pub(super) fn policy_for(
    operation: &str,
    request_deadline: Duration,
    workflow_deadline: Duration,
) -> RequestExecutionPolicy {
    match operation {
        "dispatch.stop.preview" | agent_conversation_api::INTERRUPT_TURN_OPERATION => {
            RequestExecutionPolicy {
                response_deadline: workflow_deadline,
                action: ResponseDeadlineAction::CancelOperation,
            }
        }
        "workflow.delegate_once"
        | "browser.resource"
        | "dispatch.stop.apply"
        | "agent_spawn.apply"
        | "agent_runtime.native_rehost.reconcile"
        | "agent_runtime.native_resume.publish"
        | "agent_runtime.transition"
        | "agent_runtime.hibernate"
        | "agent_runtime.wake"
        | "agent_runtime.repair"
        | "agent_runtime.stop"
        | "agent_runtime.remove"
        | agent_conversation_api::RECOVER_OPERATION
        | agent_conversation_api::START_TURN_OPERATION
        | agent_conversation_api::STEER_TURN_OPERATION
        | agent_conversation_api::ANSWER_PENDING_OPERATION
        | "claude_conversation.open"
        | "claude_conversation.launch"
        | "claude_conversation.stop" => RequestExecutionPolicy {
            response_deadline: workflow_deadline,
            action: ResponseDeadlineAction::FinishJournaledOperation,
        },
        _ => RequestExecutionPolicy {
            response_deadline: request_deadline,
            action: ResponseDeadlineAction::CancelOperation,
        },
    }
}

pub(super) async fn execute<F, T>(
    policy: RequestExecutionPolicy,
    permit: OwnedSemaphorePermit,
    operation: F,
) -> RequestExecutionOutcome<T>
where
    F: Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    match policy.action {
        ResponseDeadlineAction::CancelOperation => {
            let result = timeout(policy.response_deadline, operation).await;
            drop(permit);
            match result {
                Ok(result) => RequestExecutionOutcome::Completed(result),
                Err(_) => RequestExecutionOutcome::ResponseDeadlineExceeded,
            }
        }
        ResponseDeadlineAction::FinishJournaledOperation => {
            let worker = tokio::spawn(async move {
                let result = operation.await;
                drop(permit);
                result
            });
            match timeout(policy.response_deadline, worker).await {
                Ok(Ok(result)) => RequestExecutionOutcome::Completed(result),
                Ok(Err(_)) => RequestExecutionOutcome::WorkerFailed,
                Err(_) => RequestExecutionOutcome::ResponseDeadlineExceeded,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::sync::{Semaphore, oneshot};

    use super::*;

    #[test]
    fn conversation_mutations_use_the_workflow_response_deadline() {
        for operation in [
            agent_conversation_api::RECOVER_OPERATION,
            agent_conversation_api::START_TURN_OPERATION,
            agent_conversation_api::STEER_TURN_OPERATION,
            agent_conversation_api::ANSWER_PENDING_OPERATION,
            agent_conversation_api::INTERRUPT_TURN_OPERATION,
        ] {
            assert_eq!(
                policy_for(operation, Duration::from_secs(20), Duration::from_secs(180))
                    .response_deadline,
                Duration::from_secs(180),
            );
        }
        assert_eq!(
            policy_for(
                agent_conversation_api::READ_OPERATION,
                Duration::from_secs(20),
                Duration::from_secs(180),
            )
            .response_deadline,
            Duration::from_secs(20),
        );
    }

    #[test]
    fn dispatch_stop_separates_preview_from_journaled_apply() {
        let preview = policy_for(
            "dispatch.stop.preview",
            Duration::from_secs(20),
            Duration::from_secs(180),
        );
        assert_eq!(preview.response_deadline, Duration::from_secs(180));
        assert_eq!(preview.action, ResponseDeadlineAction::CancelOperation);

        let apply = policy_for(
            "dispatch.stop.apply",
            Duration::from_secs(20),
            Duration::from_secs(180),
        );
        assert_eq!(apply.response_deadline, Duration::from_secs(180));
        assert_eq!(
            apply.action,
            ResponseDeadlineAction::FinishJournaledOperation,
        );
    }

    #[test]
    fn journaled_effect_operations_finish_after_the_response_deadline() {
        for operation in [
            "workflow.delegate_once",
            "browser.resource",
            "dispatch.stop.apply",
            "agent_spawn.apply",
            "agent_runtime.native_rehost.reconcile",
            "agent_runtime.native_resume.publish",
            "agent_runtime.transition",
            "agent_runtime.hibernate",
            "agent_runtime.wake",
            "agent_runtime.repair",
            "agent_runtime.stop",
            "agent_runtime.remove",
            agent_conversation_api::RECOVER_OPERATION,
            agent_conversation_api::START_TURN_OPERATION,
            agent_conversation_api::STEER_TURN_OPERATION,
            agent_conversation_api::ANSWER_PENDING_OPERATION,
            "claude_conversation.open",
            "claude_conversation.launch",
            "claude_conversation.stop",
        ] {
            assert_eq!(
                policy_for(operation, Duration::from_secs(20), Duration::from_secs(180)),
                RequestExecutionPolicy {
                    response_deadline: Duration::from_secs(180),
                    action: ResponseDeadlineAction::FinishJournaledOperation,
                },
                "{operation}",
            );
        }
        assert_eq!(
            policy_for(
                agent_conversation_api::INTERRUPT_TURN_OPERATION,
                Duration::from_secs(20),
                Duration::from_secs(180),
            )
            .action,
            ResponseDeadlineAction::CancelOperation,
        );
    }

    #[tokio::test]
    async fn finish_after_response_deadline_keeps_operation_and_capacity_alive() {
        let slots = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&slots).try_acquire_owned().unwrap();
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let (finished_tx, finished_rx) = oneshot::channel();
        let policy = RequestExecutionPolicy {
            response_deadline: Duration::from_millis(10),
            action: ResponseDeadlineAction::FinishJournaledOperation,
        };

        let response = tokio::spawn(execute(policy, permit, async move {
            started_tx.send(()).unwrap();
            release_rx.await.unwrap();
            finished_tx.send(()).unwrap();
        }));
        started_rx.await.unwrap();

        assert!(matches!(
            response.await.unwrap(),
            RequestExecutionOutcome::ResponseDeadlineExceeded,
        ));
        assert_eq!(
            slots.available_permits(),
            0,
            "the admitted operation must retain capacity until it completes",
        );

        release_tx.send(()).unwrap();
        timeout(Duration::from_secs(1), finished_rx)
            .await
            .expect("detached operation did not finish")
            .unwrap();
        let returned = timeout(Duration::from_secs(1), slots.acquire())
            .await
            .expect("detached operation did not return capacity")
            .unwrap();
        drop(returned);
        assert_eq!(slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn dropping_the_response_waiter_does_not_cancel_journaled_work() {
        let slots = Arc::new(Semaphore::new(1));
        let permit = Arc::clone(&slots).try_acquire_owned().unwrap();
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let (finished_tx, finished_rx) = oneshot::channel();
        let policy = RequestExecutionPolicy {
            response_deadline: Duration::from_secs(60),
            action: ResponseDeadlineAction::FinishJournaledOperation,
        };
        let response = tokio::spawn(execute(policy, permit, async move {
            started_tx.send(()).unwrap();
            release_rx.await.unwrap();
            finished_tx.send(()).unwrap();
        }));
        started_rx.await.unwrap();

        response.abort();
        assert!(response.await.unwrap_err().is_cancelled());
        assert_eq!(slots.available_permits(), 0);

        release_tx.send(()).unwrap();
        timeout(Duration::from_secs(1), finished_rx)
            .await
            .expect("operation was tied to the response waiter")
            .unwrap();
        let returned = timeout(Duration::from_secs(1), slots.acquire())
            .await
            .expect("detached operation did not return capacity")
            .unwrap();
        drop(returned);
    }
}
