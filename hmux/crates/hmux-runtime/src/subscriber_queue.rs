use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::host_resource_budget::{HostResourceBudget, HostResourceSnapshot, QueueReservation};

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum PushError {
    Closed,
    Full,
}

struct Entry<T> {
    value: T,
    accounted_bytes: usize,
    enqueued_at: Instant,
    _host_reservation: Option<QueueReservation>,
}

struct State<T> {
    entries: VecDeque<Entry<T>>,
    accounted_bytes: usize,
    closed: bool,
}

/// A non-blocking producer queue with independent record, byte, and age caps.
///
/// Provider output must never wait for a subscriber socket. The consumer may
/// block in `pop`, but a producer only takes this short in-memory lock and
/// rejects pressure that exceeds any configured bound.
pub(crate) struct BoundedQueue<T> {
    state: Mutex<State<T>>,
    ready: Condvar,
    max_records: usize,
    max_accounted_bytes: usize,
    max_age: Duration,
    host_budget: Option<Arc<HostResourceBudget>>,
}

impl<T> BoundedQueue<T> {
    pub(crate) fn new(max_records: usize, max_accounted_bytes: usize, max_age: Duration) -> Self {
        assert!(max_records > 0);
        assert!(max_accounted_bytes > 0);
        Self {
            state: Mutex::new(State {
                entries: VecDeque::new(),
                accounted_bytes: 0,
                closed: false,
            }),
            ready: Condvar::new(),
            max_records,
            max_accounted_bytes,
            max_age,
            host_budget: None,
        }
    }

    pub(crate) fn with_host_budget(
        max_records: usize,
        max_accounted_bytes: usize,
        max_age: Duration,
        host_budget: Arc<HostResourceBudget>,
    ) -> Self {
        let mut queue = Self::new(max_records, max_accounted_bytes, max_age);
        queue.host_budget = Some(host_budget);
        queue
    }

    pub(crate) fn try_push(&self, value: T, accounted_bytes: usize) -> Result<(), PushError> {
        self.try_push_at(value, accounted_bytes, Instant::now())
    }

    /// Atomically admits an ordered record batch. Multipart terminal snapshots
    /// must never leave a prefix in the queue: the client either receives the
    /// entire revision or reconnects for a fresh canonical snapshot.
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn try_push_batch(
        &self,
        values: impl IntoIterator<Item = (T, usize)>,
    ) -> Result<(), PushError> {
        let values = values.into_iter().collect::<Vec<_>>();
        if values.is_empty() {
            return Ok(());
        }
        let now = Instant::now();
        let batch_bytes = values
            .iter()
            .fold(0_usize, |total, (_, bytes)| total.saturating_add(*bytes));
        let mut state = self.state.lock().map_err(|_| PushError::Closed)?;
        if state.closed {
            return Err(PushError::Closed);
        }
        let oldest_expired = state
            .entries
            .front()
            .is_some_and(|entry| now.saturating_duration_since(entry.enqueued_at) >= self.max_age);
        let records_after = state.entries.len().saturating_add(values.len());
        let bytes_after = state.accounted_bytes.saturating_add(batch_bytes);
        if oldest_expired
            || records_after > self.max_records
            || bytes_after > self.max_accounted_bytes
        {
            if let Some(budget) = self.host_budget.as_ref() {
                budget.record_queue_rejection();
            }
            return Err(PushError::Full);
        }
        let mut host_reservations = Vec::with_capacity(values.len());
        for (_, accounted_bytes) in &values {
            host_reservations.push(match self.host_budget.as_ref() {
                Some(budget) => Some(
                    budget
                        .try_reserve_queue_bytes(*accounted_bytes)
                        .ok_or(PushError::Full)?,
                ),
                None => None,
            });
        }
        for ((value, accounted_bytes), host_reservation) in
            values.into_iter().zip(host_reservations)
        {
            state.entries.push_back(Entry {
                value,
                accounted_bytes,
                enqueued_at: now,
                _host_reservation: host_reservation,
            });
        }
        state.accounted_bytes = bytes_after;
        self.ready.notify_one();
        Ok(())
    }

    fn try_push_at(&self, value: T, accounted_bytes: usize, now: Instant) -> Result<(), PushError> {
        let mut state = self.state.lock().map_err(|_| PushError::Closed)?;
        if state.closed {
            return Err(PushError::Closed);
        }
        let oldest_expired = state
            .entries
            .front()
            .is_some_and(|entry| now.saturating_duration_since(entry.enqueued_at) >= self.max_age);
        let bytes_after = state.accounted_bytes.saturating_add(accounted_bytes);
        if oldest_expired
            || state.entries.len() >= self.max_records
            || bytes_after > self.max_accounted_bytes
        {
            if let Some(budget) = self.host_budget.as_ref() {
                budget.record_queue_rejection();
            }
            return Err(PushError::Full);
        }
        let host_reservation = match self.host_budget.as_ref() {
            Some(budget) => Some(
                budget
                    .try_reserve_queue_bytes(accounted_bytes)
                    .ok_or(PushError::Full)?,
            ),
            None => None,
        };
        state.entries.push_back(Entry {
            value,
            accounted_bytes,
            enqueued_at: now,
            _host_reservation: host_reservation,
        });
        state.accounted_bytes = bytes_after;
        self.ready.notify_one();
        Ok(())
    }

    /// Replaces every obsolete matching entry while preserving nonmatching
    /// records in their exact FIFO order, then appends the latest value.
    ///
    /// This gives a viewport one replaceable slot even when receipts/effects
    /// were ordered after its previous frame. A hard lifecycle barrier starts
    /// a new replacement segment: records before it remain ordered and the
    /// latest value is appended after it.
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn try_replace_matching_or_push(
        &self,
        value: T,
        accounted_bytes: usize,
        replace: impl Fn(&T) -> bool,
        blocks_replacement: impl Fn(&T) -> bool,
    ) -> Result<(), PushError> {
        let now = Instant::now();
        let mut state = self.state.lock().map_err(|_| PushError::Closed)?;
        if state.closed {
            return Err(PushError::Closed);
        }
        let oldest_expired = state
            .entries
            .front()
            .is_some_and(|entry| now.saturating_duration_since(entry.enqueued_at) >= self.max_age);
        if oldest_expired {
            if let Some(budget) = self.host_budget.as_ref() {
                budget.record_queue_rejection();
            }
            return Err(PushError::Full);
        }
        let replacement_floor = state
            .entries
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| blocks_replacement(&entry.value).then_some(index + 1))
            .next_back()
            .unwrap_or(0);
        let matching = state
            .entries
            .iter()
            .enumerate()
            .skip(replacement_floor)
            .filter_map(|(index, entry)| replace(&entry.value).then_some(index))
            .collect::<Vec<_>>();
        if let Some(last_matching) = matching.last().copied() {
            let previous_bytes = matching.iter().fold(0_usize, |total, index| {
                total.saturating_add(state.entries[*index].accounted_bytes)
            });
            let bytes_after = state
                .accounted_bytes
                .saturating_sub(previous_bytes)
                .saturating_add(accounted_bytes);
            if bytes_after > self.max_accounted_bytes {
                if let Some(budget) = self.host_budget.as_ref() {
                    budget.record_queue_rejection();
                }
                return Err(PushError::Full);
            }
            let mut replacement = state
                .entries
                .remove(last_matching)
                .ok_or(PushError::Closed)?;
            if let Some(reservation) = replacement._host_reservation.as_mut() {
                if !reservation.try_resize(accounted_bytes) {
                    state.entries.insert(last_matching, replacement);
                    return Err(PushError::Full);
                }
            }
            for index in matching[..matching.len() - 1].iter().rev() {
                state.entries.remove(*index);
            }
            replacement.value = value;
            replacement.accounted_bytes = accounted_bytes;
            replacement.enqueued_at = now;
            state.entries.push_back(replacement);
            state.accounted_bytes = bytes_after;
            self.ready.notify_one();
            return Ok(());
        }
        if state.entries.len() >= self.max_records
            || state.accounted_bytes.saturating_add(accounted_bytes) > self.max_accounted_bytes
        {
            if let Some(budget) = self.host_budget.as_ref() {
                budget.record_queue_rejection();
            }
            return Err(PushError::Full);
        }
        let host_reservation = match self.host_budget.as_ref() {
            Some(budget) => Some(
                budget
                    .try_reserve_queue_bytes(accounted_bytes)
                    .ok_or(PushError::Full)?,
            ),
            None => None,
        };
        state.entries.push_back(Entry {
            value,
            accounted_bytes,
            enqueued_at: now,
            _host_reservation: host_reservation,
        });
        state.accounted_bytes = state.accounted_bytes.saturating_add(accounted_bytes);
        self.ready.notify_one();
        Ok(())
    }

    pub(crate) fn pop(&self) -> Option<T> {
        let mut state = self.state.lock().ok()?;
        loop {
            if let Some(entry) = state.entries.pop_front() {
                state.accounted_bytes = state.accounted_bytes.saturating_sub(entry.accounted_bytes);
                return Some(entry.value);
            }
            if state.closed {
                return None;
            }
            state = self.ready.wait(state).ok()?;
        }
    }

    pub(crate) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            self.ready.notify_all();
        }
    }

    pub(crate) fn host_resource_snapshot(&self) -> Option<HostResourceSnapshot> {
        self.host_budget.as_ref().map(|budget| budget.snapshot())
    }

    #[cfg(test)]
    pub(crate) fn queued_accounted_bytes(&self) -> usize {
        self.state.lock().map_or(0, |state| state.accounted_bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_resource_budget::HostResourceLimits;

    #[test]
    fn record_and_byte_limits_are_independent() {
        let queue = BoundedQueue::new(2, 10, Duration::from_secs(5));

        assert_eq!(queue.try_push(1, 4), Ok(()));
        assert_eq!(queue.try_push(2, 4), Ok(()));
        assert_eq!(queue.try_push(3, 1), Err(PushError::Full));
        assert_eq!(queue.pop(), Some(1));
        assert_eq!(queue.try_push(3, 7), Err(PushError::Full));
        assert_eq!(queue.try_push(3, 6), Ok(()));
    }

    #[test]
    fn an_expired_oldest_record_fails_pressure_without_blocking() {
        let queue = BoundedQueue::new(4, 100, Duration::from_secs(5));
        let started = Instant::now();

        assert_eq!(queue.try_push_at(1, 1, started), Ok(()));
        assert_eq!(
            queue.try_push_at(2, 1, started + Duration::from_secs(5)),
            Err(PushError::Full)
        );
    }

    #[test]
    fn close_wakes_a_waiter_after_draining_queued_records() {
        let queue = BoundedQueue::new(2, 10, Duration::from_secs(5));
        assert_eq!(queue.try_push(1, 1), Ok(()));

        queue.close();

        assert_eq!(queue.pop(), Some(1));
        assert_eq!(queue.pop(), None);
        assert_eq!(queue.try_push(2, 1), Err(PushError::Closed));
    }

    #[cfg(feature = "terminal-state-stream")]
    #[test]
    fn batch_admission_is_all_or_nothing() {
        let queue = BoundedQueue::new(3, 10, Duration::from_secs(5));
        assert_eq!(queue.try_push(1, 4), Ok(()));
        assert_eq!(queue.try_push_batch([(2, 4), (3, 4)]), Err(PushError::Full));
        queue.close();
        assert_eq!(queue.pop(), Some(1));
        assert_eq!(queue.pop(), None);
    }

    #[cfg(feature = "terminal-state-stream")]
    #[test]
    fn replaceable_tail_keeps_only_the_latest_matching_generation() {
        let queue = BoundedQueue::new(3, 10, Duration::from_secs(5));
        assert_eq!(
            queue.try_replace_matching_or_push(
                ("viewport", 1),
                4,
                |entry| entry.0 == "viewport",
                |_| false,
            ),
            Ok(())
        );
        assert_eq!(
            queue.try_replace_matching_or_push(
                ("viewport", 2),
                6,
                |entry| entry.0 == "viewport",
                |_| false,
            ),
            Ok(())
        );
        assert_eq!(queue.queued_accounted_bytes(), 6);
        queue.close();
        assert_eq!(queue.pop(), Some(("viewport", 2)));
        assert_eq!(queue.pop(), None);
    }

    #[cfg(feature = "terminal-state-stream")]
    #[test]
    fn replaceable_viewport_crosses_receipts_without_reordering_them() {
        let queue = BoundedQueue::new(4, 20, Duration::from_secs(5));
        assert_eq!(
            queue.try_replace_matching_or_push(
                ("viewport", 1),
                4,
                |entry| entry.0 == "viewport",
                |entry| entry.0 == "exit",
            ),
            Ok(())
        );
        assert_eq!(queue.try_push(("receipt", 0), 2), Ok(()));
        assert_eq!(
            queue.try_replace_matching_or_push(
                ("viewport", 2),
                4,
                |entry| entry.0 == "viewport",
                |entry| entry.0 == "exit",
            ),
            Ok(())
        );
        queue.close();
        assert_eq!(queue.pop(), Some(("receipt", 0)));
        assert_eq!(queue.pop(), Some(("viewport", 2)));
        assert_eq!(queue.pop(), None);
    }

    #[cfg(feature = "terminal-state-stream")]
    #[test]
    fn replaceable_viewport_never_crosses_a_lifecycle_barrier() {
        let queue = BoundedQueue::new(4, 20, Duration::from_secs(5));
        assert_eq!(
            queue.try_replace_matching_or_push(
                ("viewport", 1),
                4,
                |entry| entry.0 == "viewport",
                |entry| entry.0 == "exit",
            ),
            Ok(())
        );
        assert_eq!(queue.try_push(("exit", 0), 2), Ok(()));
        assert_eq!(
            queue.try_replace_matching_or_push(
                ("viewport", 2),
                4,
                |entry| entry.0 == "viewport",
                |entry| entry.0 == "exit",
            ),
            Ok(())
        );
        queue.close();
        assert_eq!(queue.pop(), Some(("viewport", 1)));
        assert_eq!(queue.pop(), Some(("exit", 0)));
        assert_eq!(queue.pop(), Some(("viewport", 2)));
        assert_eq!(queue.pop(), None);
    }

    #[test]
    fn shared_host_byte_budget_is_released_by_pop_and_drop() {
        let budget = HostResourceBudget::new(HostResourceLimits {
            max_pending_connections: 1,
            max_active_connections: 2,
            reserved_priority_connections: 1,
            max_queued_bytes: 10,
        });
        let first =
            BoundedQueue::with_host_budget(4, 10, Duration::from_secs(5), Arc::clone(&budget));
        let second =
            BoundedQueue::with_host_budget(4, 10, Duration::from_secs(5), Arc::clone(&budget));

        assert_eq!(first.try_push(1, 6), Ok(()));
        assert_eq!(second.try_push(2, 5), Err(PushError::Full));
        assert_eq!(budget.snapshot().queued_bytes, 6);
        assert_eq!(first.pop(), Some(1));
        assert_eq!(second.try_push(2, 5), Ok(()));
        drop(second);
        assert_eq!(budget.snapshot().queued_bytes, 0);
        assert_eq!(budget.snapshot().rejected_queue_pushes, 1);

        let local =
            BoundedQueue::with_host_budget(1, 10, Duration::from_secs(5), Arc::clone(&budget));
        assert_eq!(local.try_push(3, 1), Ok(()));
        assert_eq!(local.try_push(4, 1), Err(PushError::Full));
        assert_eq!(budget.snapshot().rejected_queue_pushes, 2);
    }
}
