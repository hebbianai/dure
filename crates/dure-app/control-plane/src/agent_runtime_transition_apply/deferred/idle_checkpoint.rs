//! Legacy observer continuity, not durable session facts or stop authority.
//! Only already measured credit survives; every restored source is inspected again.
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{HibernateBodyV1, idle_policy, idle_window::IdleWindow};
use crate::{ControlPlaneError, ServiceState, assert_owner_directory, private_record};

const FILE_NAME: &str = "runtime-idle-observations-v1.json";
const MAXIMUM_WINDOWS: usize = 1024;
const MAXIMUM_BYTES: u64 = 512 * 1024;
pub(super) const MAXIMUM_GAP: Duration = Duration::from_secs(300);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    source: String,
    measured_ms: u64,
    observed_at_tick_ms: u64,
}

impl Observation {
    fn fresh(&self, tick: u64) -> bool {
        tick.checked_sub(self.observed_at_tick_ms)
            .is_some_and(|gap| gap <= MAXIMUM_GAP.as_millis() as u64)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema_version: u16,
    boot: String,
    policy_revision: u64,
    after_ms: u64,
    observations: BTreeMap<String, Observation>,
}

impl Record {
    fn restore(
        self,
        boot: &str,
        revision: u64,
        after_ms: u64,
        tick: u64,
    ) -> Result<BTreeMap<String, Observation>, String> {
        if self.schema_version != 1
            || self.observations.len() > MAXIMUM_WINDOWS
            || self.observations.iter().any(|(id, observation)| {
                id.len() > 256
                    || observation.source.len() > 256
                    || observation.measured_ms >= self.after_ms
            })
        {
            return Err("runtime_idle_checkpoint_invalid".into());
        }
        if self.boot != boot || self.policy_revision != revision || self.after_ms != after_ms {
            return Ok(BTreeMap::new());
        }
        let mut observations = self.observations;
        observations.retain(|_, observation| observation.fresh(tick));
        Ok(observations)
    }
}

pub(crate) struct Windows {
    boot: String,
    policy_revision: u64,
    after_ms: u64,
    pending: BTreeMap<String, Observation>,
    active: BTreeMap<String, IdleWindow<String, HibernateBodyV1>>,
}

impl Windows {
    pub(crate) fn load(state: &ServiceState, revision: u64, after_ms: u64) -> Result<Self, String> {
        let boot = boot_identity().map_err(|_| "runtime_idle_clock_unavailable")?;
        let root = state
            .canonical_descriptor_path
            .parent()
            .ok_or("runtime_idle_checkpoint_unavailable")?;
        assert_owner_directory(root).map_err(|_| "runtime_idle_checkpoint_unavailable")?;
        let bytes = private_record::read_bounded(&root.join(FILE_NAME), MAXIMUM_BYTES)
            .map_err(|_| "runtime_idle_checkpoint_unavailable")?;
        let mut pending = BTreeMap::new();
        if let Some(bytes) = bytes {
            let record: Record =
                serde_json::from_slice(&bytes).map_err(|_| "runtime_idle_checkpoint_invalid")?;
            let tick = monotonic_ms().map_err(|_| "runtime_idle_clock_unavailable")?;
            pending = record.restore(&boot, revision, after_ms, tick)?;
        }
        Ok(Self {
            boot,
            policy_revision: revision,
            after_ms,
            pending,
            active: BTreeMap::new(),
        })
    }

    pub(super) fn forget(&mut self, agent: &str) {
        self.pending.remove(agent);
        self.active.remove(agent);
    }

    pub(crate) fn disarm(&self, state: &ServiceState) -> Result<(), String> {
        // Consume the saved scan before observing again. A crash after an
        // unknown/new activity observation cannot resurrect its older credit.
        if self.pending.is_empty() && self.active.is_empty() {
            return Ok(());
        }
        self.write(state, BTreeMap::new())
    }

    pub(crate) fn observe(
        &mut self,
        agent: &str,
        source: String,
        body: HibernateBodyV1,
    ) -> Result<(Duration, bool, Option<HibernateBodyV1>), String> {
        let now = Instant::now();
        let tick = monotonic_ms().map_err(|_| "runtime_idle_clock_unavailable")?;
        self.active.retain(|_, window| window.is_recent(now));
        self.pending
            .retain(|_, observation| observation.fresh(tick));
        let mut restored = false;
        if let Some(previous) = self.pending.remove(agent)
            && previous.source == source
            && previous.fresh(tick)
            && let Some(window) = IdleWindow::restore(
                MAXIMUM_GAP,
                now,
                (source.clone(), body.clone()),
                Duration::from_millis(previous.measured_ms),
            )
        {
            self.active.insert(agent.to_owned(), window);
            restored = true;
        }
        if !self.active.contains_key(agent)
            && self.active.len() + self.pending.len() >= MAXIMUM_WINDOWS
        {
            return Err("runtime_idle_observer_capacity".into());
        }
        let window = self
            .active
            .entry(agent.to_owned())
            .or_insert_with(|| IdleWindow::new(MAXIMUM_GAP));
        let elapsed = window
            .observe(now, Some((source, body)))
            .unwrap_or_default();
        let ready = window
            .take_ready(now, Duration::from_millis(self.after_ms))
            .map(|(_, body)| body);
        Ok((elapsed, restored, ready))
    }

    pub(crate) fn save(&self, state: &ServiceState) -> Result<(), String> {
        if self.pending.is_empty() && self.active.is_empty() {
            return Ok(());
        }
        let tick = monotonic_ms().map_err(|_| "runtime_idle_clock_unavailable")?;
        let now = Instant::now();
        let mut observations = self.pending.clone();
        observations.retain(|_, observation| observation.fresh(tick));
        for (agent, window) in &self.active {
            if let Some((source, measured, gap)) = window.checkpoint(now) {
                let gap =
                    u64::try_from(gap.as_millis()).map_err(|_| "runtime_idle_clock_unavailable")?;
                observations.insert(
                    agent.clone(),
                    Observation {
                        source: source.clone(),
                        measured_ms: u64::try_from(measured.as_millis())
                            .map_err(|_| "runtime_idle_clock_unavailable")?,
                        observed_at_tick_ms: tick
                            .checked_sub(gap)
                            .ok_or("runtime_idle_clock_unavailable")?,
                    },
                );
            }
        }
        self.write(state, observations)
    }

    fn write(
        &self,
        state: &ServiceState,
        observations: BTreeMap<String, Observation>,
    ) -> Result<(), String> {
        let root = state
            .canonical_descriptor_path
            .parent()
            .ok_or("runtime_idle_checkpoint_unavailable")?;
        let record = Record {
            schema_version: 1,
            boot: self.boot.clone(),
            policy_revision: self.policy_revision,
            after_ms: self.after_ms,
            observations,
        };
        if serde_json::to_vec(&record)
            .map_err(|_| "runtime_idle_checkpoint_invalid")?
            .len() as u64
            > MAXIMUM_BYTES
        {
            return Err("runtime_idle_checkpoint_invalid".into());
        }
        crate::service_lifecycle::with_descriptor_transition(root, |_| {
            if !state.is_mutation_authority() {
                return Err(ControlPlaneError::Invalid(
                    "runtime_idle_authority_unavailable",
                ));
            }
            let policy = idle_policy::load(state, Ok(idle_policy::Policy::Disabled {}))?;
            if policy.revision != self.policy_revision
                || policy.policy.after_ms() != Some(self.after_ms)
            {
                return Err(ControlPlaneError::Invalid(
                    "runtime_idle_policy_revision_conflict",
                ));
            }
            private_record::write(&root.join(FILE_NAME), &record)
        })
        .map_err(|_| "runtime_idle_checkpoint_unavailable".into())
    }
}

fn monotonic_ms() -> std::io::Result<u64> {
    let mut value = std::mem::MaybeUninit::<libc::timespec>::uninit();
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, value.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let value = unsafe { value.assume_init() };
    let seconds = u64::try_from(value.tv_sec).map_err(std::io::Error::other)?;
    let nanos = u64::try_from(value.tv_nsec).map_err(std::io::Error::other)?;
    seconds
        .checked_mul(1000)
        .and_then(|ms| ms.checked_add(nanos / 1_000_000))
        .ok_or_else(|| std::io::Error::other("invalid monotonic observation"))
}

fn boot_identity() -> std::io::Result<String> {
    #[cfg(target_os = "macos")]
    let value = {
        let mut buffer = [0u8; 64];
        let mut size = buffer.len();
        if unsafe {
            libc::sysctlbyname(
                c"kern.bootsessionuuid".as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        String::from_utf8(
            buffer
                .get(..size)
                .ok_or_else(|| std::io::Error::other("invalid boot identity"))?
                .to_vec(),
        )
        .map_err(std::io::Error::other)?
    };
    #[cfg(target_os = "linux")]
    let value = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let value = String::new();
    let value = value.trim_matches(|ch: char| ch == '\0' || ch.is_ascii_whitespace());
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err(std::io::Error::other("invalid boot identity"));
    }
    Ok(value.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> Record {
        Record {
            schema_version: 1,
            boot: "boot-a".into(),
            policy_revision: 2,
            after_ms: 60_000,
            observations: BTreeMap::from([(
                "agent".into(),
                Observation {
                    source: "exact-source-and-activity".into(),
                    measured_ms: 15_000,
                    observed_at_tick_ms: 500_000,
                },
            )]),
        }
    }

    fn body() -> HibernateBodyV1 {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "agentId": "agent", "expectedSourceRevision": 1,
        }))
        .unwrap()
    }

    #[test]
    fn restart_retains_only_measured_credit_not_time_offline() {
        let retained: Record =
            serde_json::from_slice(&serde_json::to_vec(&record()).unwrap()).unwrap();
        let pending = retained.restore("boot-a", 2, 60_000, 520_000).unwrap();
        assert_eq!(pending["agent"].measured_ms, 15_000);
        let now = Instant::now();
        let mut window = IdleWindow::restore(
            MAXIMUM_GAP,
            now,
            ("source", body()),
            Duration::from_millis(pending["agent"].measured_ms),
        )
        .unwrap();
        assert_eq!(
            window.observe(now, Some(("source", body()))),
            Some(Duration::from_secs(15))
        );
        assert!(
            window.take_ready(now, Duration::from_secs(30)).is_none(),
            "twenty offline seconds cannot cross the policy threshold"
        );
        window.observe(now + Duration::from_secs(15), Some(("source", body())));
        assert!(
            window
                .take_ready(now + Duration::from_secs(15), Duration::from_secs(30))
                .is_some()
        );
        assert!(
            window.checkpoint(now + Duration::from_secs(15)).is_none(),
            "consumed intervals cannot be restored"
        );
    }

    #[test]
    fn changed_boot_policy_gap_or_clock_discards_retained_credit() {
        for (boot, policy, after, tick) in [
            ("boot-b", 2, 60_000, 500_001),
            ("boot-a", 3, 60_000, 500_001),
            ("boot-a", 2, 30_000, 500_001),
            ("boot-a", 2, 60_000, 800_001),
            ("boot-a", 2, 60_000, 499_999),
        ] {
            assert!(
                record()
                    .restore(boot, policy, after, tick)
                    .unwrap()
                    .is_empty()
            );
        }
        assert_eq!(
            record()
                .restore("boot-a", 2, 60_000, 800_000)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn restored_observation_still_requires_the_exact_source() {
        for source in [
            "exact-source-and-activity",
            "different-activity-or-generation",
        ] {
            let mut pending = record().observations;
            pending.get_mut("agent").unwrap().observed_at_tick_ms = monotonic_ms().unwrap();
            let mut windows = Windows {
                boot: boot_identity().unwrap(),
                policy_revision: 2,
                after_ms: 60_000,
                pending,
                active: BTreeMap::new(),
            };
            let (elapsed, restored, ready) =
                windows.observe("agent", source.into(), body()).unwrap();
            assert_eq!(restored, source == "exact-source-and-activity");
            assert_eq!(
                elapsed,
                if restored {
                    Duration::from_secs(15)
                } else {
                    Duration::ZERO
                }
            );
            assert!(ready.is_none());
            windows.forget("agent");
            assert!(
                windows.pending.is_empty() && windows.active.is_empty(),
                "unknown observations invalidate the saved source"
            );
        }
    }

    #[test]
    fn invalid_or_stop_ready_checkpoint_is_not_observation_authority() {
        let mut future = record();
        future.schema_version = 2;
        assert!(future.restore("boot-a", 2, 60_000, 500_000).is_err());
        for measured in [60_000, u64::MAX] {
            let mut invalid = record();
            invalid.observations.get_mut("agent").unwrap().measured_ms = measured;
            assert!(invalid.restore("boot-a", 2, 60_000, 500_000).is_err());
        }
        let mut overfull = record();
        overfull.observations = (0..=MAXIMUM_WINDOWS)
            .map(|i| {
                (
                    format!("agent-{i}"),
                    record().observations.remove("agent").unwrap(),
                )
            })
            .collect();
        assert!(overfull.restore("boot-a", 2, 60_000, 500_000).is_err());
    }

    #[test]
    fn platform_observation_has_a_stable_boot_and_monotonic_ticks() {
        let boot = boot_identity().unwrap();
        let before = monotonic_ms().unwrap();
        assert_eq!(boot, boot_identity().unwrap());
        assert!(monotonic_ms().unwrap() >= before);
    }
}
