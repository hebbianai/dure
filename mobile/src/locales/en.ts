/** Canonical English copy. New messages use semantic IDs; legacy source keys remain supported. */
export const en: Record<string, string> = {
  "notifications.push.approvalBody": "An agent is waiting for your approval.",
  "notifications.push.doneBody": "An agent finished its turn.",
  "notifications.push.description": "Receive approval and completion alerts even when Dure is closed. The paired computer must be running Dure.",
  "notifications.push.syncing": "Updating push notifications…",
  "notifications.push.registered": "Push registration saved on the paired computer.",
  "notifications.push.failed": "Push notifications are not ready. {detail}",
  "notifications.push.noComputer": "Connect a computer to receive push notifications.",
  "notifications.push.off": "Push notifications are off.",
  "notifications.local.description": "Only while the app is open.",
  "notifications.permission.denied": "Notifications are not allowed. Enable them in system settings.",
  "notifications.permission.prompt": "Choose an option to request notification permission.",
  "terminal.reconnect.rehostPending": "Session recovery has not finished. Complete it on the computer, then reconnect.",
  "terminal.reconnect.updateRequired": "Update Dure on the computer running this session to reconnect after a host change.",
  "terminal.actions": "Terminal actions",
  "terminal.paste.action": "Paste",
  "terminal.paste.empty": "No text or image to paste",
  "terminal.paste.failed": "Paste was not allowed. Choose Paste again and allow clipboard access.",
  "terminal.paste.unsupportedImage": "This image format cannot be pasted.",
  "terminal.paste.imageTooLarge": "Images must be 10 MB or smaller.",
  "terminal.paste.uploading": "Sending image…",
  "terminal.paste.desktopRequired": "Image paste requires a paired Dure desktop connected to this session.",
  "spaces.empty.noMatches": "No matching spaces",
  "agents.status.approvalRequired": "Approval required",
  "agents.status.awaitingInput": "Awaiting input",
  "agents.status.awaitingResponse": "Waiting for response",
  "agents.status.error": "Error",
  "common.back": "Back",
  "common.close": "Close",
  "common.connecting": "Connecting",
  "common.exited": "Exited",
  "common.space": "Space",
  "common.unknown": "Unknown",
  "common.working": "Working",
  "spaces.group.updatedLastSevenDays": "Last 7 days",
  "spaces.group.updatedOlder": "Older",
  "spaces.group.updatedToday": "Today",
  "spaces.group.updatedYesterday": "Yesterday",
  "spaces.pane.branch": "Branch",
  "spaces.pane.details": "Details",
  "spaces.pane.environment": "Environment",
  "spaces.pane.environmentLocal": "Local",
  "spaces.pane.environmentSsh": "SSH",
  "spaces.pane.filters": "Filters",
  "spaces.pane.gitStatus": "Git status",
  "spaces.pane.groupByRepository": "Repository",
  "spaces.pane.grouping": "Grouping",
  "spaces.pane.location": "Location",
  "spaces.pane.machine": "Machine",
  "spaces.pane.orderByPane": "Pane order",
  "spaces.pane.ordering": "Ordering",
  "spaces.pane.resetFilters": "Reset filters",
  "spaces.pane.show": "Show",
  "spaces.pane.source": "Source",
  "spaces.pane.sourceShell": "Shell",
  "spaces.pane.sourceSsh": "SSH",
  "spaces.pane.status": "Status",
  "spaces.pane.updated": "Updated",
  "spaces.pane.viewOptions": "View options",
  "terminal.input": "Terminal input",
  "terminal.chrome.scrollToBottom": "Scroll to bottom",
  "pairing.error.notCode": "This is not an hmux pairing code",
  "launch.provider.checkOnStart": "Installation on {host} is unknown. It will be checked when you start.",
  "launch.worktree.unsupported": "Worktrees are not supported on this host. Turn this off to start in the original folder.",
  "launch.worktree.originalFolder": "Starts in the original folder. Worktrees are not supported on this host.",
  서버: "Servers",
  세션: "Sessions",
  새로고침: "Refresh",
  "직접 추가": "Add by hand",
  "등록된 서버가 없습니다": "No servers configured",

  // 페어링
  "QR 스캔으로 페어링": "Pair by scanning a QR code",
  "앱을 내려받는 주소입니다. 노트북에서 '이 컴퓨터와 페어링'을 눌러 다음 코드를 띄우세요.":
    "That is the app download address. On the laptop, press 'Pair with this computer' to bring up the next code.",
  "QR 스캔": "Scan QR",
  "페어링 중…": "Pairing…",
  "책상에서 노트북 화면의 QR을 한 번 스캔하면, 이후로는 폰이 서버에 직접 연결합니다.":
    "Scan the QR on your laptop's screen once, at the desk. After that this phone reaches every server directly.",
  "개인키는 이 기기를 떠나지 않지만, 앱 저장소에 평문 파일로 저장됩니다. Secure Enclave/Keystore가 아닙니다.":
    "The private key never leaves this device, but it is stored as a plaintext file in app storage. This is not the Secure Enclave or the Android Keystore.",
  "이 기기 이름": "This device's name",
  "내 폰": "My phone",
  "노트북이 authorized_keys 주석에 적는 이름입니다":
    "The laptop writes this into the authorized_keys comment",
  "코드 직접 붙여넣기": "Paste the code instead",
  "카메라를 쓸 수 없을 때. 노트북이 QR과 같은 내용을 글자로도 보여줍니다.":
    "For when the camera is unavailable. The laptop shows the same content as text next to the QR.",
  "붙여넣은 코드로 페어링": "Pair with the pasted code",
  "이 기기에는 카메라 스캐너가 없습니다 — 아래에 코드를 붙여넣으세요":
    "This build has no camera scanner — paste the code below",
  "카메라 권한이 필요합니다": "Camera permission is required",
  "카메라 권한이 꺼져 있습니다 — 설정 앱에서 켜주세요":
    "Camera permission is off — turn it on in the system settings",
  "서버 {count}대를 등록했습니다 · 기기 키 {algorithm}":
    "Registered {count} servers · device key {algorithm}",
  "이 기기가 쓸 수 없는 서버 {count}대": "{count} servers this device cannot use",
  "기기 id {id} — 노트북에서 `hmux pair revoke`에 씁니다":
    "Device id {id} — pass it to `hmux pair revoke` on the laptop",
  "세션 보기": "Show sessions",
  "연결용 키가 강제 명령에 고정되어 있습니다": "The attach key is pinned to a forced command",
  "연결용 키에 강제 명령이 없습니다 — 이 계정으로 어떤 명령이든 실행할 수 있습니다":
    "The attach key carries no forced command — it can run any command as that account",
  "연결용 키가 어떻게 제한되어 있는지 노트북이 알려주지 않았습니다":
    "The laptop did not say how the attach key is restricted",
  "이 서버의 키는 페어링 때 이 기기에서 만들어졌습니다. 여기서 덮어쓰면 서버에 등록된 키와 어긋납니다.":
    "This server's key was generated on this device during pairing. Overwriting it here will no longer match what is authorized on the server.",

  // 전체 세션 목록
  "등록된 서버 각각의 `hmux mobile-gateway`에 세션 목록을 요청합니다.":
    "Asks each registered server's `hmux mobile-gateway` for its session catalog.",
  "실행 중인 세션이 없습니다": "No sessions are running",
  "대답한 서버가 없습니다 — 아래 이유를 확인하세요": "No server answered — see the reasons below",
  "대답하지 못한 서버 {count}대": "{count} servers did not answer",
  "hmux가 설치되어 있지 않습니다": "hmux is not installed there",
  "이 기기에 연결 정보가 없습니다": "This device has no way to connect",
  "연결하지 못했습니다": "Could not connect",
  "시간이 모자라 물어보지 못했습니다": "Ran out of time before asking",
  이름: "Name",
  호스트: "Host",
  포트: "Port",
  계정: "Account",
  저장: "Save",
  취소: "Cancel",
  삭제: "Delete",
  편집: "Edit",
  키: "Keys",
  "이름을 입력하세요": "Enter a name",
  "호스트를 입력하세요": "Enter a host",
  "계정을 입력하세요": "Enter an account",
  "포트는 숫자여야 합니다": "Port must be a number",
  "포트는 1–65535 범위여야 합니다": "Port must be between 1 and 65535",
  "포트 0은 쓸 수 없습니다": "Port 0 is not usable",
  "지문은 SHA256:로 시작하는 값이어야 합니다": "The fingerprint must start with SHA256:",

  // 서버 목록 줄의 상태
  "SSH 키가 없어 연결할 수 없습니다": "No SSH key — cannot connect",
  "호스트 키 지문이 없어 연결할 수 없습니다": "No host key fingerprint — cannot connect",
  "연결 준비됨 · 목록 조회용 키 별도 등록됨": "Ready · separate key registered for listing",
  "연결 준비됨 · 목록 조회에도 같은 키를 씁니다": "Ready · the same key is used for listing",

  // 키 화면
  "개인키는 앱 저장소에 평문 파일로 저장됩니다. Secure Enclave/Keystore가 아닙니다.":
    "The private key is stored as a plaintext file in app storage. This is not the Secure Enclave or the Android Keystore.",
  "연결용 SSH 개인키": "SSH private key for attaching",
  'authorized_keys에 `command="hmux mobile-gateway",restrict`로 고정하는 키입니다 — 그 계정의 모든 세션에 닿습니다':
    'The key to pin in authorized_keys as `command="hmux mobile-gateway",restrict` — it reaches every session that account owns',
  "목록 조회용 SSH 개인키 (선택)": "SSH private key for listing (optional)",
  "목록 조회는 이제 스트림 요청으로 하므로 별도 키가 필요 없습니다. 손으로 --list를 고정해 둔 서버에만 쓰세요. 비워 두면 연결용 키를 그대로 씁니다.":
    "Listing now travels as a stream request, so it needs no key of its own. Use this only for a server you pinned --list on by hand. Left empty, the attach key is reused.",
  "등록됨 — 새로 붙여넣으면 대체됩니다": "Stored — pasting a new one replaces it",
  "등록되지 않음": "Not stored",
  "키 저장": "Save key",
  "SSH 키": "SSH keys",
  "공개 키": "Public key",
  "호스트가 이 키를 신뢰해야 연결됩니다. ~/.ssh/authorized_keys에 이 줄이 있어야 합니다.":
    "The host must trust this key before it connects. This line has to be in ~/.ssh/authorized_keys.",
  복사: "Copy",
  "복사하지 못했습니다 — 길게 눌러 선택하세요": "Could not copy — long-press to select",
  "호스트를 제거할까요?": "Remove this host?",
  "노트북이 넣은 키가 함께 지워집니다. 다시 페어링하기 전에는 되돌릴 수 없습니다.":
    "The key the laptop installed is deleted with it. This cannot be undone until you pair again.",
  제거: "Remove",
  "이 컴퓨터를 잊을까요?": "Forget this computer?",
  "{computer}의 세션이 이 폰의 목록에서 사라집니다. 이 컴퓨터가 넣어 준 SSH 호스트와 노트북의 기기 목록은 그대로입니다.":
    "{computer}'s sessions leave this phone's list. The SSH hosts it installed and the laptop's device list are untouched.",

  // 세션 목록
  "세션 목록 조회": "List sessions",
  "조회 중…": "Listing…",
  "서버의 `hmux mobile-gateway`에 세션 목록을 요청해 찾습니다.":
    "Asks the server's `hmux mobile-gateway` for its session catalog.",
  "이 서버에 세션이 없습니다": "This server is running no sessions",
  "읽기 전용으로 연결": "Attach read-only",
  "연결할 수 없는 상태입니다: {lifecycle}": "Not attachable: {lifecycle}",
  "연결할 수 없음": "Not attachable",

  // 터미널
  "읽기 전용 — 입력은 전달되지 않습니다": "Read-only — keystrokes are not sent",
  "읽기 전용({role}) — 입력은 전달되지 않습니다":
    "Read-only ({role}) — keystrokes are not sent",
  "같은 기계에 있어야만 주어지는 권한이라 요청하지 않았습니다: {list}":
    "Not requested, because these are premised on sharing the session's machine: {list}",
  "허용된 권한: {list}": "Granted capabilities: {list}",
  없음: "none",
  "세션이 끊겼습니다: {reason}": "The session was cut off: {reason}",
  "세션이 종료되었습니다": "The session ended",

  // 푸터 / 한계
  "hmux 프로토콜 v{major}.{minor}": "hmux protocol v{major}.{minor}",
  "중계 연결에서 보류하는 권한: {list}": "Withheld over a relay: {list}",
  "읽기 전용입니다 — 입력은 아직 연결되지 않았습니다":
    "Read-only — no input path is wired yet",
  "SSH 개인키가 앱 저장소에 평문으로 저장됩니다 — 하드웨어 보관이 아닙니다":
    "The SSH private key is stored in plaintext in app storage — it is not hardware-backed",
  "게이트웨이가 범위 제한 권한을 발급하지 않습니다 — SSH 키가 유일한 권한입니다":
    "The gateway mints no scoped grant — the SSH key is the whole of the authority",
  "페어링 키 한 줄이 그 서버 계정의 모든 세션에 닿습니다 — 세션 하나로 좁혀지지 않습니다":
    "The single key pairing installs reaches every session that account owns on the server — it is not narrowed to one session",
  "기기 키: 없음 ({reason})": "Device key: none ({reason})",
  "예정 알고리즘 {algorithm}": "planned algorithm {algorithm}",
  "기기 키를 만드는 네이티브 플러그인이 아직 없습니다":
    "The native plugin that creates the device key does not exist yet",

  "서버 목록을 읽지 못했습니다: {message}": "Could not read the server list: {message}",
  "확인 중": "Checking…",
  "다시 확인": "Refresh",
  "설정": "Settings",
  "연결 없음": "No hosts",
  "{host} 외 {count}": "{host} and {count} more",
  "기기 초기화": "Reset device",
  "기기를 초기화할까요?": "Reset this device?",
  "호스트 {count}개, 기기 키, 명령 기록과 설정이 삭제됩니다. 되돌릴 수 없습니다.":
    "{count} host(s), device keys, command history and settings will be deleted. This cannot be undone.",
  "초기화": "Reset",
  "일반": "General",
  "언어": "Language",
  "자동": "Automatic",
  "시스템 언어 따름 · {language}": "Follow system language · {language}",
  "한국어": "Korean",
  "영어": "English",
  "알림": "Notifications",
  "모두": "All",
  "승인과 턴 완료를 알립니다": "Notify for approvals and finished turns",
  "승인만": "Approvals only",
  "에이전트가 승인을 기다릴 때만 알립니다": "Notify only when an agent is waiting for approval",
  "끔": "Off",
  "알리지 않습니다": "Do not notify",
  "앱이 열려 있는 동안만 알립니다. iOS는 백그라운드로 간 뒤 몇 초까지입니다.":
    "Only while the app is open. On iOS, only for a few seconds after it goes to the background.",
  "앱이 열려 있는 동안만 알립니다.": "Only while the app is open.",
  "알림 권한이 없습니다. 시스템 설정에서 허용하세요.":
    "Notifications are not permitted. Allow them in the system settings.",
  "{choice} · 권한 없음 — 설정에서 허용": "{choice} · Not permitted — allow in Settings",
  "{choice} · 권한 필요": "{choice} · Permission needed",
  "항목을 고르면 알림 권한을 요청합니다.": "Choosing an option asks for notification permission.",
  "승인 필요": "Approval needed",
  "{session} 세션이 승인을 기다립니다": "{session} is waiting for approval",
  "작업 완료": "Turn finished",
  "{session} 세션의 에이전트가 턴을 마쳤습니다": "The agent in {session} finished its turn",
  "{session} 세션의 에이전트가 입력을 기다립니다": "The agent in {session} is waiting for input",
  "키보드": "Keyboard",
  "키스트립": "Key strip",
  "햅틱": "Haptics",
  "터미널": "Terminal",
  "글꼴 크기": "Font size",
  "터미널 본문에 적용됩니다.": "Applies to terminal text.",
  "스크롤": "Scroll",
  "느리게": "Slow",
  "보통": "Normal",
  "빠르게": "Fast",
  "터미널을 손가락으로 넘기는 동안의 속도에 적용됩니다. 손을 뗀 뒤의 관성은 시스템이 정합니다.":
    "Applies to how fast the terminal moves under your finger. Momentum after you lift is the system's.",
  "연결 안 됨": "Disconnected",
  "연결됨": "Connected",
  "연결됨 · 방금 확인": "Connected · checked just now",
  "연결됨 · {minutes}분 전 확인": "Connected · checked {minutes} min ago",
  "연결할 수 없음 · 자동 재시도 중": "Cannot connect · retrying automatically",
  "사용자": "User",
  "라벨 (선택)": "Label (optional)",
  "이 서버에서 세션 시작": "Start a session on this server",
  "시작하는 중…": "Starting…",
  "이 서버에서 세션을 시작하지 못했습니다": "Could not start a session on this server",
  "호스트 제거": "Remove host",
  "보안": "Security",
  "settings.security.approvalBiometric": "Biometric authentication for approvals",
  "이 기기에서 사용할 수 없음": "Not available on this device",
  "settings.security.enableApprovalBiometricReason":
    "Confirm to require biometric authentication for approvals",
  "settings.security.disableApprovalBiometricReason":
    "Confirm to stop requiring biometric authentication for approvals",
  "approval.biometricRequired":
    "Biometric authentication is required before answering this approval",
  "approval.biometricCancelled":
    "Biometric authentication was cancelled, so the input was not sent",
  "approval.biometricUnavailable":
    "Biometric authentication is not available on this device, so the input was not sent",
  "approval.biometricFailedToSend":
    "Biometric authentication did not pass, so the input was not sent",
  "settings.security.biometricFailed": "Biometric authentication failed",
  "도움말": "Help",
  "피드백 보내기": "Send feedback",
  "링크를 열지 못했습니다: {message}": "Could not open the link: {message}",
  "Dure {version}": "Dure {version}",
  "진행 방법": "How it works",
  "서버 · 확인 중": "Servers · checking",
  "재개": "Resume",
  "빠른 작업": "Quick actions",
  "모든 세션": "All sessions",
  "세션 없음": "No sessions",
  "세션 {total}개 · 활성 {live}개": "{total} session(s) · {live} live",
  "세션 {total}개": "{total} session(s)",
  "뒤로": "Back",
  "다시 조회": "Look again",
  "아직 조회하지 않았습니다": "Not looked up yet",
  "전체": "All",
  "활성": "Live",
  "종료": "Ended",
  "{filter}에 해당하는 세션이 없습니다": "No sessions match {filter}",
  "전체 {total}개 중 0개": "0 of {total}",
  "이 연결이 증명한 것": "What this connection proved",

  // 컴퓨터(허브)
  컴퓨터: "Computers",
  잊기: "Forget",
  "밖에서도 연결됩니다": "Reachable from anywhere",
  "인터넷 릴레이가 없습니다 · 다시 페어링하세요":
    "No internet relay · Pair again",
  "노트북에서 QR을 한 번 스캔하면, 그 뒤로는 폰이 그 컴퓨터의 에이전트 세션 목록을 직접 받아 옵니다.":
    "Scan a QR from your laptop once. After that this phone fetches that computer's agent sessions itself.",
  "노트북 앱에서 QR 열기": "Open the QR in the laptop app",
  "설정 → 모바일. 릴레이를 켜 두면 같은 와이파이가 아니어도 붙습니다.":
    "Settings → Mobile. Leave the relay on and it connects even off your Wi-Fi.",
  "또는 노트북에서 명령 실행": "Or run the command on your laptop",
  "hmux pair offline — 서버에 SSH로 붙는 다른 길이고, QR과 6글자 코드가 함께 나옵니다.":
    "hmux pair offline — the other route, SSH straight to your servers; a QR and a six-character code appear together.",
  "위 버튼으로 스캔": "Scan with the button above",
  "어느 QR인지는 앱이 알아서 구별합니다.": "The app works out which kind of QR it is.",
  "노트북 화면의 QR을 한 번 스캔합니다. 컴퓨터 QR이면 그 컴퓨터의 세션 목록으로 바로 들어가고, `hmux pair offline` QR이면 이 기기에서 SSH 키를 만들어 공개키만 보냅니다.":
    "Scan the QR on your laptop's screen once. A computer QR takes you straight into that computer's session list; an `hmux pair offline` QR makes an SSH key here and sends only the public half.",
  "저장된 컴퓨터를 읽지 못했습니다: {message}": "Could not read the saved computers: {message}",
  "{box}에 {device}(으)로 연결했습니다 · 세션 {count}개":
    "Connected to {box} as {device} · {count} session(s)",
  "잊어도 노트북의 기기 목록에는 남습니다 — 해지는 노트북에서 합니다.":
    "Forgetting here leaves the laptop's device list untouched — revoke it there.",

  // 컴퓨터 한 대의 세션 목록
  "연결 중…": "Connecting…",
  "아직 연결하지 않았습니다": "Not connected yet",
  "이 컴퓨터에 세션이 없습니다": "This computer is running no sessions",
  "대답하지 못한 상자 {count}개": "{count} boxes did not answer",
  "터미널 열기": "Open terminal",
  "살아 있음 · 터미널은 아직 열 수 없습니다": "Live · no terminal on this route yet",
  "이 컴퓨터의 세션을 여기서 볼 수 있습니다. 터미널을 여는 것은 아직 SSH로 등록한 서버에서만 됩니다.":
    "You can see this computer's sessions here. Opening a terminal still works only for servers registered over SSH.",
  "컴퓨터에서 만든 묶음을 아직 받지 못했습니다. 컴퓨터별로 보여줍니다.":
    "The desktops you made on the computer haven't arrived yet. Grouping by machine for now.",
  "열리지 않은 에이전트": "Unopened agents",
  "이 컴퓨터의 세션은 아직 열 수 없습니다": "This computer's sessions cannot be opened yet",
  "이 컴퓨터의 세션 {count}개가 모두 사이드바 밖에 있습니다":
    "All {count} of this computer's sessions sit outside its sidebar",
  "노트북 앱에서 데스크탑에 올려 둔 세션이 여기 보입니다.":
    "Sessions you put on a desktop in the laptop app show up here.",
  "세션 {count}개가 모두 사이드바 밖에 있습니다 — 노트북 앱에서 데스크탑에 올려 둔 것이 여기 보입니다":
    "All {count} sessions sit outside the sidebar — what you put on a desktop in the laptop app shows up here",
  "컴퓨터가 꺼져 있어 로컬 세션에 닿을 수 없습니다":
    "This local session is out of reach because the computer is off",
  "{server}에 연결하지 못했습니다": "Could not reach {server}",
  // v2(오프라인) 페어링 코드 입력
  "QR을 읽었습니다. 노트북 화면의 QR 옆에 있는 6글자를 입력하세요.":
    "QR read. Type the six characters shown beside the QR on your laptop.",
  "페어링 코드": "Pairing code",
  "소문자로 쳐도, 사이에 하이픈을 넣어도 됩니다. O와 0, I와 1은 알아서 맞춥니다.":
    "Lower case is fine, so are hyphens. O/0 and I/1 are corrected for you.",
  "코드로 페어링": "Pair with the code",
  "이 QR은 코드 없이는 아무것도 열지 않습니다 — 사진만으로는 서버에 닿을 수 없습니다.":
    "This QR opens nothing without the code — a photograph alone cannot reach your servers.",
  "다시 스캔": "Scan again",
  "코드는 {length}글자입니다 — 노트북 화면의 글자를 다시 확인하세요":
    "The code is {length} characters — check the characters on the laptop screen",
  // 첫 실행과 페어링 네 화면 (Figma dure-UI 2863:76314 / 2863:76554 /
  // 2865:76794 / 2865:77049)
  "데스크톱을 연결하세요": "Connect your desktop",
  "컴퓨터에서 실행 중인 에이전트를 지켜보고, 승인하고, 터미널에 들어갑니다.":
    "Watch the agents running on your computer, approve them, and step into the terminal.",
  "QR 스캔으로 연결": "Connect by scanning a QR",
  "코드 붙여넣기로 연결": "Connect by pasting a code",
  "연결 방법": "How to connect",
  "데스크톱 Dure에서 QR 표시": "Show the QR in desktop Dure",
  "설정 › 모바일 연결에서 페어링 QR을 만듭니다.":
    "Settings › Mobile connection creates the pairing QR.",
  "이 폰으로 스캔": "Scan it with this phone",
  "위 버튼으로 스캐너를 열고 화면의 QR을 비춥니다.":
    "Open the scanner with the button above and point it at the QR on screen.",
  "연결 완료": "Connected",
  "세션 목록이 여기 나타납니다. 종단간 암호화.":
    "The session list appears here. End-to-end encrypted.",
  "스캔 그만두기": "Stop scanning",
  "데스크톱 Dure의 설정 › 모바일 연결에 표시된 QR 코드를 비추세요":
    "Point it at the QR code shown in desktop Dure under Settings › Mobile connection",
  "코드로 연결": "Connect with a code",
  "데스크톱이 authorized_keys 주석에 적는 이름입니다.":
    "The desktop writes this into the authorized_keys comment.",
  "이 기기에는 카메라 스캐너가 없습니다 — 코드 붙여넣기로 연결하세요":
    "This device has no camera scanner — connect by pasting the code instead",
  "이 서버에 연결할까요?": "Connect to this server?",
  "데스크톱 화면의 지문과 같은지 확인하세요.":
    "Check that it matches the fingerprint on the desktop screen.",
  "세션 {count}": "{count} sessions",
  "지문 {fingerprint}": "Fingerprint {fingerprint}",
  연결: "Connect",

  // 세션 리스트 홈 (Figma dure-UI 3096:86209 / 86271 / 86335 / 86354)
  "컴퓨터 연결": "Connect a computer",
  "아직 세션 목록을 받지 않았습니다": "The session list has not been fetched yet",
  "재연결 중…": "Reconnecting…",
  "다시 시도": "Try again",
  "표시할 세션 없음": "No sessions to show",
  "{hub}에 연결됨.": "Connected to {hub}.",
  "+를 눌러 에이전트를 시작하세요.": "Press + to start an agent.",
  추가: "Add",
  "등록된 폴더에서 에이전트를 시작합니다": "Start an agent in a folder you have registered",
  "SSH 호스트 추가": "Add an SSH host",
  // 홈 목록의 길게 누르기 메뉴와 연결 실패 카드 (Figma 3356:85254 / 85402 / 85606)
  "세션 열기": "Open session",
  "지금 재연결": "Reconnect now",
  "세션 연결": "Attach session",
  "연결 오류": "Connection error",
  "{machine}이(가) 꺼져 있는지 확인하세요.": "Check whether {machine} is switched on.",
  // SSH 호스트 추가 화면 (Figma 3177:82034 / 3177:82150).
  // 호스트·포트·사용자·라벨은 호스트 상세 화면이 이미 들고 있다 — 같은 낱말이고
  // 같은 뜻이라, 여기서 다시 적으면 두 번역이 갈라질 자리가 하나 생긴다.
  "User name": "User name",
  인증: "Authentication",
  "· 이 기기에서 생성됨": "· generated on this device",
  "저장하면 이 기기의 공개 키를 보여 드립니다. 호스트 ~/.ssh/authorized_keys에 추가하세요. 비밀번호 인증은 지원하지 않습니다.":
    "After saving, this device's public key is shown. Add it to the host's ~/.ssh/authorized_keys. Password authentication is not supported.",
  "{label}에 연결할 수 없음 — 포트 {port} 응답 없음":
    "Cannot reach {label} — port {port} did not answer",
  "호스트가 켜져 있는지, 공개 키가 등록됐는지 확인하세요.":
    "Check that the host is up and that the public key is registered.",
  "이 기기 키": "This device's key",
  비밀번호: "Password",
  "키 가져오기": "Import a key",
  "키 파일 선택": "Choose a key file",
  "· 가져온 키": "· imported",
  "이 호스트가 이미 아는 개인키를 고르세요.":
    "Choose a private key this host already knows.",
  "비밀번호는 이 기기의 키를 호스트에 등록할 때 한 번만 쓰고 저장하지 않습니다.":
    "The password is used once, to register this device's key on the host, and is never stored.",
  "호스트명·사용자·키로 새 연결을 만듭니다": "Make a new connection from a hostname, user and key",
  방금: "just now",
  "{count}초 전": "{count}s ago",
  "{count}분 전": "{count}m ago",
  "{count}시간 전": "{count}h ago",
  "{count}일 전": "{count}d ago",

  // 세션 화면과 키 트레이 (Figma dure-UI 2829:75893 / 2863:75522)
  "메시지 입력": "Type a message",
  보내기: "Send",
  "최근 명령": "Recent commands",
  "다른 세션": "Other sessions",
  최근: "Recent",
  "이 폰에서 보낸 명령이 아직 없습니다": "Nothing has been sent from this phone yet",
  "최근 명령 지우기": "Clear recent commands",
  "최근 명령을 지울까요?": "Clear recent commands?",
  "이 폰에서 보낸 명령 {count}개가 삭제됩니다. 세션에는 영향이 없습니다.":
    "{count} command(s) sent from this phone will be deleted. Sessions are not affected.",
  지우기: "Clear",
  "명령 {count}개": "{count} commands",
  "열 수 있는 다른 세션이 없습니다": "There is no other session to open",
  "Ctrl 다음 키에 적용됩니다": "Ctrl applies to the next key",

  // 키 스트립 화면 (Figma dure-UI 3272:85021)
  "키 스트립": "Key strip",
  기본: "Default",
  미리보기: "Preview",
  "스트립이 비어 있습니다": "The strip is empty",
  "키 {count}개": "{count} keys",
  "{key} 빼기": "Remove {key}",
  "{key} 추가": "Add {key}",
  "기본값으로 재설정": "Reset to defaults",
  "기본값으로 재설정할까요?": "Reset to defaults?",
  "직접 고른 키는 사라지고 기본 스트립이 돌아옵니다.":
    "The keys you picked are discarded and the default strip comes back.",
  재설정: "Reset",
  "키를 누르면 스트립에 추가되고, 다시 누르면 빠집니다.":
    "Press a key to put it in the strip; press it again to take it out.",
  "미리보기의 칩은 끌어서 순서를 바꾸고, 탭하면 제거됩니다.":
    "Drag a chip in the preview to reorder it, or tap it to remove it.",
  특수: "Special",
  수정자: "Modifiers",
  "화살표 · 탐색": "Arrows · navigation",
  펑션: "Function",
  기호: "Symbols",
  "컨트롤 조합": "Control combos",
  "옵션 조합": "Option combos",
  방향키: "Arrow keys",
  "연결 정보": "Connection",
  권한: "Role",
  "전송 증명": "Transport attestation",
  "중계로 보류됨": "Withheld over relay",
  명령: "Commands",
  "키보드 내리기": "Dismiss keyboard",
  "음성 입력": "Voice input",
  "작업 중": "Working",
  완료: "Done",
  "{key} 다음 키에 적용됩니다": "{key} applies to the next key",
  "소스 컨트롤": "Source control",
  변경: "Changes",
  커밋: "Commit",
  "브랜치를 아직 받지 못했습니다": "No branch reported yet",
  "Pull request 만들기": "Open a pull request",
  "{base}에서 분기": "forked from {base}",
  "변경 사항을 읽는 중": "Reading changes",
  "변경 사항을 읽지 못했습니다": "Could not read the changes",
  "변경된 파일이 없습니다": "No changed files",
  "커밋을 읽는 중": "Reading commits",
  "커밋을 읽지 못했습니다": "Could not read the commits",
  "기준 브랜치 이후 커밋이 없습니다": "No commits since the base branch",
  "이 세션에 닿을 수 있는 경로가 없습니다": "No route to this session",
  "이 세션은 {box} 에서 돕니다. 이 폰은 그 상자와 아직 짝을 짓지 않았습니다":
    "This session runs on {box}. This phone is not paired with that box yet",
  "그 세션은 다른 컴퓨터에서 돌고, 이 폰의 목록에는 그 상자가 없습니다":
    "That session runs on another computer, and this phone has no entry for that box",
  "노트북이 이유를 말하지 않았습니다": "The laptop did not say why",
  "읽기 전용 — 다른 곳에서 입력 중입니다": "Watch-only — someone else is typing",
  "읽기 전용 — 이 연결은 보기 전용으로 짝지어졌습니다":
    "Watch-only — this connection was paired for watching",
  "읽기 전용 — {reason}": "Watch-only — {reason}",
  "이 상자의 hmux가 오래되어 변경 목록을 읽지 못합니다":
    "This box's hmux is too old to read the changes",
  // 파일 하나의 패치 화면. Figma 3048:81027.
  "이 상자의 hmux가 오래되어 패치를 읽지 못합니다":
    "This box's hmux is too old to read a file's changes",
  "노트북이 본문 없이 답했습니다": "The laptop answered without a body",
  "변경 내용을 읽는 중": "Reading the changes",
  "변경 내용을 읽지 못했습니다": "Could not read the changes",
  "이진 파일입니다": "This is a binary file",
  "줄 단위로 보여 줄 내용이 없습니다": "There are no lines to show",
  "바뀐 줄이 없습니다": "No lines changed",
  "파일 내용은 그대로입니다": "The file's contents are unchanged",
  "이름이나 권한만 바뀌었습니다": "Only its name or its mode changed",
  "이 아래는 너무 길어 잘렸습니다": "The rest was too long and was cut",
  // Pull request 탭과 만들기 폼. Figma 3050:81530, 3051:81154, 3049:81587.
  // 리뷰어 지정. Figma 3135:81548.
  "기준 브랜치를 아직 받지 못했습니다": "The base branch has not arrived yet",
  "브랜치": "Branch",
  "제목": "Title",
  "설명": "Description",
  "옵션": "Options",
  "무엇을 바꿨는지 한 줄로": "One line on what changed",
  "바꾼 이유나 확인할 점 (선택)": "Why, or what to look at (optional)",
  "Draft로 열기": "Open as a draft",
  "리뷰 요청 없이 초안으로 생성": "Created without asking for a review",
  "포함되는 커밋": "Commits included",
  "포함되는 커밋 {count}": "Commits included {count}",
  "만들기": "Create",
  "만드는 중…": "Creating…",
  "이 컴퓨터가 커밋을 보내지 않았습니다": "This computer did not send the commits",
  // 변경 탭의 고르기와 커밋, 브랜치 전환, 되돌리기.
  // Figma 3043:81248, 3042:80841, 3044:33291, 3051:81829, 3050:81250, 3048:81145.
  "모두 포함": "Include every file",
  "{total}개 중 {chosen}개 포함": "{chosen} of {total} included",
  "{count}개 파일 커밋": "Commit {count} files",
  "브랜치 올리기": "Push this branch",
  "만들면 이 브랜치를 먼저 올립니다": "Creating one pushes this branch first",
  "브랜치 전환": "Switch branch",
  "포함되지 않은 변경 {count}개는 그대로 따라갑니다":
    "The {count} changes you did not include come along",
  "브랜치를 읽는 중": "Reading branches",
  "브랜치를 읽지 못했습니다": "Could not read the branches",
  "이 컴퓨터가 브랜치를 보내지 않았습니다": "This computer did not send the branches",
  "지금 브랜치": "Current branch",
  "다른 워크트리가 쓰는 중": "In use by another worktree",
  "새 브랜치 만들기": "Create a branch",
  "새 브랜치 이름": "New branch name",
  "소문자·슬래시로 그룹·공백 불가": "Lowercase, slashes to group, no spaces",
  "커밋하기": "Commit",
  "커밋하는 중…": "Committing…",
  "{count}개 파일": "{count} files",
  "{count}개 파일 · {branch}": "{count} files · {branch}",
  "메시지": "Message",
  "무엇을 바꿨는지": "What changed",
  "변경을 버릴까요?": "Discard these changes?",
  "{path} 의 변경이 사라집니다. 되돌릴 수 없습니다.":
    "The changes in {path} will be gone. This cannot be undone.",
  "파일 {count}개의 변경이 사라집니다. 되돌릴 수 없습니다.":
    "The changes in {count} files will be gone. This cannot be undone.",
  "버리기": "Discard",
  "변경 되돌리기": "Discard changes",
  "커밋에 포함": "Include in commit",
  "커밋에 포함됨": "Included",
  // 커밋 상세. Figma 3051:81535.
  "그 상자는 커밋 상세를 아직 보내지 않습니다":
    "That box does not send commit details yet",
  "커밋 상세": "Commit",
  "변경된 파일 {count}": "{count} files changed",
  "바뀐 파일이 없습니다": "No files changed",
  "sha 복사": "Copy the sha",
  "복사됨": "Copied",
  // 브랜치의 리뷰다 — `gh pr create` 에 커밋 하나짜리 모양은 없다. 영어도 그
  // 사실을 감추지 않게 "for this commit" 이 아니라 "with this commit" 이다.
  "이 커밋으로 PR": "Open a PR with this commit",
  "열려 있는 Pull Request": "Open pull requests",
  "노트북이 이 값을 아직 폰에 보내지 않습니다 — 전선을 놓는 중입니다.":
    "The laptop does not send this to the phone yet — the wire is being built.",

  "새로 만들기": "New",
  "새 에이전트": "New agent",
  "짝지은 컴퓨터에서 하나 띄웁니다": "Start one on a paired computer",
  "컴퓨터를 연결하세요": "Connect a computer",
  "먼저 컴퓨터를 연결하세요": "Connect a computer first",
  "QR 을 찍어 짝짓습니다": "Pair by scanning a QR code",
  "SSH 로 닿는 상자를 등록합니다": "Register a box you reach over SSH",
  "에이전트": "Agent",
  "에이전트 시작": "Start agent",
  "띄우는 중…": "Starting…",
  "고를 수 있는 것을 읽는 중…": "Reading what you can choose…",
  "아직 여기서는 띄울 수 없습니다": "Cannot be started from here yet",
  "이 컴퓨터에 설치되어 있지 않습니다": "Not installed on this computer",
  "에이전트를 띄웠습니다": "The agent started",
  "곧 목록에 나타납니다": "It will appear in the list shortly",
  "에이전트를 띄웠습니다. 곧 목록에 나타납니다":
    "The agent started. It will appear in the list shortly",
  "띄우지 못했습니다": "Could not start it",
  "다시 고르기": "Choose again",
  "열기": "Open",
  "짝지은 컴퓨터가 없습니다": "No paired computer",
  "이 컴퓨터에 등록된 폴더가 없습니다. 노트북에서 폴더를 열면 여기 나옵니다":
    "No folders are registered on this computer. Open one on the laptop and it will appear here",
  "노트북 화면이 아직 목록을 보내지 않았습니다. 잠시 뒤 다시 열어 보세요":
    "The laptop's screen has not sent the list yet. Try opening this again in a moment",


  "닫기": "Close",
  "흐린 것은 이 컴퓨터에 설치되어 있지 않습니다": "The dimmed ones are not installed on this computer",
  "이 컴퓨터에는 띄울 수 있는 에이전트가 없습니다": "No agent is installed on this computer",
  "띄우는 중입니다. 곧 목록에 나타납니다": "It is starting. It will appear in the list shortly",

  "스페이스": "Space",
  "폴더": "Folder",
  "고르세요": "Choose",
  "다른 폴더 열기...": "Open another folder...",
  "다른 폴더 열기": "Open another folder",
  "새 폴더": "New folder",
  "폴더 이름": "Folder name",
  "{host} · {path} 안에 만들어짐": "Created inside {host} · {path}",
  "폴더를 읽는 중…": "Loading folders…",
  "폴더를 열지 못했습니다": "Could not open the folder",
  "폴더를 만들지 못했습니다": "Could not create the folder",
  "{folder} 폴더에서 시작": "Start in {folder}",
  "폴더에서 시작": "Start in folder",
  "새 worktree에서 시작": "Start in a new worktree",
  "메인 브랜치를 건드리지 않습니다": "Leaves the main branch alone",
  "브랜치 이름": "Branch name",

};
