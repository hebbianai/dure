//! 폰이 물어본 것을, 답할 수 있는 유일한 곳까지 나르고 결과를 기다리는 표.
//!
//! # 왜 하나인가
//!
//! 이 왕복이 두 번째로 필요해졌을 때(인박스 답, 그리고 변경 파일 조회) 표를 한
//! 벌 더 만드는 길이 있었다. 그러면 마감·이름 짓기·늦게 온 답을 버리는 규칙이
//! 두 곳에 생기고, 그 셋은 전부 **틀렸을 때 조용한** 규칙이다 — 이름이 겹치면
//! 한 폰의 답이 다른 폰의 질문에 붙고, 그 사실은 어느 화면에도 나타나지 않는다.
//!
//! 그래서 규칙은 여기 한 벌이고, 종류별로 다른 것은 마감을 넘겼을 때 무엇을
//! 돌려주는가뿐이다.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::time::Duration;

/// 화면이 답할 때까지 기다리는 시간.
///
/// 백엔드 왕복 하나에 넉넉하고, 사용자가 버튼을 누른 채 견딜 만한 길이다. 넘기면
/// 실패로 돌려준다 — 영원히 기다리면 폰의 버튼은 영원히 회색으로 남고, 사용자는
/// 앱이 멈춘 것으로 읽는다.
pub const ROUND_TRIP_DEADLINE: Duration = Duration::from_secs(20);

/// 한 종류의 왕복이 자기에 대해 아는 것.
///
/// 이름 앞에 붙는 말과, 마감을 넘겼을 때 사람에게 하는 말. 둘 다 종류마다 달라야
/// 한다 — 이름 공간이 겹치면 한 폰의 답이 다른 폰의 질문에 붙고, "답하지
/// 않았습니다" 와 "읽지 못했습니다" 는 사용자에게 다른 조치를 뜻한다.
///
/// 접두사를 타입에 두는 것이 값으로 받는 것보다 낫다: 표를 만드는 자리가
/// 늘어나도 같은 종류는 언제나 같은 이름 공간에 남는다.
pub trait RoundTrip: Sized {
    const PREFIX: &'static str;

    /// 화면이 듣는 이름. 종류마다 하나다.
    const EVENT: &'static str;

    fn timed_out() -> Self;

    /// 화면에 닿지도 못했을 때.
    ///
    /// 마감을 넘긴 것과 다른 사실이다 — 이쪽은 기다릴 이유조차 없었다.
    fn undeliverable() -> Self;
}

/// 아직 화면의 답을 기다리는 왕복들.
pub struct PendingRoundTrips<T> {
    waiting: Mutex<HashMap<String, SyncSender<T>>>,
    next: AtomicU64,
}

impl<T> Default for PendingRoundTrips<T> {
    fn default() -> Self {
        Self {
            waiting: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
        }
    }
}

impl<T: RoundTrip> PendingRoundTrips<T> {
    /// 왕복 하나를 연다. 돌려주는 것은 그 이름과, 결과가 도착할 자리다.
    ///
    /// 이름을 붙이는 곳은 기다리는 표를 가진 이쪽 하나다. 폰이 이름을 정하면 두
    /// 폰이 같은 이름을 보내는 날 한쪽의 답이 다른 쪽 질문에 붙는다.
    #[must_use]
    pub fn open(&self) -> (String, Receiver<T>) {
        let request_id = format!("{}-{}", T::PREFIX, self.next.fetch_add(1, Ordering::Relaxed));
        // 용량 1: 보내는 쪽이 받는 쪽을 기다리지 않는다. 마감을 넘겨 아무도 받지
        // 않게 된 자리에 화면이 뒤늦게 답해도, 그 답은 여기 담겼다가 조용히
        // 사라진다 — 화면 쪽 스레드가 그것 때문에 멈추지 않는다.
        let (sender, receiver) = sync_channel(1);
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.insert(request_id.clone(), sender);
        }
        (request_id, receiver)
    }

    /// 화면이 내놓은 결과. 모르는 이름은 버린다.
    ///
    /// 모르는 이름이 정상 경로다: 마감을 넘긴 왕복은 이미 자기 자리를 걷어 갔고,
    /// 그 뒤에 도착한 답은 아무도 기다리지 않는다. 그것을 오류로 만들면 화면은
    /// 자기 잘못이 아닌 실패를 보고하게 된다.
    pub fn settle(&self, request_id: &str, result: T) -> bool {
        let Ok(mut waiting) = self.waiting.lock() else {
            return false;
        };
        let Some(sender) = waiting.remove(request_id) else {
            return false;
        };
        sender.send(result).is_ok()
    }

    /// 아무에게도 넘기지 못한 왕복을 표에서 뺀다.
    ///
    /// 빼지 않으면 아무도 답하지 않을 자리가 표에 남는다. 하나하나는 작지만,
    /// 화면이 닫힌 동안 폰이 계속 누르면 그 자리들이 쌓인다.
    pub fn cancel(&self, request_id: &str) {
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.remove(request_id);
        }
    }

    /// 결과를 기다린다. 마감을 넘기면 그 왕복을 걷어 내고 실패로 답한다.
    #[must_use]
    pub fn wait(&self, request_id: &str, receiver: &Receiver<T>) -> T {
        match receiver.recv_timeout(ROUND_TRIP_DEADLINE) {
            Ok(result) => result,
            Err(_) => {
                if let Ok(mut waiting) = self.waiting.lock() {
                    waiting.remove(request_id);
                }
                T::timed_out()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct Probe(&'static str);

    impl RoundTrip for Probe {
        const PREFIX: &'static str = "probe";
        const EVENT: &'static str = "hub://probe";

        fn undeliverable() -> Self {
            Self("전달 실패")
        }

        fn timed_out() -> Self {
            Self("시간 초과")
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct OtherKind(&'static str);

    impl RoundTrip for OtherKind {
        const PREFIX: &'static str = "git-status";
        const EVENT: &'static str = "hub://other";

        fn undeliverable() -> Self {
            Self("전달 실패")
        }

        fn timed_out() -> Self {
            Self("시간 초과")
        }
    }

    #[test]
    fn a_screen_answer_reaches_the_waiting_request() {
        let pending = PendingRoundTrips::<Probe>::default();
        let (request_id, receiver) = pending.open();

        assert!(pending.settle(&request_id, Probe("적용됨")));
        assert_eq!(pending.wait(&request_id, &receiver), Probe("적용됨"));
    }

    /// 두 왕복이 서로의 답을 받아 가지 않는다. 받아 가면 승인 하나가 다른 질문에
    /// 붙고, 그 사실은 어느 화면에도 나타나지 않는다.
    #[test]
    fn two_requests_do_not_take_each_other_s_answer() {
        let pending = PendingRoundTrips::<Probe>::default();
        let (first, first_slot) = pending.open();
        let (second, second_slot) = pending.open();
        assert_ne!(first, second);

        pending.settle(&second, Probe("두 번째"));

        assert_eq!(pending.wait(&second, &second_slot), Probe("두 번째"));
        assert!(first_slot.try_recv().is_err());
    }

    /// 마감을 넘긴 뒤 도착한 답은 아무도 기다리지 않는다. 그것을 실패로 보고하면
    /// 화면은 자기 잘못이 아닌 오류를 띄운다.
    #[test]
    fn an_answer_nobody_is_waiting_for_is_dropped_quietly() {
        let pending = PendingRoundTrips::<Probe>::default();

        assert!(!pending.settle("probe-없음", Probe("아무도")));
    }

    /// 두 종류가 한 이름 공간을 쓰지 않는다. 쓰면 한 폰의 답이 다른 폰의 질문에
    /// 붙고, 그 사실은 어느 화면에도 나타나지 않는다.
    #[test]
    fn each_kind_names_its_own_round_trips() {
        let (probe_id, _probe_slot) = PendingRoundTrips::<Probe>::default().open();
        let (other_id, _other_slot) = PendingRoundTrips::<OtherKind>::default().open();

        assert!(probe_id.starts_with("probe-"), "{probe_id}");
        assert!(other_id.starts_with("git-status-"), "{other_id}");
    }
}
