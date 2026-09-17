//! 지금 떠 있는 허브에 붙어, 폰이 받는 것을 **그대로** 찍는다.
//!
//! 폰에서 목록이 비어 보일 때 어디가 비었는지 가르는 도구다. 카탈로그가 빈
//! 것인지, 자리표가 안 온 것인지, 온 자리표가 세션 id 와 안 맞는 것인지는
//! 화면만 봐서는 구별되지 않는다.
//!
//! ```sh
//! cargo run --example hub_probe -- <endpoint> <SHA256:지문> <토큰>
//! ```
//!
//! 지문은 인증서에서 뽑는다:
//!
//! ```sh
//! echo | openssl s_client -connect <endpoint> 2>/dev/null \
//!   | openssl x509 -outform DER | openssl dgst -sha256 -binary | openssl base64
//! ```
//!
//! 토큰은 노트북 앱의 `hub-devices.json` 에 있다.

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(endpoint), Some(fingerprint), Some(token)) = (args.next(), args.next(), args.next())
    else {
        eprintln!("usage: hub_probe <endpoint> <fingerprint> <token>");
        std::process::exit(2);
    };

    match dure_mobile_lib::hub_client::fetch_catalog(&endpoint, None, &fingerprint, &token) {
        Ok((ack, catalog)) => {
            println!("device_label: {}", ack.device_label);
            println!("catalog_version: {}", catalog.hub_catalog_version);
            println!("sessions: {}", catalog.sessions.len());
            for entry in catalog.sessions.iter() {
                println!(
                    "  {} | {} | {} | run={} | {}",
                    entry.session_id,
                    entry.session_name.as_deref().unwrap_or("-"),
                    entry.lifecycle,
                    entry.launch_program.as_deref().unwrap_or("-"),
                    entry.box_label
                );
            }
            match &catalog.layout {
                None => println!("layout: (없음 — 화면이 아직 안 보냈다)"),
                Some(layout) => {
                    println!("layout.desktop_order: {:?}", layout.desktop_order);
                    println!("layout.placements: {}", layout.placements.len());
                    for (session_id, seat) in layout.placements.iter().take(40) {
                        println!(
                            "  {session_id} -> {} / {} #{}",
                            seat.desktop, seat.project, seat.order
                        );
                    }
                    // 이것이 이 도구의 요점이다. 둘 다 비어 있지 않은데 겹치는
                    // 것이 0 이면 폰은 아무것도 그리지 않는다.
                    let matched = catalog
                        .sessions
                        .iter()
                        .filter(|entry| layout.placements.contains_key(&entry.session_id))
                        .count();
                    println!("겹치는 세션: {matched} / {}", catalog.sessions.len());
                }
            }
            for unreachable in &catalog.unreachable {
                println!(
                    "unreachable: {} — {}",
                    unreachable.box_label, unreachable.detail
                );
            }
        }
        Err(error) => {
            eprintln!("실패: {error}");
            std::process::exit(1);
        }
    }
}
