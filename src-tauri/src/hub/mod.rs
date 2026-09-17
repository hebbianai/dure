//! 폰이 붙는 허브. 이 앱이 서버다.
//!
//! SSH 가 아니라 앱이 리스너를 띄우는 이유는 제품이 시스템 스위치(원격 로그인)를
//! 켜라고 요구하지 않기 위해서다. 대신 sshd 가 공짜로 주던 두 가지를 우리가
//! 진다 — 기계의 신원과 기기의 인증. 둘 다 [`identity`] 에 있다.
//!
//! HTTP 를 쓰지 않는다. 터미널은 스트림이고, 우리에게는 이미 어떤 바이트
//! 스트림 위에서든 도는 프레임 프로토콜이 있다(전송 계층 attestation 작업의
//! 결과다). TLS 소켓 위에 그 프레임을 그대로 얹는 것이 HTTP 나 WebSocket 을
//! 하나 더 배우는 것보다 단순하고, 폰 쪽 파서도 이미 있다.

mod autostart;
pub mod push;
pub mod catalog;
pub mod file_diff;
pub mod session_file;
pub mod folder_browser;
pub mod git_status;
pub mod start_agent;
pub mod roundtrip;
pub mod layout;
pub mod commands;
pub mod devices;
pub mod identity;
pub mod listener;
pub mod pairing;
pub mod relay_dial;
pub mod server;
