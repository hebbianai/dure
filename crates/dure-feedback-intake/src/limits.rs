//! Sliding-hour rate limiting keyed by device id and by client IP.
//!
//! The clock is injected as `fn() -> Instant` so tests can advance time
//! deterministically instead of sleeping; production wiring passes
//! `Instant::now`. State is process-local by design: one machine, one
//! in-memory limiter, no distributed store.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(3_600);
const DEVICE_LIMIT_PER_HOUR: usize = 5;
const IP_LIMIT_PER_HOUR: usize = 20;

type Clock = Box<dyn Fn() -> Instant + Send + Sync>;

/// Per-key hit timestamps within the current sliding window.
#[derive(Default)]
struct Window {
    hits: HashMap<String, Vec<Instant>>,
}

impl Window {
    /// Ages out every bucket, drops the ones left empty, then records this
    /// attempt if `key`'s bucket still has room. Returns whether it was
    /// allowed.
    ///
    /// The sweep covers the whole map rather than just `key`, because a key
    /// is only revisited if that same client comes back: pruning `key` alone
    /// left every one-shot caller interned for the life of the process. The
    /// cost is one pass over the live keys per request, under a mutex —
    /// nothing at this service's volume, where both hourly caps together
    /// bound how many hits any live bucket can hold.
    fn allow(&mut self, key: &str, now: Instant, limit: usize) -> bool {
        self.hits.retain(|_, hits| {
            hits.retain(|&seen| now.saturating_duration_since(seen) < WINDOW);
            !hits.is_empty()
        });
        let hits = self.hits.entry(key.to_string()).or_default();
        if hits.len() >= limit {
            return false;
        }
        hits.push(now);
        true
    }
}

/// Process-local sliding-hour rate limiter, gated on both the submitting
/// device and its client IP. Not meant to survive a restart or to
/// coordinate across replicas.
pub struct RateLimiter {
    clock: Clock,
    devices: Mutex<Window>,
    ips: Mutex<Window>,
}

impl RateLimiter {
    pub fn new(clock: Clock) -> Self {
        Self {
            clock,
            devices: Mutex::new(Window::default()),
            ips: Mutex::new(Window::default()),
        }
    }

    /// Returns true only when both the device and the IP are under their
    /// hourly caps. The device cap is checked first and short-circuits: a
    /// request already refused for exceeding its own device's hourly quota
    /// never consumes a hit from the shared IP budget, so a client retrying
    /// past its own cap cannot starve every other client behind the same
    /// IP/NAT (an office network, a phone carrier's gateway).
    pub fn allow(&self, device: &str, ip: &str) -> bool {
        let now = (self.clock)();
        let device_ok = self
            .devices
            .lock()
            .expect("device rate limit mutex poisoned")
            .allow(device, now, DEVICE_LIMIT_PER_HOUR);
        if !device_ok {
            return false;
        }
        self.ips
            .lock()
            .expect("ip rate limit mutex poisoned")
            .allow(ip, now, IP_LIMIT_PER_HOUR)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn allows_up_to_the_device_cap_then_refuses() {
        let limiter = RateLimiter::new(Box::new(Instant::now));
        for _ in 0..DEVICE_LIMIT_PER_HOUR {
            assert!(limiter.allow("device-1", "1.1.1.1"));
        }
        assert!(!limiter.allow("device-1", "1.1.1.1"));
    }

    #[test]
    fn tracks_devices_independently() {
        let limiter = RateLimiter::new(Box::new(Instant::now));
        for _ in 0..DEVICE_LIMIT_PER_HOUR {
            assert!(limiter.allow("device-1", "1.1.1.1"));
        }
        assert!(limiter.allow("device-2", "1.1.1.1"));
    }

    #[test]
    fn refuses_once_the_shared_ip_cap_is_reached() {
        let limiter = RateLimiter::new(Box::new(Instant::now));
        for i in 0..IP_LIMIT_PER_HOUR {
            let device = format!("device-{i}");
            assert!(limiter.allow(&device, "9.9.9.9"));
        }
        assert!(!limiter.allow("device-new", "9.9.9.9"));
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
        let limiter = RateLimiter::new(Box::new(Instant::now));
        for _ in 0..DEVICE_LIMIT_PER_HOUR {
            assert!(limiter.allow("device-1", "5.5.5.5"));
        }
        for _ in 0..15 {
            assert!(!limiter.allow("device-1", "5.5.5.5"));
        }
        assert!(limiter.allow("device-2", "5.5.5.5"));
    }

    // Fix round 5, I2: every key ever seen was interned forever. Nothing
    // reclaims a bucket whose hits have all aged out, so a public endpoint's
    // limiter map grows for the life of the process — the memory half of the
    // same hole `device` was capped for, now closed on the map side too.
    #[test]
    fn evicts_buckets_whose_hits_have_all_aged_out() {
        let start = Instant::now();
        let tick = Arc::new(Mutex::new(start));
        let reading = Arc::clone(&tick);
        let limiter = RateLimiter::new(Box::new(move || *reading.lock().unwrap()));

        for index in 0..50 {
            assert!(limiter.allow(&format!("device-{index}"), &format!("10.0.0.{index}")));
        }
        assert_eq!(limiter.devices.lock().unwrap().hits.len(), 50);
        assert_eq!(limiter.ips.lock().unwrap().hits.len(), 50);

        *tick.lock().unwrap() = start + WINDOW + Duration::from_secs(1);
        assert!(limiter.allow("device-new", "10.0.1.1"));

        assert_eq!(
            limiter.devices.lock().unwrap().hits.len(),
            1,
            "a bucket with no live hits must be dropped, not kept as an empty entry"
        );
        assert_eq!(limiter.ips.lock().unwrap().hits.len(), 1);
    }
}
