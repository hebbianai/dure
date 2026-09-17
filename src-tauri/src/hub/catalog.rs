//! 인증을 통과한 폰에게 무엇을 말해 주는지.
//!
//! # 허용 목록이 요점이다
//!
//! `SessionDescriptor` 를 그대로 직렬화하지 않는다. 필드를 하나씩 옮겨 적는다 —
//! 매니페스트에 필드가 하나 늘어날 때 그것이 폰으로 조용히 새어 나가는 대신,
//! 여기 한 줄을 더하는 **보이는 편집**이 되어야 한다. `hmux mobile-gateway` 가
//! 같은 이유로 같은 모양을 쓰고, 두 목록은 같은 것을 담는다.
//!
//! 특히 나가지 않는 것: `capability_token`(Host 에 붙는 자격증명), 소켓 경로,
//! pid. 앞의 것은 비밀이고, 뒤의 둘은 폰의 커널에서 아무 뜻도 없다.
//!
//! # 왜 fence 성분은 전부 나가나
//!
//! `runner_instance`, `channel_epoch`, `host_instance_id`, `terminal_epoch` 은
//! 비밀이 아니라 **좌표**다. 폰이 attach 할 때 이 값들로 `expected_fence` 를
//! 만들어야 Host 가 받아들이고, Host 가 교체되면 값이 움직여 낡은 시도가
//! 거부된다. 빼면 폰은 붙을 수 없다.

use hmux_client::SessionDescriptor;

// 나가는 문서의 **모양**은 `dure-hub-protocol` 이 소유한다. 폰이 같은 모양을
// 읽어야 하고, 폰은 이 크레이트를 링크할 수 없기 때문이다(그쪽 머리말 참조).
// 여기 남는 것은 hmux 서술자를 그 모양으로 옮기는 일뿐 — 그 변환은 hmux 타입을
// 알아야 하고, 프로토콜 크레이트는 그것을 알지 않는다.
pub use dure_hub_protocol::catalog::{
    HUB_CATALOG_VERSION, HubCatalog, HubCatalogEntry, UnreachableBox, encode,
};

/// 서술자 하나를 폰이 볼 형태로.
///
/// `String` 으로 복사하는 이유: 이 문서는 여러 상자의 결과를 모아 만들어지고,
/// 원본 서술자는 각 상자의 응답과 함께 사라진다. 빌림으로 두면 수명이 그 응답에
/// 묶여 합치는 쪽이 복잡해진다.
#[must_use]
pub fn entry_from(
    descriptor: &SessionDescriptor,
    box_id: &str,
    box_label: &str,
) -> HubCatalogEntry {
    HubCatalogEntry {
        session_id: descriptor.session_id.clone(),
        session_name: descriptor.session_name.clone(),
        display_title: None,
        presentation: None,
        workspace_id: descriptor.workspace_id.clone(),
        session_class: serialized_name(&descriptor.session_class),
        lifecycle: serialized_name(&descriptor.lifecycle),
        provider_id: descriptor.provider_id.clone(),
        runner_principal: descriptor.runner_principal.clone(),
        runner_instance: descriptor.runner_instance.clone(),
        channel_epoch: descriptor.channel_epoch.clone(),
        host_instance_id: descriptor.host_instance_id.clone(),
        terminal_epoch: descriptor.terminal_epoch.clone(),
        capabilities: descriptor.capabilities.clone(),
        launch_program: descriptor.launch_program.clone(),
        box_id: box_id.to_string(),
        box_label: box_label.to_string(),
    }
}

#[must_use]
pub fn remote_entry_from(
    descriptor: &hmux_ssh_transport::RemoteCatalogSession,
    box_id: &str,
    box_label: &str,
) -> HubCatalogEntry {
    HubCatalogEntry {
        session_id: descriptor.session_id.clone(),
        session_name: descriptor.session_name.clone(),
        display_title: None,
        presentation: None,
        workspace_id: descriptor.workspace_id.clone(),
        session_class: serialized_name(&descriptor.session_class),
        lifecycle: serialized_name(&descriptor.lifecycle),
        provider_id: descriptor.provider_id.clone(),
        runner_principal: descriptor.runner_principal.clone(),
        runner_instance: descriptor.runner_instance.clone(),
        channel_epoch: descriptor.channel_epoch.clone(),
        host_instance_id: descriptor.host_instance_id.clone(),
        terminal_epoch: descriptor.terminal_epoch.clone(),
        capabilities: descriptor.capabilities.clone(),
        launch_program: descriptor.launch_program.clone(),
        box_id: box_id.to_string(),
        box_label: box_label.to_string(),
    }
}

/// hmux 가 이 값에 붙인 직렬화 이름.
///
/// 열거형을 JSON 으로 한 번 굽고 문자열을 꺼낸다. 우회처럼 보이지만 요점이
/// 있다: 이름을 정하는 곳이 hmux 하나로 남는다. 손으로 `match` 를 쓰면 변종이
/// 하나 늘 때 이 앱이 다른 이름을 붙이거나 컴파일이 멈추는데, 후자가 나아 보여도
/// 이 파일은 이름을 정할 권한이 없는 곳이다.
///
/// 문자열이 아닌 값이 나오면 — 열거형이 구조체 변종을 갖게 되면 — 그대로 JSON
/// 표기를 쓴다. 그건 프로토콜이 바뀐 것이고 폰 쪽에서 모르는 값으로 보이는 편이,
/// 여기서 조용히 빈 문자열이 되는 것보다 낫다.
fn serialized_name<T: serde::Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(name)) => name,
        Ok(other) => other.to_string(),
        Err(error) => format!("<Serialization failed: {error}>"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;



    /// `SessionDescriptor` 는 `Deserialize` 가 아니라 구조체 리터럴로 만든다.
    ///
    /// 이게 오히려 낫다: 매니페스트에 필드가 하나 늘면 이 픽스처가 컴파일되지
    /// 않고, 그때 위 허용 목록을 다시 보게 된다. JSON 픽스처였다면 새 필드는
    /// 조용히 무시되고, 그 필드가 비밀이어도 아무도 묻지 않는다.
    fn descriptor() -> SessionDescriptor {
        SessionDescriptor {
            launch_program: None,
            schema_version: 1,
            session_id: "standalone_abc".into(),
            session_name: Some("feat/mobile".into()),
            workspace_id: "workspace_1".into(),
            session_class: hmux_client::SessionClass::Standalone,
            lifecycle: hmux_client::SessionLifecycle::Ready,
            provider_id: "claude-code".into(),
            runtime_host: None,
            worktree_alias: None,
            branch: None,
            runner_principal: "local-user".into(),
            runner_instance: "runner_1".into(),
            channel_epoch: "1".into(),
            host_instance_id: "host_1".into(),
            terminal_epoch: "terminal_1".into(),
            output_seq: "0".into(),
            host_build_version: "0.1.4".into(),
            supported_protocol: hmux_client::VersionRange {
                minimum: hmux_client::ProtocolVersion { major: 1, minor: 0 },
                maximum: hmux_client::ProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: vec!["live_output".into(), "screen_snapshot".into()],
            retirement_policy: None,
            host_process: hmux_client::ProcessDescriptor {
                process_id: 4242,
                start_marker: "4242-1".into(),
            },
            provider_process: hmux_client::ProcessDescriptor {
                process_id: 4243,
                start_marker: "4243-1".into(),
            },
            // 소켓 주소는 폰의 커널에서 아무 뜻도 없다. 나가지 않는 것을
            // 아래 시험이 확인한다.
            endpoint: hmux_client::EndpointDescriptor {
                kind: hmux_client::EndpointKind::UnixSocket,
                address: "/tmp/hmux/abc.sock".into(),
            },
            created_unix_ms: "1".into(),
            lifecycle_changed_unix_ms: "1".into(),
            exit: None,
            failure: None,
        }
    }

    #[test]
    fn a_session_carries_the_coordinates_a_phone_needs_to_attach() {
        let entry = entry_from(&descriptor(), "this-laptop", "이 노트북");

        // fence 성분이 전부 있어야 폰이 expected_fence 를 만들 수 있다.
        assert_eq!(entry.runner_instance, "runner_1");
        assert_eq!(entry.channel_epoch, "1");
        assert_eq!(entry.host_instance_id, "host_1");
        assert_eq!(entry.terminal_epoch, "terminal_1");
        assert_eq!(entry.runner_principal, "local-user");
        // 그리고 어느 상자인지.
        assert_eq!(entry.box_id, "this-laptop");
        assert_eq!(entry.box_label, "이 노트북");
    }

    /// 이 시험이 이 모듈의 존재 이유다. 서술자를 그대로 직렬화했다면 토큰과
    /// 소켓 경로와 pid 가 함께 나간다.
    #[test]
    fn the_secret_and_the_meaningless_never_leave() {
        let catalog = HubCatalog {
            hub_catalog_version: HUB_CATALOG_VERSION,
            layout: None,
            sessions: vec![entry_from(&descriptor(), "this-laptop", "이 노트북")],
            unreachable: Vec::new(),
        };

        let framed = encode(&catalog).expect("직렬화");
        let rendered = String::from_utf8_lossy(&framed);

        // 값과 필드 이름 양쪽을 본다 — 이름만 검사하면 값이 다른 필드에 담겨
        // 나가는 것을 놓치고, 값만 검사하면 빈 필드가 생기는 것을 놓친다.
        // `capability_token` 은 서술자에 아예 없다(따로 읽는다). 그래도
        // 이름을 검사 목록에 남긴다 — 언젠가 서술자에 들어오면 이 시험이
        // 먼저 말하게 하려고.
        for secret in [
            "capability_token",
            "/tmp/hmux/abc.sock",
            "address",
            "4242",
            "host_process",
            "start_marker",
        ] {
            assert!(!rendered.contains(secret), "{secret} 이 새어 나갔다: {rendered}");
        }

        // 긍정 대조: 검색이 실제로 무언가를 찾을 수 있어야 한다. 없으면 위
        // 단언들은 비어 있는 문서에 대해서도 통과한다.
        assert!(rendered.contains("standalone_abc"), "{rendered}");
    }

    #[test]
    fn a_nameless_session_keeps_its_id_rather_than_becoming_null_text() {
        let mut source = descriptor();
        source.session_name = None;

        let entry = entry_from(&source, "b", "B");

        assert_eq!(entry.session_name, None);
        assert_eq!(entry.session_id, "standalone_abc");
    }

    /// 대답하지 못한 상자가 목록에서 조용히 사라지면 없는 상자로 읽힌다.
    #[test]
    fn an_unreachable_box_is_named_in_the_answer() {
        let catalog = HubCatalog {
            hub_catalog_version: HUB_CATALOG_VERSION,
            layout: None,
            sessions: Vec::new(),
            unreachable: vec![UnreachableBox {
                box_id: "gate1".into(),
                box_label: "Gate1".into(),
                detail: "연결하지 못했습니다".into(),
            }],
        };

        let rendered = String::from_utf8_lossy(&encode(&catalog).unwrap()).into_owned();

        assert!(rendered.contains("Gate1"), "{rendered}");
        assert!(rendered.contains("연결하지 못했습니다"), "{rendered}");
    }

    #[test]
    fn the_frame_carries_its_own_length() {
        let catalog = HubCatalog {
            hub_catalog_version: HUB_CATALOG_VERSION,
            layout: None,
            sessions: Vec::new(),
            unreachable: Vec::new(),
        };

        let framed = encode(&catalog).unwrap();

        let length = u32::from_be_bytes(framed[..4].try_into().unwrap()) as usize;
        assert_eq!(length, framed.len() - 4);
        let decoded: HubCatalog = serde_json::from_slice(&framed[4..]).unwrap();
        assert_eq!(decoded.hub_catalog_version, HUB_CATALOG_VERSION);
    }
}
