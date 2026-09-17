use std::collections::HashMap;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::REQUEST_TIMEOUT;

const MAX_COMPLETED_REPLAYABLE_REQUESTS: usize = 256;
const DECISION_TIMEOUT_MS: u32 = 30_000;

struct RequestSubscribers {
    identity: Option<Value>,
    senders: Vec<mpsc::SyncSender<Value>>,
}

struct DecisionRequest {
    subscribers: RequestSubscribers,
    deadline: Instant,
}

enum PendingRequest {
    Pending(RequestSubscribers),
    DecisionEligible(DecisionRequest),
    AwaitingDecision(DecisionRequest),
    Claimed {
        subscribers: RequestSubscribers,
        decision_claimed_at: Option<Instant>,
    },
}

impl PendingRequest {
    fn subscribers(&self) -> &RequestSubscribers {
        match self {
            Self::Pending(subscribers) | Self::Claimed { subscribers, .. } => subscribers,
            Self::DecisionEligible(request) | Self::AwaitingDecision(request) => {
                &request.subscribers
            }
        }
    }

    fn subscribers_mut(&mut self) -> &mut RequestSubscribers {
        match self {
            Self::Pending(subscribers) | Self::Claimed { subscribers, .. } => subscribers,
            Self::DecisionEligible(request) | Self::AwaitingDecision(request) => {
                &mut request.subscribers
            }
        }
    }
}

pub(super) enum RequestWait {
    Unclaimed,
    DecisionExpired,
    Pending(Duration),
    Claimed(Option<Duration>),
}

struct CompletedRequest {
    identity: Value,
    result: Value,
    order: u64,
}

#[derive(Default)]
struct CliRequestBrokerState {
    pending: HashMap<String, PendingRequest>,
    completed: HashMap<String, CompletedRequest>,
    completion_order: u64,
}

pub(super) struct CliRequestRegistration {
    pub(super) receiver: mpsc::Receiver<Value>,
    pub(super) dispatch: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum CliRequestRegistrationError {
    IdentityConflict,
    BrokerUnavailable(&'static str),
}

impl std::fmt::Display for CliRequestRegistrationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IdentityConflict => {
                formatter.write_str("CLI request idempotency identity conflict")
            }
            Self::BrokerUnavailable(message) => formatter.write_str(message),
        }
    }
}

#[derive(Default)]
pub struct CliRequestBroker {
    state: Mutex<CliRequestBrokerState>,
}

impl CliRequestBroker {
    pub(super) fn register(
        &self,
        request_id: String,
    ) -> Result<mpsc::Receiver<Value>, CliRequestRegistrationError> {
        self.register_with_identity(request_id, None)
            .map(|registration| registration.receiver)
    }

    pub(super) fn register_with_identity(
        &self,
        request_id: String,
        identity: Option<Value>,
    ) -> Result<CliRequestRegistration, CliRequestRegistrationError> {
        self.register_pending(request_id, identity, false)
    }

    pub(super) fn register_remote_shell(
        &self,
        request_id: String,
    ) -> Result<CliRequestRegistration, CliRequestRegistrationError> {
        self.register_pending(request_id, None, true)
    }

    fn register_pending(
        &self,
        request_id: String,
        identity: Option<Value>,
        decision_eligible: bool,
    ) -> Result<CliRequestRegistration, CliRequestRegistrationError> {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut state = self.state.lock().map_err(|_| {
            CliRequestRegistrationError::BrokerUnavailable("CLI request broker lock poisoned")
        })?;
        if let Some(completed) = state.completed.get(&request_id) {
            if identity.as_ref() != Some(&completed.identity) {
                return Err(CliRequestRegistrationError::IdentityConflict);
            }
            sender.send(completed.result.clone()).map_err(|_| {
                CliRequestRegistrationError::BrokerUnavailable("CLI request receiver closed")
            })?;
            return Ok(CliRequestRegistration {
                receiver,
                dispatch: false,
            });
        }
        if let Some(pending) = state.pending.get_mut(&request_id) {
            if identity.is_none() || pending.subscribers().identity != identity {
                return Err(CliRequestRegistrationError::IdentityConflict);
            }
            pending.subscribers_mut().senders.push(sender);
            return Ok(CliRequestRegistration {
                receiver,
                dispatch: false,
            });
        }
        let subscribers = RequestSubscribers {
            identity,
            senders: vec![sender],
        };
        let pending = if decision_eligible {
            PendingRequest::DecisionEligible(DecisionRequest {
                subscribers,
                deadline: Instant::now() + REQUEST_TIMEOUT,
            })
        } else {
            PendingRequest::Pending(subscribers)
        };
        state.pending.insert(request_id, pending);
        Ok(CliRequestRegistration {
            receiver,
            dispatch: true,
        })
    }

    pub(super) fn complete(&self, request_id: &str, result: Value) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "CLI request broker lock poisoned".to_string())?;
        match state.pending.get(request_id) {
            Some(
                PendingRequest::Pending(_)
                | PendingRequest::DecisionEligible(_)
                | PendingRequest::AwaitingDecision(_),
            ) => return Err("CLI request must be claimed before completion".into()),
            Some(PendingRequest::Claimed { .. }) => {}
            None => return Err("CLI request is no longer pending".into()),
        }
        let subscribers = match state.pending.remove(request_id) {
            Some(PendingRequest::Claimed { subscribers, .. }) => subscribers,
            _ => unreachable!("claimed request was checked under the same lock"),
        };
        let replayable = subscribers.identity.is_some();
        if let Some(identity) = subscribers.identity {
            state.completion_order = state.completion_order.saturating_add(1);
            let order = state.completion_order;
            state.completed.insert(
                request_id.to_string(),
                CompletedRequest {
                    identity,
                    result: result.clone(),
                    order,
                },
            );
            if state.completed.len() > MAX_COMPLETED_REPLAYABLE_REQUESTS {
                if let Some(oldest) = state
                    .completed
                    .iter()
                    .min_by_key(|(_, completed)| completed.order)
                    .map(|(request_id, _)| request_id.clone())
                {
                    state.completed.remove(&oldest);
                }
            }
        }
        drop(state);
        let mut delivered = false;
        for sender in subscribers.senders {
            delivered |= sender.send(result.clone()).is_ok();
        }
        if delivered || replayable {
            Ok(())
        } else {
            Err("CLI request receiver closed".to_string())
        }
    }

    pub(super) fn claim(&self, request_id: &str) -> Result<bool, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "CLI request broker lock poisoned".to_string())?;
        let Some(request) = state.pending.remove(request_id) else {
            return Ok(false);
        };
        let now = Instant::now();
        let (next, claimed) = match request {
            PendingRequest::Pending(subscribers) => (
                PendingRequest::Claimed {
                    subscribers,
                    decision_claimed_at: None,
                },
                true,
            ),
            PendingRequest::DecisionEligible(request) if now < request.deadline => (
                PendingRequest::Claimed {
                    subscribers: request.subscribers,
                    decision_claimed_at: None,
                },
                true,
            ),
            PendingRequest::AwaitingDecision(request) if now < request.deadline => (
                PendingRequest::Claimed {
                    subscribers: request.subscribers,
                    decision_claimed_at: Some(now),
                },
                true,
            ),
            other => (other, false),
        };
        state.pending.insert(request_id.to_string(), next);
        Ok(claimed)
    }

    /// Begin the human phase once, without granting execution authority.
    pub(super) fn begin_decision(&self, request_id: &str) -> Result<Option<u32>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "CLI request broker lock poisoned".to_string())?;
        let Some(request) = state.pending.remove(request_id) else {
            return Ok(None);
        };
        let now = Instant::now();
        let (next, duration) = match request {
            PendingRequest::DecisionEligible(mut request) if now < request.deadline => {
                request.deadline = now + Duration::from_millis(u64::from(DECISION_TIMEOUT_MS));
                (
                    PendingRequest::AwaitingDecision(request),
                    Some(DECISION_TIMEOUT_MS),
                )
            }
            other => (other, None),
        };
        state.pending.insert(request_id.to_string(), next);
        Ok(duration)
    }

    /// Classify and expire under the same lock as acceptance. A late answer
    /// cannot race timeout retirement into a new remote creation.
    pub(super) fn after_timeout(&self, request_id: &str) -> Result<RequestWait, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "CLI request broker lock poisoned".to_string())?;
        let now = Instant::now();
        let next = match state.pending.get(request_id) {
            Some(PendingRequest::Pending(_)) => RequestWait::Unclaimed,
            Some(PendingRequest::DecisionEligible(request)) => {
                if now < request.deadline {
                    RequestWait::Pending(request.deadline - now)
                } else {
                    RequestWait::Unclaimed
                }
            }
            Some(PendingRequest::AwaitingDecision(request)) => {
                if now < request.deadline {
                    RequestWait::Pending(request.deadline - now)
                } else {
                    RequestWait::DecisionExpired
                }
            }
            Some(PendingRequest::Claimed {
                decision_claimed_at,
                ..
            }) => RequestWait::Claimed(
                decision_claimed_at.map(|at| now.saturating_duration_since(at)),
            ),
            // Completion removes the record before sending the correlated result.
            None => RequestWait::Claimed(None),
        };
        if matches!(next, RequestWait::Unclaimed | RequestWait::DecisionExpired) {
            state.pending.remove(request_id);
        }
        Ok(next)
    }

    pub(super) fn cancel(&self, request_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.pending.remove(request_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn expire_decision(broker: &CliRequestBroker, id: &str) {
        let mut state = broker.state.lock().unwrap();
        let Some(PendingRequest::AwaitingDecision(request)) = state.pending.get_mut(id) else {
            panic!("expected an unanswered decision");
        };
        request.deadline = Instant::now();
    }

    #[test]
    fn human_wait_does_not_claim_execution_or_extend_on_duplicate_delivery() {
        let broker = CliRequestBroker::default();
        let _request = broker.register_remote_shell("ssh".into()).unwrap();
        assert_eq!(
            broker.begin_decision("ssh").unwrap(),
            Some(DECISION_TIMEOUT_MS)
        );
        let deadline = match broker.state.lock().unwrap().pending.get("ssh").unwrap() {
            PendingRequest::AwaitingDecision(request) => request.deadline,
            _ => panic!("expected decision"),
        };
        assert_eq!(broker.begin_decision("ssh").unwrap(), None);
        assert!(broker.complete("ssh", json!({"ok":true})).is_err());
        assert!(matches!(
            broker.after_timeout("ssh").unwrap(),
            RequestWait::Pending(_)
        ));
        match broker.state.lock().unwrap().pending.get("ssh").unwrap() {
            PendingRequest::AwaitingDecision(request) => assert_eq!(request.deadline, deadline),
            _ => panic!("duplicate delivery changed phase"),
        };
    }

    #[test]
    fn expired_answer_is_rejected_even_before_the_waiter_observes_timeout() {
        let broker = CliRequestBroker::default();
        let request = broker.register_remote_shell("ssh".into()).unwrap();
        broker.begin_decision("ssh").unwrap();
        expire_decision(&broker, "ssh");
        assert!(!broker.claim("ssh").unwrap());
        assert!(broker.complete("ssh", json!({"ok":true})).is_err());
        assert!(matches!(
            broker.after_timeout("ssh").unwrap(),
            RequestWait::DecisionExpired
        ));
        assert!(!broker.claim("ssh").unwrap());
        assert_eq!(broker.begin_decision("ssh").unwrap(), None);
        assert!(request.receiver.recv().is_err());
    }

    #[test]
    fn accepted_decision_claims_once_and_completes_exactly_once() {
        let broker = CliRequestBroker::default();
        let request = broker.register_remote_shell("ssh".into()).unwrap();
        broker.begin_decision("ssh").unwrap();
        assert!(broker.claim("ssh").unwrap());
        assert!(!broker.claim("ssh").unwrap());
        assert!(matches!(
            broker.after_timeout("ssh").unwrap(),
            RequestWait::Claimed(Some(_))
        ));
        let result = json!({"ok":true, "pane":{"panelId":"source"}});
        broker.complete("ssh", result.clone()).unwrap();
        assert_eq!(request.receiver.recv().unwrap(), result);
        assert!(broker.complete("ssh", json!({"ok":true})).is_err());
    }

    #[test]
    fn decline_completes_fallback_without_a_second_claim_or_decision() {
        let broker = CliRequestBroker::default();
        let request = broker.register_remote_shell("ssh".into()).unwrap();
        broker.begin_decision("ssh").unwrap();
        assert!(broker.claim("ssh").unwrap());
        let fallback = json!({"ok":false,"fallback":true});
        broker.complete("ssh", fallback.clone()).unwrap();
        assert_eq!(request.receiver.recv().unwrap(), fallback);
        assert_eq!(broker.begin_decision("ssh").unwrap(), None);
        assert!(!broker.claim("ssh").unwrap());
    }

    #[test]
    fn saved_host_and_ordinary_request_admission_stay_independent_of_decisions() {
        let broker = CliRequestBroker::default();
        let _decision = broker.register_remote_shell("decision".into()).unwrap();
        broker.begin_decision("decision").unwrap();
        let ordinary = broker.register("ordinary".into()).unwrap();
        assert_eq!(broker.begin_decision("ordinary").unwrap(), None);
        assert!(broker.claim("ordinary").unwrap());
        broker.complete("ordinary", json!({"ok":true})).unwrap();
        assert_eq!(ordinary.recv().unwrap()["ok"], true);
        let saved = broker.register_remote_shell("saved".into()).unwrap();
        assert!(broker.claim("saved").unwrap());
        assert!(matches!(
            broker.after_timeout("saved").unwrap(),
            RequestWait::Claimed(None)
        ));
        broker.complete("saved", json!({"ok":true})).unwrap();
        assert_eq!(saved.receiver.recv().unwrap()["ok"], true);
        assert!(matches!(
            broker.after_timeout("decision").unwrap(),
            RequestWait::Pending(_)
        ));
    }

    #[test]
    fn expired_initial_delivery_cannot_start_a_human_phase() {
        let broker = CliRequestBroker::default();
        let _request = broker.register_remote_shell("ssh".into()).unwrap();
        if let Some(PendingRequest::DecisionEligible(request)) =
            broker.state.lock().unwrap().pending.get_mut("ssh")
        {
            request.deadline = Instant::now();
        }
        assert_eq!(broker.begin_decision("ssh").unwrap(), None);
        assert!(!broker.claim("ssh").unwrap());
        assert!(matches!(
            broker.after_timeout("ssh").unwrap(),
            RequestWait::Unclaimed
        ));
    }
}
