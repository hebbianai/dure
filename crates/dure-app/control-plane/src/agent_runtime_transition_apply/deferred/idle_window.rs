//! A quiet interval measures observer credit, never durable stop authority.
//! The caller still submits a fresh observation to the existing fenced stop.

use std::time::{Duration, Instant};

/// Tracks one exact source supplied by the authoritative runtime observer.
/// Unknown observations, gaps, source changes and consumed attempts restart
/// the interval. Restoring measured credit requires a separately validated
/// checkpoint and a fresh exact source, never the passage of offline time.
pub(super) struct IdleWindow<I, S> {
    observed: Option<Observed<I, S>>,
    maximum_gap: Duration,
}

struct Observed<I, S> {
    source: (I, S),
    first_seen: Instant,
    last_seen: Instant,
}

impl<I: Eq, S> IdleWindow<I, S> {
    pub(super) fn restore(
        maximum_gap: Duration,
        now: Instant,
        source: (I, S),
        measured: Duration,
    ) -> Option<Self> {
        Some(Self {
            observed: Some(Observed {
                source,
                first_seen: now.checked_sub(measured)?,
                last_seen: now,
            }),
            maximum_gap,
        })
    }

    pub(super) fn checkpoint(&self, now: Instant) -> Option<(&I, Duration, Duration)> {
        let observed = self.observed.as_ref().filter(|_| self.is_recent(now))?;
        Some((
            &observed.source.0,
            observed
                .last_seen
                .checked_duration_since(observed.first_seen)?,
            now.checked_duration_since(observed.last_seen)?,
        ))
    }

    pub(super) fn new(maximum_gap: Duration) -> Self {
        Self {
            observed: None,
            maximum_gap,
        }
    }

    pub(super) fn is_recent(&self, now: Instant) -> bool {
        self.observed.as_ref().is_some_and(|observed| {
            now.checked_duration_since(observed.last_seen)
                .is_some_and(|gap| gap <= self.maximum_gap)
        })
    }

    /// Identity includes selection, complete native authority and semantic
    /// runtime revision. The payload carries the newest destructive fence;
    /// output-only changes refresh it without inventing provider activity.
    pub(super) fn observe(&mut self, now: Instant, source: Option<(I, S)>) -> Option<Duration> {
        let Some(source) = source else {
            self.observed = None;
            return None;
        };
        if let Some(previous) = self.observed.as_mut()
            && previous.source.0 == source.0
            && now
                .checked_duration_since(previous.last_seen)
                .is_some_and(|gap| gap <= self.maximum_gap)
        {
            previous.source = source;
            previous.last_seen = now;
            return now.checked_duration_since(previous.first_seen);
        }
        self.observed = Some(Observed {
            source,
            first_seen: now,
            last_seen: now,
        });
        Some(Duration::ZERO)
    }

    /// Consume before admission, including when the existing stop path later
    /// refuses. Retrying a failed attempt requires a new observed idle window.
    pub(super) fn take_ready(&mut self, now: Instant, minimum_idle: Duration) -> Option<(I, S)> {
        let observed = self.observed.as_ref()?;
        let fresh = self.is_recent(now);
        if !fresh {
            self.observed = None;
            return None;
        }
        // Waiting between observations cannot establish the quiet interval.
        let elapsed = observed
            .last_seen
            .checked_duration_since(observed.first_seen)?;
        if elapsed < minimum_idle {
            return None;
        }
        self.observed.take().map(|observed| observed.source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passive_output_preserves_semantic_idle_and_refreshes_the_stop_fence() {
        let start = Instant::now();
        let mut window = IdleWindow::new(Duration::from_secs(5));
        let semantic_epoch = ("selection-1", "generation-a", "conversation-a", 3);
        window.observe(start, Some((semantic_epoch, 100)));
        assert_eq!(
            window.observe(start + Duration::from_secs(4), Some((semantic_epoch, 101)),),
            Some(Duration::from_secs(4)),
            "passive terminal output is not a new provider activity epoch"
        );
        assert_eq!(
            window.take_ready(start + Duration::from_secs(4), Duration::from_secs(4)),
            Some((semantic_epoch, 101)),
            "admission must receive the newest exact output fence, never the old one"
        );
    }

    #[test]
    fn threshold_requires_observations_not_just_the_passage_of_time() {
        let start = Instant::now();
        let mut window = IdleWindow::new(Duration::from_secs(5));
        assert_eq!(window.observe(start, Some((1, 100))), Some(Duration::ZERO));
        assert_eq!(
            window.take_ready(start + Duration::from_secs(4), Duration::from_secs(4)),
            None
        );
        assert_eq!(
            window.observe(start + Duration::from_secs(4), Some((1, 100))),
            Some(Duration::from_secs(4))
        );
        assert_eq!(
            window.take_ready(start + Duration::from_secs(4), Duration::from_secs(4)),
            Some((1, 100))
        );
        assert_eq!(
            window.take_ready(start + Duration::from_secs(4), Duration::from_secs(4)),
            None
        );
    }

    #[test]
    fn unknown_or_changed_source_discards_the_entire_interval() {
        let start = Instant::now();
        let mut window = IdleWindow::new(Duration::from_secs(5));
        window.observe(start, Some((("selection-a", "generation-a", 1), 99)));
        window.observe(
            start + Duration::from_secs(4),
            Some((("selection-a", "generation-a", 1), 99)),
        );
        for source in [
            (("selection-b", "generation-a", 1), 99),
            (("selection-b", "generation-b", 1), 99),
            (("selection-b", "generation-b", 2), 99),
        ] {
            assert_eq!(
                window.observe(start + Duration::from_secs(4), Some(source)),
                Some(Duration::ZERO)
            );
            assert_eq!(
                window.take_ready(start + Duration::from_secs(4), Duration::from_secs(1)),
                None
            );
        }
        assert_eq!(window.observe(start + Duration::from_secs(5), None), None);
        assert_eq!(
            window.observe(
                start + Duration::from_secs(6),
                Some((("selection-b", "generation-b", 2), 100))
            ),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn missing_samples_and_delayed_admission_never_extend_quiet_time() {
        let start = Instant::now();
        let mut window = IdleWindow::new(Duration::from_secs(5));
        window.observe(start, Some((1, 100)));
        assert_eq!(
            window.observe(start + Duration::from_secs(6), Some((1, 100))),
            Some(Duration::ZERO)
        );
        window.observe(start + Duration::from_secs(10), Some((1, 100)));
        assert_eq!(
            window.take_ready(start + Duration::from_secs(16), Duration::from_secs(4)),
            None
        );
        assert_eq!(
            window.observe(start + Duration::from_secs(16), Some((1, 100))),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn restart_consumption_and_clock_regression_require_a_new_interval() {
        let start = Instant::now();
        let mut window = IdleWindow::new(Duration::from_secs(5));
        window.observe(start, Some((1, 100)));
        window.observe(start + Duration::from_secs(4), Some((1, 100)));
        assert_eq!(
            window.take_ready(start + Duration::from_secs(4), Duration::from_secs(4)),
            Some((1, 100))
        );
        assert_eq!(
            window.observe(start + Duration::from_secs(5), Some((1, 100))),
            Some(Duration::ZERO)
        );
        assert_eq!(window.observe(start, Some((1, 100))), Some(Duration::ZERO));
        let mut restarted = IdleWindow::new(Duration::from_secs(5));
        assert_eq!(
            restarted.observe(start + Duration::from_secs(100), Some((1, 100))),
            Some(Duration::ZERO)
        );
    }
}
