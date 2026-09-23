//! Sliding-hour rate limiting keyed by device id and by client IP.
//!
//! The clock is injected as `fn() -> SystemTime` so tests can advance time
//! deterministically instead of sleeping; production wiring passes
//! `SystemTime::now`. Wall time is intentional: the deployed VM suspends
//! while idle, and `Instant` need not count that time. A one-hour quota
//! must expire after an hour even when the process spent it suspended.
//! State is process-local by design: one machine, one
//! in-memory limiter, no distributed store.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

const WINDOW: Duration = Duration::from_secs(3_600);
const DEVICE_LIMIT_PER_HOUR: usize = 5;
const IP_LIMIT_PER_HOUR: usize = 20;

type Clock = Box<dyn Fn() -> SystemTime + Send + Sync>;

/// Per-key hit timestamps within the current sliding window.
#[derive(Default)]
struct Window {
    hits: HashMap<String, Vec<SystemTime>>,
}

impl Window {
    /// Ages out every bucket, drops the ones left empty, and reports the
    /// wait for this key without consuming quota for a refused request.
    ///
    /// The sweep covers the whole map rather than just `key`, because a key
    /// is only revisited if that same client comes back: pruning `key` alone
    /// left every one-shot caller interned for the life of the process. The
    /// cost is one pass over the live keys per request, under a mutex —
    /// nothing at this service's volume, where both hourly caps together
    /// bound how many hits any live bucket can hold.
    fn retry_after(&mut self, key: &str, now: SystemTime, limit: usize) -> Duration {
        self.hits.retain(|_, hits| {
            // A backwards clock adjustment must not grant fresh quota.
            hits.retain(|&seen| now.duration_since(seen).unwrap_or_default() < WINDOW);
            !hits.is_empty()
        });
        let Some(hits) = self.hits.get(key).filter(|hits| hits.len() >= limit) else {
            return Duration::ZERO;
        };
        // Timestamps may be out of order after a clock adjustment.
        let first = *hits.iter().min().expect("a full bucket has hits");
        (first + WINDOW).duration_since(now).unwrap_or_default()
    }

    fn record(&mut self, key: &str, now: SystemTime) {
        self.hits.entry(key.to_string()).or_default().push(now);
    }
}

#[derive(Default)]
struct Counters {
    devices: Window,
    ips: Window,
}

/// Process-local sliding-hour rate limiter, gated on both the submitting
/// device and its client IP. Not meant to survive a restart or to
/// coordinate across replicas.
pub struct RateLimiter {
    clock: Clock,
    counters: Mutex<Counters>,
}

impl RateLimiter {
    pub fn new(clock: Clock) -> Self {
        Self {
            clock,
            counters: Mutex::new(Counters::default()),
        }
    }

    /// Reserves both quotas atomically, or returns the wait until both
    /// have room. A refusal consumes neither quota: retries cannot extend
    /// the device's lockout or starve others sharing its IP/NAT.
    pub fn check(&self, device: &str, ip: &str) -> Result<(), Duration> {
        let mut counters = self.counters.lock().expect("rate limit mutex poisoned");
        let now = (self.clock)();
        let wait = counters
            .devices
            .retry_after(device, now, DEVICE_LIMIT_PER_HOUR)
            .max(counters.ips.retry_after(ip, now, IP_LIMIT_PER_HOUR));
        if !wait.is_zero() {
            return Err(wait);
        }
        counters.devices.record(device, now);
        counters.ips.record(ip, now);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn allows_up_to_the_device_cap_then_refuses() {
        let limiter = RateLimiter::new(Box::new(SystemTime::now));
        for _ in 0..DEVICE_LIMIT_PER_HOUR {
            assert!(limiter.check("device-1", "1.1.1.1").is_ok());
        }
        assert!(limiter.check("device-1", "1.1.1.1").is_err());
    }

    #[test]
    fn tracks_devices_independently() {
        let limiter = RateLimiter::new(Box::new(SystemTime::now));
        for _ in 0..DEVICE_LIMIT_PER_HOUR {
            assert!(limiter.check("device-1", "1.1.1.1").is_ok());
        }
        assert!(limiter.check("device-2", "1.1.1.1").is_ok());
    }

    #[test]
    fn refuses_once_the_shared_ip_cap_is_reached() {
        let limiter = RateLimiter::new(Box::new(SystemTime::now));
        for i in 0..IP_LIMIT_PER_HOUR {
            let device = format!("device-{i}");
            assert!(limiter.check(&device, "9.9.9.9").is_ok());
        }
        assert!(limiter.check("device-new", "9.9.9.9").is_err());
    }

    // Fix round 1, finding 2: a request already refused by its own device
    // cap must not also consume a hit from the shared IP budget, or one
    // retrying client can starve every other device behind the same
    // NAT/IP. Fifteen retries after the initial five bring what the OLD
    // (unconditional) counting would have logged on this IP to exactly the
    // 20/hour cap, so a fresh device on the same IP would have been wrongly
    // refused under the old behavior; the fix keeps it admitted.
    #[test]
    fn a_device_refused_by_its_own_cap_does_not_consume_the_shared_ip_budget() {
        let limiter = RateLimiter::new(Box::new(SystemTime::now));
        for _ in 0..DEVICE_LIMIT_PER_HOUR {
            assert!(limiter.check("device-1", "5.5.5.5").is_ok());
        }
        for _ in 0..15 {
            assert!(limiter.check("device-1", "5.5.5.5").is_err());
        }
        assert!(limiter.check("device-2", "5.5.5.5").is_ok());
    }

    #[test]
    fn quota_expires_at_the_wall_clock_boundary_after_idle_time() {
        let start = SystemTime::UNIX_EPOCH + Duration::from_secs(10_000);
        let tick = Arc::new(Mutex::new(start));
        let reading = Arc::clone(&tick);
        let limiter = RateLimiter::new(Box::new(move || *reading.lock().unwrap()));
        for _ in 0..DEVICE_LIMIT_PER_HOUR {
            assert!(limiter.check("device", "1.1.1.1").is_ok());
        }
        // No process activity is needed to age the quota. Only wall time
        // advances, as it does while the VM is suspended.
        *tick.lock().unwrap() = start + WINDOW - Duration::from_millis(250);
        assert_eq!(
            limiter.check("device", "1.1.1.1"),
            Err(Duration::from_millis(250))
        );
        *tick.lock().unwrap() = start + WINDOW;
        assert_eq!(limiter.check("device", "1.1.1.1"), Ok(()));
    }

    #[test]
    fn shared_ip_refusals_do_not_create_a_later_device_lockout() {
        let start = SystemTime::now();
        let tick = Arc::new(Mutex::new(start));
        let reading = Arc::clone(&tick);
        let limiter = RateLimiter::new(Box::new(move || *reading.lock().unwrap()));
        for i in 0..IP_LIMIT_PER_HOUR {
            assert!(limiter.check(&format!("device-{i}"), "1.1.1.1").is_ok());
        }
        *tick.lock().unwrap() = start + Duration::from_secs(600);
        for _ in 0..10 {
            assert_eq!(
                limiter.check("new-device", "1.1.1.1"),
                Err(Duration::from_secs(3_000))
            );
        }
        *tick.lock().unwrap() = start + WINDOW;
        for _ in 0..DEVICE_LIMIT_PER_HOUR {
            assert_eq!(limiter.check("new-device", "1.1.1.1"), Ok(()));
        }
    }

    #[test]
    fn retry_waits_for_both_device_and_ip_quotas() {
        let start = SystemTime::now();
        let tick = Arc::new(Mutex::new(start));
        let reading = Arc::clone(&tick);
        let limiter = RateLimiter::new(Box::new(move || *reading.lock().unwrap()));
        for _ in 0..DEVICE_LIMIT_PER_HOUR {
            assert!(limiter.check("device", "1.1.1.1").is_ok());
        }
        *tick.lock().unwrap() = start + Duration::from_secs(600);
        for i in 0..IP_LIMIT_PER_HOUR {
            assert!(limiter.check(&format!("other-{i}"), "2.2.2.2").is_ok());
        }
        assert_eq!(limiter.check("device", "2.2.2.2"), Err(WINDOW));
    }

    #[test]
    fn backwards_clock_adjustments_preserve_quota_and_report_the_real_wait() {
        let start = SystemTime::now();
        let tick = Arc::new(Mutex::new(start));
        let reading = Arc::clone(&tick);
        let limiter = RateLimiter::new(Box::new(move || *reading.lock().unwrap()));
        for _ in 0..DEVICE_LIMIT_PER_HOUR {
            assert!(limiter.check("device", "1.1.1.1").is_ok());
        }
        *tick.lock().unwrap() = start - Duration::from_secs(120);
        assert_eq!(
            limiter.check("device", "1.1.1.1"),
            Err(WINDOW + Duration::from_secs(120))
        );
        *tick.lock().unwrap() = start + WINDOW;
        assert_eq!(limiter.check("device", "1.1.1.1"), Ok(()));
    }

    // Fix round 5, I2: every key ever seen was interned forever. Nothing
    // reclaims a bucket whose hits have all aged out, so a public endpoint's
    // limiter map grows for the life of the process — the memory half of the
    // same hole `device` was capped for, now closed on the map side too.
    #[test]
    fn evicts_buckets_whose_hits_have_all_aged_out() {
        let start = SystemTime::now();
        let tick = Arc::new(Mutex::new(start));
        let reading = Arc::clone(&tick);
        let limiter = RateLimiter::new(Box::new(move || *reading.lock().unwrap()));

        for index in 0..50 {
            assert!(
                limiter
                    .check(&format!("device-{index}"), &format!("10.0.0.{index}"))
                    .is_ok()
            );
        }
        assert_eq!(limiter.counters.lock().unwrap().devices.hits.len(), 50);
        assert_eq!(limiter.counters.lock().unwrap().ips.hits.len(), 50);

        *tick.lock().unwrap() = start + WINDOW + Duration::from_secs(1);
        assert!(limiter.check("device-new", "10.0.1.1").is_ok());

        assert_eq!(
            limiter.counters.lock().unwrap().devices.hits.len(),
            1,
            "a bucket with no live hits must be dropped, not kept as an empty entry"
        );
        assert_eq!(limiter.counters.lock().unwrap().ips.hits.len(), 1);
    }
}
