//! 폰과 그 노트북을 만나게 해 주는 것. 그 이상은 하지 않는다.
//!
//! 두 소켓을 잇고 나면 흐르는 것을 해석하지 않는다 — **해석할 수도 없다.**
//! 그 위에서 폰과 허브가 지문 고정 TLS 를 세우고, 이 프로세스는 허브의
//! 개인키를 가진 적이 없다. 우리가 이 릴레이를 직접 운영하기 때문에 그 구분이
//! 중요하다: "안 본다" 가 아니라 "볼 수 없다" 가 근거여야 한다.
//!
//! 프로토콜과 그 이유: [`dure_hub_protocol::relay`].
//!
//! # 이 프로세스가 아는 것
//!
//! `server_id`, 각 허브의 인증서 지문(등록 검증에 필요하고 어차피 공개값이다),
//! 양쪽 IP, 연결 시각과 오간 바이트 수. 그게 전부다. 세션 바이트, 터미널 내용,
//! 세션 제목, 기기 토큰은 전부 안쪽 TLS 안이다.
//!
//! 연결 로그를 영속화하지 않는다. 라우팅에 필요한 것만 메모리에 두고, 끊기면
//! 사라진다.

pub mod proof;

use dure_hub_protocol::frame::{self, FrameError};
use dure_hub_protocol::relay::{
    MAX_RELAY_FRAME_BYTES, RELAY_PROTOCOL_VERSION, RelayAnswer, RelayChallenge, RelayControlEvent,
    RelayHello, RelayProof, RelayRejection, RelayRole, RelayUnavailable, encode_nonce,
};
use ring::rand::{SecureRandom as _, SystemRandom};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 동시에 다루는 연결의 상한.
///
/// 넘으면 **받자마자 닫는다**. 대기열에 쌓지 않는 이유: 쌓아 두면 메모리로 같은
/// 문제가 되고, 폰은 다시 붙으면 그만이다. 데스크탑 허브의 accept 루프가 같은
/// 이유로 같은 모양을 쓴다.
pub const MAX_CONNECTIONS: usize = 512;

/// 등록을 마치기까지 주는 시간. 인증 전 연결이 살아 있을 수 있는 총 시간이다.
pub const REGISTRATION_BUDGET: Duration = Duration::from_secs(15);

/// 지문을 고정해 둘 수 있는 `server_id` 의 수.
///
/// **이 표는 연결이 끊겨도 지워지지 않는다.** 그래야 노트북이 잠깐 꺼진 사이에
/// 다른 인증서가 그 자리를 가져가지 못한다. 그런데 등록에 필요한 것은 자기가
/// 만든 자체 서명 인증서와 서명뿐이라 — 인증이 아니라 소지 증명이다 — 아무나
/// 임의의 `server_id` 로 항목을 하나씩 영구히 더할 수 있다. 배포된 머신은
/// 256MB 다(`crates/dure-relay/fly.toml`).
///
/// Refuse new server IDs at capacity without evicting existing pins. Eviction
/// could let another registrant claim a pinned identity. This limit bounds
/// memory; it does not grant retirement authority.
///
/// 값은 실제 사용량보다 훨씬 크고 메모리로는 몇 MB 수준이다. 여기에 닿는다는
/// 것은 남용이거나 이 제품이 예상보다 훨씬 커졌다는 뜻이고, 둘 다 사람이 봐야
/// 하는 일이라 로그를 남긴다.
pub const MAX_PINNED_SERVERS: usize = 10_000;

// 배포되는 값이 실제 규모보다 훨씬 크고, 256MB 안에 머무는지.
//
// 시험이 아니라 컴파일 타임 단언이다 — 상수에 대한 사실이라 실행할 것이 없고,
// 잘못 고치면 시험이 빨개지는 것보다 빌드가 멈추는 편이 빠르다. 가득 찬 표의
// **동작**은 `a_full_pin_table_refuses_a_new_server` 가 상한 1 로 확인한다.
const _: () = assert!(MAX_PINNED_SERVERS >= 1_000);
const _: () = assert!(MAX_PINNED_SERVERS <= 100_000);

/// 폰이 왔다고 알린 뒤 허브의 데이터 연결을 기다리는 시간.
///
/// 노트북이 깨어나는 시간이 아니라 **이미 control 연결을 들고 있는** 허브가
/// 소켓 하나를 여는 시간이다. 길게 잡으면 잠든 노트북 뒤에서 폰이 오래 멈춘다.
pub const PAIR_TIMEOUT: Duration = Duration::from_secs(10);

/// control 연결에 쓸 때의 상한. 막힌 허브가 폰의 스레드를 잡아 두지 못하게.
const CONTROL_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// 조용한 control 연결에 아무 일도 없다는 말을 보내는 주기.
///
/// 프록시의 유휴 타임아웃보다 넉넉히 짧아야 한다. PaaS 들이 흔히 쓰는 값이
/// 분 단위라 60초로 잡았다 — 이 값을 늘리려면 어느 플랫폼 뒤에 두는지 알고
/// 늘려야 하고, 모르면 줄이는 쪽이 안전하다.
const CONTROL_PING_INTERVAL: Duration = Duration::from_secs(60);

/// 이어진 뒤 한 방향이 조용할 수 있는 시간.
///
/// 붙어서 보고만 있는 폰은 조용한 것이 정상이므로 넉넉하다. 그래도 상한이
/// 있어야 반쯤 열린 소켓(iOS 는 앱을 정지시키면서 소켓을 닫지 않는다)이 이
/// 프로세스의 스레드를 영원히 잡지 않는다.
const PIPE_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// 릴레이 하나의 상태 전부.
pub struct Relay {
    /// 지금 control 연결을 들고 있는 허브들.
    live: Mutex<HashMap<String, LiveHub>>,
    /// `server_id` 에 처음 등록한 인증서의 지문. 허브가 끊겨도 남는다 —
    /// 남지 않으면 잠깐 꺼진 사이에 다른 인증서가 그 자리를 가져간다.
    pins: Mutex<HashMap<String, String>>,
    /// 폰이 와서 허브의 데이터 연결을 기다리는 자리들.
    pending: Mutex<HashMap<String, Sender<TcpStream>>>,
    connections: AtomicUsize,
    /// 등록마다 하나씩 나가는 번호. 아래 `LiveHub::generation` 참조.
    generations: AtomicUsize,
    /// 고정할 수 있는 `server_id` 의 수. 기본은 [`MAX_PINNED_SERVERS`].
    pin_limit: usize,
}

impl Default for Relay {
    fn default() -> Self {
        Self {
            live: Mutex::default(),
            pins: Mutex::default(),
            pending: Mutex::default(),
            connections: AtomicUsize::default(),
            generations: AtomicUsize::default(),
            pin_limit: MAX_PINNED_SERVERS,
        }
    }
}

struct LiveHub {
    /// control 소켓의 복제본. 다른 스레드가 `Incoming` 을 쓴다.
    control: Arc<Mutex<TcpStream>>,
    /// 이 등록이 몇 번째인지.
    ///
    /// **끊김을 알아챈 스레드가 자기 것만 지우게 하는 값이다.** 노트북이
    /// 네트워크를 바꾸면 릴레이에는 반쯤 열린 control 소켓이 남는다. 허브 쪽
    /// 침묵 상한(180초)이 먼저 울려 노트북은 재접속하고 새 등록이 이 자리를
    /// 대신하는데, 몇 분 뒤 TCP 가 마침내 포기하면 **옛 스레드가 깨어나** 같은
    /// `server_id` 를 지운다. 그 시점의 등록은 멀쩡한 새 것이다.
    ///
    /// 그러면 허브는 등록돼 있다고 믿고(자기 control 소켓은 건강하고 ping 도
    /// 받는다) 릴레이는 모른다고 답한다. 폰에는 "컴퓨터가 꺼져 있습니다" 만
    /// 뜨고, 사용자가 앱을 재시작하기 전까지 아무도 회복시키지 않는다.
    generation: usize,
}

impl Relay {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 고정 표의 상한을 정해서 만든다.
    ///
    /// 운영에서 값을 바꿀 일은 드물다. 이것이 있는 진짜 이유는 **가득 찬 표의
    /// 동작을 시험할 수 있게** 하는 것이다 — 기본값으로 그것을 확인하려면 만
    /// 번의 등록이 필요하고, 그러면 아무도 그 경로를 시험하지 않게 된다.
    #[must_use]
    pub fn with_pin_limit(pin_limit: usize) -> Self {
        Self {
            pin_limit,
            ..Self::default()
        }
    }

    /// 지금 등록되어 있는 기계 수. 운영 확인용.
    #[must_use]
    pub fn live_hub_count(&self) -> usize {
        self.live.lock().map_or(0, |live| live.len())
    }

    /// 이 `server_id` 에 고정된 지문. 시험과 운영 확인용.
    #[must_use]
    pub fn pinned_fingerprint(&self, server_id: &str) -> Option<String> {
        self.pins
            .lock()
            .ok()
            .and_then(|pins| pins.get(server_id).cloned())
    }
}

/// 받는다. 끝나지 않는다.
pub fn serve(listener: &TcpListener, relay: &Arc<Relay>) {
    for incoming in listener.incoming() {
        let Ok(stream) = incoming else { continue };

        if relay.connections.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
            relay.connections.fetch_sub(1, Ordering::AcqRel);
            // 받자마자 닫는다. 이유를 말해 주려면 프레임을 하나 써야 하고,
            // 그것은 상한에 걸린 상황에서 하려는 일이 아니다.
            let _ = stream.shutdown(Shutdown::Both);
            continue;
        }

        let relay = Arc::clone(relay);
        std::thread::spawn(move || {
            serve_one(stream, &relay);
            relay.connections.fetch_sub(1, Ordering::AcqRel);
        });
    }
}

/// 붙은 소켓 하나. 인사를 읽고 역할에 따라 갈린다.
pub fn serve_one(stream: TcpStream, relay: &Arc<Relay>) {
    // BSD 계열에서 `accept` 는 리스너의 논블로킹을 물려받는다. 되돌리지 않으면
    // 첫 `read` 가 `WouldBlock` 으로 즉시 실패하고, 저쪽에서는 "붙자마자
    // 끊긴다" 로만 보인다 — 데스크탑 허브가 같은 함정을 적어 두었다.
    if stream.set_nonblocking(false).is_err() {
        return;
    }
    let _ = stream.set_read_timeout(Some(REGISTRATION_BUDGET));
    let _ = stream.set_write_timeout(Some(CONTROL_WRITE_TIMEOUT));

    let mut stream = stream;
    let Ok(hello) = read_frame::<RelayHello>(&mut stream) else {
        return;
    };
    if hello.relay_protocol_version != RELAY_PROTOCOL_VERSION {
        let _ = write_frame(
            &mut stream,
            &RelayControlEvent::Rejected {
                reason: RelayRejection::UnsupportedVersion,
            },
        );
        return;
    }

    match hello.role {
        RelayRole::HubControl => serve_hub_control(stream, &hello.server_id, relay),
        RelayRole::HubData => serve_hub_data(stream, &hello, relay),
        RelayRole::Client => serve_client(stream, &hello.server_id, relay),
    }
}

/// 허브의 control 연결. 등록하고, 끊길 때까지 산다.
fn serve_hub_control(mut stream: TcpStream, server_id: &str, relay: &Arc<Relay>) {
    let mut nonce = [0u8; 32];
    if SystemRandom::new().fill(&mut nonce).is_err() {
        return;
    }
    if write_frame(
        &mut stream,
        &RelayChallenge {
            relay_protocol_version: RELAY_PROTOCOL_VERSION,
            nonce: encode_nonce(&nonce),
        },
    )
    .is_err()
    {
        return;
    }

    let Ok(submitted) = read_frame::<RelayProof>(&mut stream) else {
        return;
    };
    let verified = match proof::verify(server_id, &nonce, &submitted) {
        Ok(verified) => verified,
        Err(reason) => {
            let _ = write_frame(&mut stream, &RelayControlEvent::Rejected { reason });
            return;
        }
    };

    // TOFU. 처음 등록한 인증서가 그 `server_id` 를 갖는다.
    {
        let Ok(mut pins) = relay.pins.lock() else {
            return;
        };
        match pins.get(server_id) {
            Some(pinned) if pinned != &verified.fingerprint => {
                drop(pins);
                let _ = write_frame(
                    &mut stream,
                    &RelayControlEvent::Rejected {
                        reason: RelayRejection::FingerprintChanged,
                    },
                );
                return;
            }
            Some(_) => {}
            None if pins.len() >= relay.pin_limit => {
                drop(pins);
                // 조용히 거절하지 않는다. 이 상한에 닿는 것은 남용이거나 이
                // 제품이 예상보다 커졌다는 뜻이고, 둘 다 사람이 봐야 한다 —
                // 그리고 이 프로세스의 상태는 전부 휘발성이라 로그 말고는
                // 나중에 알아낼 방법이 없다.
                eprintln!(
                    "[relay] 고정 표가 가득 찼습니다({}). 새 server_id 등록을 거절합니다",
                    relay.pin_limit
                );
                let _ = write_frame(
                    &mut stream,
                    &RelayControlEvent::Rejected {
                        reason: RelayRejection::TooManyConnections,
                    },
                );
                return;
            }
            None => {
                pins.insert(server_id.to_string(), verified.fingerprint.clone());
            }
        }
    }

    let Ok(writable) = stream.try_clone() else {
        return;
    };
    // 등록 이후에는 조용한 것이 정상이다. 마감은 증명 전까지만 걸린다 —
    // 데스크탑 허브가 인증 경계에서 같은 판단을 한다.
    let _ = stream.set_read_timeout(None);
    let control = Arc::new(Mutex::new(writable));
    let generation = relay.generations.fetch_add(1, Ordering::Relaxed);
    {
        let Ok(mut live) = relay.live.lock() else {
            return;
        };
        live.insert(
            server_id.to_string(),
            LiveHub {
                control: Arc::clone(&control),
                generation,
            },
        );
    }
    if write_frame(&mut stream, &RelayControlEvent::Registered).is_err() {
        remove_live(relay, server_id, generation);
        return;
    }

    // 조용한 연결에 주기적으로 말을 건다. 이유는 `CONTROL_PING_INTERVAL` 과
    // `RelayControlEvent::Ping` 에 있다.
    let alive = Arc::new(AtomicBool::new(true));
    spawn_pinger(&control, &alive);

    // 이 스레드의 남은 일은 **끊김을 알아채는 것**뿐이다.
    //
    // 읽기 한 번이면 된다. 마감을 벗겨 두었으므로 이 `read` 는 끊길 때까지
    // 블록하고, 허브는 control 로 아무것도 보내지 않으므로 깨어나는 경우는
    // 셋뿐이다: EOF, 오류, 그리고 프로토콜에 없는 바이트. 셋 다 이 연결이
    // 끝났다는 뜻이라 루프로 감쌀 이유가 없다 — 감싸면 모든 갈래가 `break` 인
    // 루프가 되어, 읽는 사람이 재시도가 있는 줄 알게 된다.
    let mut scratch = [0u8; 64];
    let _ = stream.read(&mut scratch);
    alive.store(false, Ordering::Release);
    remove_live(relay, server_id, generation);
}

/// 조용한 control 연결에 주기적으로 ping 을 보낸다.
///
/// 짧게 자며 깃발을 본다. 한 번에 `CONTROL_PING_INTERVAL` 만큼 자면 허브가
/// 끊긴 뒤에도 그만큼 스레드가 남고, 노트북이 잦게 붙었다 끊기는 네트워크에서는
/// 그 스레드가 쌓인다.
fn spawn_pinger(control: &Arc<Mutex<TcpStream>>, alive: &Arc<AtomicBool>) {
    let control = Arc::clone(control);
    let alive = Arc::clone(alive);
    std::thread::spawn(move || {
        let tick = Duration::from_secs(1);
        let mut slept = Duration::ZERO;
        while alive.load(Ordering::Acquire) {
            std::thread::sleep(tick);
            slept += tick;
            if slept < CONTROL_PING_INTERVAL {
                continue;
            }
            slept = Duration::ZERO;

            let Ok(mut control) = control.lock() else {
                return;
            };
            // 쓰기가 실패하면 저쪽은 이미 갔다. control 스레드가 곧 같은 것을
            // 알아채고 등록을 지우므로 여기서는 물러나기만 한다.
            if write_frame(&mut control, &RelayControlEvent::Ping).is_err() {
                return;
            }
        }
    });
}

/// 이 등록을 지운다. **다른 세대가 그 자리에 있으면 손대지 않는다.**
///
/// 지우는 쪽이 자기 세대를 들고 오는 것이 이 함수의 전부다. `server_id` 만으로
/// 지우면 늦게 깨어난 옛 스레드가 멀쩡한 새 등록을 지우고, 그 뒤로 아무도
/// 회복시키지 않는다 — 자세한 것은 [`LiveHub::generation`].
fn remove_live(relay: &Arc<Relay>, server_id: &str, generation: usize) {
    if let Ok(mut live) = relay.live.lock() {
        if live
            .get(server_id)
            .is_some_and(|hub| hub.generation == generation)
        {
            live.remove(server_id);
        }
    }
}

/// 폰. 자리를 하나 만들고 허브를 부른 뒤 기다린다.
fn serve_client(mut stream: TcpStream, server_id: &str, relay: &Arc<Relay>) {
    let control = {
        let Ok(live) = relay.live.lock() else { return };
        live.get(server_id).map(|hub| Arc::clone(&hub.control))
    };
    let Some(control) = control else {
        // 등록된 적조차 없는 것과 지금 꺼져 있는 것을 구별해 답한다. 구별하지
        // 않으면 폰이 "컴퓨터가 꺼져 있습니다" 를 말할 수 없다 — 그 문장은
        // 밖에서 폰을 꺼낸 사람이 가장 먼저 알아야 하는 것이다.
        let known = relay.pinned_fingerprint(server_id).is_some();
        let _ = write_frame(
            &mut stream,
            &RelayAnswer::Unavailable {
                reason: if known {
                    RelayUnavailable::Offline
                } else {
                    RelayUnavailable::Unknown
                },
            },
        );
        return;
    };

    let Some(connection_id) = fresh_id() else {
        return;
    };
    let (sender, receiver): (Sender<TcpStream>, Receiver<TcpStream>) = channel();
    {
        let Ok(mut pending) = relay.pending.lock() else {
            return;
        };
        pending.insert(connection_id.clone(), sender);
    }

    let called = call_hub(&control, &connection_id);
    if called.is_err() {
        forget_pending(relay, &connection_id);
        let _ = write_frame(
            &mut stream,
            &RelayAnswer::Unavailable {
                reason: RelayUnavailable::Offline,
            },
        );
        return;
    }

    let hub_stream = match receiver.recv_timeout(PAIR_TIMEOUT) {
        Ok(hub_stream) => hub_stream,
        Err(_) => {
            forget_pending(relay, &connection_id);
            let _ = write_frame(
                &mut stream,
                &RelayAnswer::Unavailable {
                    reason: RelayUnavailable::Timeout,
                },
            );
            return;
        }
    };
    // 자리는 한 번만 쓰인다. 여기까지 왔으면 데이터 연결이 이미 가져갔지만,
    // 실패 경로에서 남을 수 있으므로 확실히 지운다.
    forget_pending(relay, &connection_id);

    let mut hub_stream = hub_stream;
    // 양쪽에 "여기부터 바이트다" 를 알린다. 순서가 중요하다 — 허브 쪽을 먼저
    // 풀어 주면 폰이 아직 이 프레임을 읽기 전에 TLS 첫 바이트가 도착한다.
    // 그래도 깨지지 않지만(스트림이므로), 폰의 파서가 프레임 하나를 읽고
    // 넘어가는 모양이라 경계가 흐려진다.
    if write_frame(&mut stream, &RelayAnswer::Paired).is_err()
        || write_frame(&mut hub_stream, &RelayAnswer::Paired).is_err()
    {
        return;
    }

    pipe(stream, hub_stream);
}

/// 허브의 데이터 연결. 자리를 찾아 자기 소켓을 넘기고 물러난다.
fn serve_hub_data(stream: TcpStream, hello: &RelayHello, relay: &Arc<Relay>) {
    let Some(connection_id) = hello.connection_id.as_deref() else {
        return;
    };
    let sender = {
        let Ok(mut pending) = relay.pending.lock() else {
            return;
        };
        pending.remove(connection_id)
    };
    let Some(sender) = sender else {
        // 없는 자리다 — 만료됐거나, 이미 쓰였거나, 지어낸 값이다. 셋을
        // 구별해 답하지 않는다: 구별해 주면 `connection_id` 를 찍어 보는 쪽이
        // 어느 값이 살아 있었는지 알게 된다.
        return;
    };
    // 이 소켓의 주인이 폰 스레드로 넘어간다. 실패하면 폰이 이미 포기한 것이다.
    let _ = sender.send(stream);
}

/// 등록된 허브에게 폰이 왔다고 알린다.
fn call_hub(control: &Arc<Mutex<TcpStream>>, connection_id: &str) -> Result<(), FrameError> {
    let mut control = control
        .lock()
        .map_err(|_| FrameError::Truncated("control 연결이 망가졌습니다"))?;
    write_frame(
        &mut control,
        &RelayControlEvent::Incoming {
            connection_id: connection_id.to_string(),
        },
    )
}

fn forget_pending(relay: &Arc<Relay>, connection_id: &str) {
    if let Ok(mut pending) = relay.pending.lock() {
        pending.remove(connection_id);
    }
}

/// 추측할 수 없는 값 하나. 소지가 곧 자격이므로 이것이 약하면 전부 약해진다.
fn fresh_id() -> Option<String> {
    let mut bytes = [0u8; 16];
    SystemRandom::new().fill(&mut bytes).ok()?;
    Some(encode_nonce(&bytes))
}

/// 두 소켓을 잇는다. 여기서부터 이 프로세스는 내용을 보지 않는다.
fn pipe(client: TcpStream, hub: TcpStream) {
    let (Ok(client_read), Ok(hub_read)) = (client.try_clone(), hub.try_clone()) else {
        return;
    };
    for stream in [&client, &hub, &client_read, &hub_read] {
        let _ = stream.set_read_timeout(Some(PIPE_IDLE_TIMEOUT));
        let _ = stream.set_write_timeout(Some(PIPE_IDLE_TIMEOUT));
    }

    let upward = std::thread::spawn(move || {
        copy_until_done(client_read, hub);
    });
    copy_until_done(hub_read, client);
    let _ = upward.join();
}

/// 한 방향. 끝나면 **양쪽을 닫는다**.
///
/// 한쪽만 닫으면 반대 방향 스레드가 상한까지 살아 있고, 그동안 이 쌍이 자리를
/// 차지한다. 터미널 연결은 한 방향이 끝나면 반대도 쓸모가 없다.
fn copy_until_done(mut from: TcpStream, mut to: TcpStream) {
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match from.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if to.write_all(&buffer[..read]).is_err() || to.flush().is_err() {
                    break;
                }
            }
        }
    }
    let _ = from.shutdown(Shutdown::Both);
    let _ = to.shutdown(Shutdown::Both);
}

fn read_frame<T: serde::de::DeserializeOwned>(stream: &mut TcpStream) -> Result<T, FrameError> {
    frame::read(stream, MAX_RELAY_FRAME_BYTES)
}

fn write_frame<T: serde::Serialize>(stream: &mut TcpStream, value: &T) -> Result<(), FrameError> {
    let framed = frame::encode(value, MAX_RELAY_FRAME_BYTES)?;
    stream
        .write_all(&framed)
        .and_then(|()| stream.flush())
        .map_err(|_| FrameError::Truncated("프레임을 다 쓰지 못했습니다"))
}
