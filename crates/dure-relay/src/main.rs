//! 릴레이 하나를 띄운다.
//!
//! 설정은 환경변수 두 개뿐이다. 설정 파일을 두지 않는 이유: 이 프로세스가 가진
//! 상태는 전부 휘발성이고(등록은 연결이 끊기면 사라진다), 재시작이 정상 동작의
//! 일부다. 읽을 파일이 있으면 그 파일이 진실인 줄 알게 된다.

use dure_relay::{MAX_CONNECTIONS, Relay, serve};
use std::net::TcpListener;
use std::sync::Arc;

fn main() -> std::process::ExitCode {
    // 기본값은 모든 인터페이스다. 이 프로세스의 존재 이유가 바깥에서 오는
    // 연결을 받는 것이므로, 루프백 기본값은 조용히 아무도 못 붙는 배포를 만든다.
    let address = std::env::var("DURE_RELAY_ADDRESS").unwrap_or_else(|_| "0.0.0.0".to_string());
    let port = std::env::var("DURE_RELAY_PORT").unwrap_or_else(|_| "8787".to_string());

    let Ok(port) = port.parse::<u16>() else {
        eprintln!("[relay] DURE_RELAY_PORT 가 포트가 아닙니다: {port}");
        return std::process::ExitCode::FAILURE;
    };

    let listener = match TcpListener::bind((address.as_str(), port)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[relay] {address}:{port} 에 바인드하지 못했습니다: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };

    // 실제로 잡힌 주소를 찍는다. 요청한 포트가 0 이면 OS 가 고른 값이 여기 있고,
    // 배포 로그에서 그 값을 볼 수 없으면 붙을 곳을 알 수 없다.
    match listener.local_addr() {
        Ok(bound) => println!("[relay] {bound} 에서 받는 중 (동시 연결 상한 {MAX_CONNECTIONS})"),
        Err(error) => eprintln!("[relay] 바인드된 주소를 읽지 못했습니다: {error}"),
    }

    serve(&listener, &Arc::new(Relay::new()));
    std::process::ExitCode::SUCCESS
}
