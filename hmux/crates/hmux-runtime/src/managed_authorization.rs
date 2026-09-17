use std::collections::VecDeque;
use std::time::{Duration, Instant};
use uuid::Uuid;

struct ManagedAuthorizationGrant {
    proof: String,
    expires_at: Instant,
}

pub(crate) struct ManagedAuthorizationGrants {
    grants: VecDeque<ManagedAuthorizationGrant>,
    ttl: Duration,
    capacity: usize,
}

impl ManagedAuthorizationGrants {
    pub(crate) fn new(ttl: Duration, capacity: usize) -> Self {
        Self {
            grants: VecDeque::new(),
            ttl,
            capacity,
        }
    }

    pub(crate) fn issue(&mut self, now: Instant) -> Option<String> {
        self.discard_expired(now);
        if self.grants.len() >= self.capacity {
            return None;
        }
        let proof = format!("managed_grant_{}", Uuid::new_v4().simple());
        self.grants.push_back(ManagedAuthorizationGrant {
            proof: proof.clone(),
            expires_at: now + self.ttl,
        });
        Some(proof)
    }

    pub(crate) fn consume(&mut self, proof: Option<&str>, now: Instant) -> bool {
        self.discard_expired(now);
        let Some(proof) = proof else {
            return false;
        };
        let Some(position) = self.grants.iter().position(|grant| grant.proof == proof) else {
            return false;
        };
        self.grants.remove(position);
        true
    }

    pub(crate) fn authorize(
        &mut self,
        proof: Option<&str>,
        now: Instant,
        scoped_grant_required: bool,
        legacy_proof: &str,
    ) -> bool {
        if scoped_grant_required {
            self.consume(proof, now)
        } else {
            proof == Some(legacy_proof)
        }
    }

    fn discard_expired(&mut self, now: Instant) {
        self.grants.retain(|grant| grant.expires_at > now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grants_are_single_use_bounded_and_expire() {
        let now = Instant::now();
        let mut grants = ManagedAuthorizationGrants::new(Duration::from_secs(2), 2);
        let first = grants.issue(now).unwrap();
        let second = grants.issue(now).unwrap();
        assert!(grants.issue(now).is_none());

        assert!(grants.consume(Some(&first), now));
        assert!(!grants.consume(Some(&first), now));
        assert!(grants.issue(now).is_some());
        assert!(!grants.consume(Some(&second), now + Duration::from_secs(2)));
        assert!(grants.issue(now + Duration::from_secs(2)).is_some());
    }

    #[test]
    fn current_clients_require_grants_while_v1_clients_keep_the_legacy_proof() {
        let now = Instant::now();
        let mut grants = ManagedAuthorizationGrants::new(Duration::from_secs(2), 2);
        let grant = grants.issue(now).unwrap();

        assert!(!grants.authorize(Some("legacy-token"), now, true, "legacy-token"));
        assert!(grants.authorize(Some(&grant), now, true, "legacy-token"));
        assert!(grants.authorize(Some("legacy-token"), now, false, "legacy-token"));
        assert!(!grants.authorize(Some("wrong-token"), now, false, "legacy-token"));
    }
}
