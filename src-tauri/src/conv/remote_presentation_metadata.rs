//! Exact provider-owned presentation for one registered SSH host.
//!
//! The local reader (`presentation_metadata`) bounds its file windows so the
//! desktop never scans a whole transcript. Those same windows have to be read
//! where the transcript lives, so the remote path runs the equivalent bounded
//! reader as one Python 3 process on the host and only positional metadata
//! crosses the SSH boundary — the same shape `remote_list_command` uses for
//! the conversation picker.

use super::{safe_conversation_id, shell_quote};
use serde::{Deserialize, Serialize};

pub(crate) const MAX_REMOTE_TARGETS: usize = 128;

/// One positional lookup. `profile_directory` is the reviewed relative
/// credential root below the remote home; `None` reads the provider default.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteTarget {
    pub(crate) provider: String,
    pub(crate) conversation_id: String,
    pub(crate) cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) profile_directory: Option<String>,
    /// Opaque size/mtime token from the previous observation. The reader
    /// answers `unchanged` instead of re-reading a transcript that kept it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) observed: Option<String>,
}

/// One positional observation: the local `Metadata` shape plus the token the
/// next request echoes, or `unchanged` when the echoed token still holds.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteMetadata {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) unchanged: bool,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) activity_at: Option<String>,
    #[serde(default)]
    pub(crate) recent_prompts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) observed: Option<String>,
}

const REMOTE_METADATA_SCRIPT: &str = r##"import json,os,re,sys,urllib.parse
home=os.path.expanduser("~")
WINDOW=1024*1024; PROMPT_WINDOW=8*1024*1024; INDEX_WINDOW=8*1024*1024
safe_id=re.compile(r"^[A-Za-z0-9._:+-]{1,256}$")
def user_text(value):
  message=value.get("message")
  content=message.get("content") if isinstance(message,dict) else None
  if isinstance(content,str): return content
  if isinstance(content,list):
    for block in content:
      if isinstance(block,dict) and block.get("type")=="text" and isinstance(block.get("text"),str): return block["text"]
  return None
def codex_content_text(value):
  if isinstance(value,str): return value if value.strip() else None
  if isinstance(value,list):
    joined="".join(part["text"] for part in value if isinstance(part,dict) and part.get("type") in ("input_text","text") and isinstance(part.get("text"),str))
    return joined if joined.strip() else None
  return None
def codex_context_injection(text):
  return text.lstrip().startswith(("# AGENTS.md instructions for ","<environment_context>","<INSTRUCTIONS>","<permissions instructions>","<collaboration_mode>","<apps_instructions>","<plugins_instructions>","<skills_instructions>"))
def codex_user_text(value):
  payload=value.get("payload",value)
  if not isinstance(payload,dict): return None
  if payload.get("type")=="user_message":
    message=payload.get("message")
    return message if isinstance(message,str) and message.strip() else None
  if payload.get("type")=="message" and payload.get("role")=="user": return codex_content_text(payload.get("content"))
  return None
def activity_timestamp(provider,value):
  kind=value.get("type")
  if not isinstance(kind,str): return None
  if provider=="codex":
    found=codex_user_text(value)
    if found is not None and codex_context_injection(found): return None
  elif provider=="claude" and kind=="user":
    found=user_text(value)
    if found is not None and (codex_context_injection(found) or found.lstrip().startswith("Caveat:")): return None
  if provider=="claude": meaningful=kind in ("user","assistant") and value.get("isMeta") is not True
  elif provider=="codex":
    payload=value.get("payload")
    ptype=payload.get("type") if isinstance(payload,dict) else None
    if kind=="response_item": meaningful=ptype in ("message","function_call","function_call_output","custom_tool_call","custom_tool_call_output") and payload.get("role") not in ("system","developer")
    elif kind=="event_msg": meaningful=ptype in ("user_message","agent_message","task_started","task_complete")
    else: meaningful=False
  else: meaningful=False
  if not meaningful: return None
  stamp=value.get("timestamp")
  return stamp if isinstance(stamp,str) else None
def window(handle,start,limit):
  handle.seek(start)
  text=handle.read(limit).decode("utf-8","replace")
  if start>0:
    newline=text.find("\n")
    if newline<0: return None
    text=text[newline+1:]
  return text
def file_activity(provider,cid,path):
  if not os.path.isfile(path): return None
  size=os.path.getsize(path)
  with open(path,"rb") as handle:
    prefix=window(handle,0,WINDOW)
    if prefix is None: return None
    if provider=="codex":
      try: header=json.loads(prefix.split("\n",1)[0])
      except Exception: return None
      payload=header.get("payload") if isinstance(header,dict) else None
      if not isinstance(payload,dict) or header.get("type")!="session_meta" or payload.get("id")!=cid: return None
    tail=window(handle,max(size-PROMPT_WINDOW,0),PROMPT_WINDOW) if size>WINDOW else prefix
  if tail is None: return None
  activity=None; prompts=[]
  for line in reversed(tail.split("\n")):
    try: value=json.loads(line)
    except Exception: continue
    if not isinstance(value,dict): continue
    stamp=activity_timestamp(provider,value)
    if stamp is None: continue
    if activity is None: activity=stamp
    prompt=codex_user_text(value) if provider=="codex" else (user_text(value) if value.get("type")=="user" else None)
    if prompt is not None and prompt.strip():
      prompts.append(prompt[:4096])
      if len(prompts)==8: break
  prompts.reverse()
  return {"title":None,"activityAt":activity,"recentPrompts":prompts}
titles={}
def codex_titles(root):
  if root in titles: return titles[root]
  found={}
  titles[root]=found
  path=os.path.join(root,"session_index.jsonl")
  try:
    size=os.path.getsize(path)
    if size==0: return found
    with open(path,"rb") as handle: content=window(handle,max(size-INDEX_WINDOW,0),INDEX_WINDOW)
  except Exception: return found
  for line in (content or "").split("\n"):
    try: value=json.loads(line)
    except Exception: continue
    if not isinstance(value,dict): continue
    cid=value.get("id"); name=value.get("thread_name")
    if not isinstance(cid,str) or not safe_id.fullmatch(cid) or not isinstance(name,str): continue
    title=" ".join(name.split())
    if title: found[cid]=title[:64]
  return found
def within(path,root):
  return path==root or path.startswith(root+os.sep)
def codex_rollout(root,cid):
  sessions=os.path.realpath(os.path.join(root,"sessions"))
  if not os.path.isdir(sessions): return None
  provider_root=os.path.dirname(sessions)
  database=os.path.join(provider_root,"state_5.sqlite")
  if not os.path.isfile(database): return None
  try:
    import sqlite3
    connection=sqlite3.connect("file:"+urllib.parse.quote(database,safe="/")+"?mode=ro",uri=True,timeout=0.1)
    try: row=connection.execute("SELECT rollout_path FROM threads WHERE id = ? LIMIT 1",(cid,)).fetchone()
    finally: connection.close()
  except Exception: return None
  if not row or not isinstance(row[0],str): return None
  path=os.path.realpath(row[0])
  if not os.path.isfile(path): return None
  archived=os.path.join(provider_root,"archived_sessions")
  roots=[sessions]+([os.path.realpath(archived)] if os.path.isdir(archived) else [])
  return path if any(within(path,candidate) for candidate in roots) else None
def stamp(path):
  try: status=os.stat(path)
  except Exception: return "absent"
  return "%d:%d"%(status.st_size,status.st_mtime_ns)
def read(target):
  if not isinstance(target,dict): return None
  provider=target.get("provider"); cid=target.get("conversationId"); cwd=target.get("cwd"); profile=target.get("profileDirectory")
  if provider not in ("codex","claude") or not isinstance(cid,str) or not safe_id.fullmatch(cid) or not isinstance(cwd,str): return None
  root=os.path.join(home,profile) if isinstance(profile,str) and profile else os.path.join(home,"."+provider)
  if provider=="codex":
    path=codex_rollout(root,cid)
    observed=stamp(path)+"/"+stamp(os.path.join(root,"session_index.jsonl")) if path else "absent"
  else:
    path=os.path.join(root,"projects","".join("-" if character in "/." else character for character in cwd),cid+".jsonl")
    observed=stamp(path)
  if target.get("observed")==observed: return {"unchanged":True}
  title=codex_titles(root).get(cid) if provider=="codex" else None
  metadata=file_activity(provider,cid,path) if path else None
  if metadata is None: metadata={"title":None,"activityAt":None,"recentPrompts":[]}
  metadata["title"]=title; metadata["observed"]=observed
  return metadata
try: targets=json.load(sys.stdin)
except Exception: targets=[]
if not isinstance(targets,list) or len(targets)>128: targets=[]
out=[]
for target in targets:
  try: out.append(read(target))
  except Exception: out.append(None)
sys.stdout.buffer.write(json.dumps(out,ensure_ascii=False).encode("utf-8"))
"##;

/// The remote command; targets travel on stdin so the command length never
/// depends on how many sessions the sidebar shows.
pub(crate) fn remote_read_command() -> String {
    format!(
        "python3 -c {} 2>/dev/null || echo '[]'",
        shell_quote(REMOTE_METADATA_SCRIPT)
    )
}

/// Positional request body. Targets the reader refuses locally (unsupported
/// provider, unsafe id) travel as `null` so the response stays positional.
pub(crate) fn remote_read_request(targets: &[Option<RemoteTarget>]) -> Result<String, String> {
    if targets.len() > MAX_REMOTE_TARGETS {
        return Err("provider conversation metadata target limit exceeded".to_string());
    }
    let admitted = targets
        .iter()
        .map(|target| {
            target.as_ref().filter(|target| {
                matches!(target.provider.as_str(), "codex" | "claude")
                    && safe_conversation_id(&target.conversation_id)
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&admitted)
        .map_err(|error| format!("provider conversation metadata request failed: {error}"))
}

/// Parse the positional response. A missing interpreter yields the shell
/// fallback `[]`, which is "nothing observed" for every target, never an error.
pub(crate) fn parse_remote_read_output(
    output: &str,
    expected: usize,
) -> Result<Vec<Option<RemoteMetadata>>, String> {
    let observations: Vec<Option<RemoteMetadata>> = serde_json::from_str(output.trim())
        .map_err(|error| format!("provider conversation metadata parse failed: {error}"))?;
    if observations.is_empty() {
        return Ok(vec![None; expected]);
    }
    if observations.len() != expected {
        return Err("provider conversation metadata response was not positional".to_string());
    }
    Ok(observations)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, io::Write, path::Path};

    fn run(home: &Path, targets: &[Option<RemoteTarget>]) -> Vec<Option<RemoteMetadata>> {
        let request = remote_read_request(targets).unwrap();
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", &remote_read_command()])
            .env("HOME", home)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(request.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        parse_remote_read_output(&String::from_utf8(output.stdout).unwrap(), targets.len()).unwrap()
    }

    fn target(provider: &str, id: &str, cwd: &str, profile: Option<&str>) -> Option<RemoteTarget> {
        Some(RemoteTarget {
            provider: provider.to_string(),
            conversation_id: id.to_string(),
            cwd: cwd.to_string(),
            profile_directory: profile.map(str::to_string),
            observed: None,
        })
    }

    /// A target whose transcript does not exist: nothing observed, and a
    /// token that still lets the next request skip it until it appears.
    fn absent() -> RemoteMetadata {
        RemoteMetadata {
            observed: Some("absent".to_string()),
            ..RemoteMetadata::default()
        }
    }

    fn claude_message(kind: &str, text: &str, at: &str) -> String {
        serde_json::json!({"type": kind, "timestamp": at, "message": {"content": text}}).to_string()
    }

    #[test]
    fn claude_reads_the_exact_workspace_profile_and_bounded_prompts() {
        let home = tempfile::tempdir().unwrap();
        let project = home
            .path()
            .join(".claude/projects")
            .join(super::super::encode_cwd("/srv/repo/.worktrees/agent-1"));
        fs::create_dir_all(&project).unwrap();
        let mut file = fs::File::create(project.join("thread.jsonl")).unwrap();
        writeln!(
            file,
            "{}",
            claude_message("user", "Caveat: injected", "2026-09-01T00:00:00Z")
        )
        .unwrap();
        for index in 0..10 {
            writeln!(
                file,
                "{}",
                claude_message("user", &format!("Prompt {index}"), "2026-09-11T00:00:00Z")
            )
            .unwrap();
        }
        writeln!(file, "{}", serde_json::json!({"type": "user", "timestamp": "2026-09-11T00:01:00Z", "isMeta": true, "message": {"content": "meta"}})).unwrap();
        writeln!(
            file,
            "{}",
            claude_message("assistant", "done", "2026-09-11T00:02:00Z")
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type": "custom-title", "timestamp": "2026-09-12T00:00:00Z"})
        )
        .unwrap();
        let profile = home
            .path()
            .join(".dure/accounts/claude-work/projects")
            .join(super::super::encode_cwd("/srv/repo"));
        fs::create_dir_all(&profile).unwrap();
        fs::write(
            profile.join("scoped.jsonl"),
            claude_message("user", "Scoped prompt", "2026-09-10T00:00:00Z") + "\n",
        )
        .unwrap();

        let observed = run(
            home.path(),
            &[
                target("claude", "thread", "/srv/repo/.worktrees/agent-1", None),
                target("claude", "thread", "/srv/other", None),
                target(
                    "claude",
                    "scoped",
                    "/srv/repo",
                    Some(".dure/accounts/claude-work"),
                ),
                target("claude", "../thread", "/srv/repo", None),
                target("gemini", "thread", "/srv/repo", None),
                None,
            ],
        );
        assert_eq!(observed.len(), 6);
        let exact = observed[0].as_ref().unwrap();
        assert_eq!(exact.title, None);
        assert_eq!(exact.activity_at.as_deref(), Some("2026-09-11T00:02:00Z"));
        assert_eq!(
            exact.recent_prompts,
            (2..10)
                .map(|index| format!("Prompt {index}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(observed[1].as_ref().unwrap(), &absent());
        assert!(exact
            .observed
            .as_deref()
            .is_some_and(|token| token != "absent"));
        // Echoing the token skips the read; a changed transcript is re-read.
        let echoed = |token: Option<String>| {
            let mut echo =
                target("claude", "thread", "/srv/repo/.worktrees/agent-1", None).unwrap();
            echo.observed = token;
            Some(echo)
        };
        let again = run(home.path(), &[echoed(exact.observed.clone())]);
        assert_eq!(
            again[0].as_ref().unwrap(),
            &RemoteMetadata {
                unchanged: true,
                ..RemoteMetadata::default()
            }
        );
        writeln!(
            file,
            "{}",
            claude_message("user", "Next prompt", "2026-09-13T00:00:00Z")
        )
        .unwrap();
        let changed = run(home.path(), &[echoed(exact.observed.clone())]);
        assert!(!changed[0].as_ref().unwrap().unchanged);
        assert_eq!(
            changed[0].as_ref().unwrap().recent_prompts.last().unwrap(),
            "Next prompt"
        );
        assert_eq!(
            observed[2].as_ref().unwrap().recent_prompts,
            vec!["Scoped prompt"]
        );
        assert_eq!(observed[3], None);
        assert_eq!(observed[4], None);
        assert_eq!(observed[5], None);
    }

    #[tokio::test]
    async fn codex_resolves_the_indexed_rollout_and_thread_name() {
        use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".codex");
        let sessions = root.join("sessions/2026/09/11");
        fs::create_dir_all(&sessions).unwrap();
        let rollout = sessions.join("rollout-target.jsonl");
        let mut file = fs::File::create(&rollout).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type": "session_meta", "payload": {"id": "target"}})
        )
        .unwrap();
        writeln!(file, "{}", serde_json::json!({"type": "response_item", "timestamp": "2026-09-11T00:00:00Z",
            "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "# AGENTS.md instructions for /repo"}]}})).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type": "event_msg", "timestamp": "2026-09-11T00:01:00Z",
            "payload": {"type": "user_message", "message": "Deploy the fix"}})
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type": "event_msg", "timestamp": "2026-09-11T00:02:00Z",
            "payload": {"type": "agent_message", "message": "Deployed"}})
        )
        .unwrap();
        fs::write(
            root.join("session_index.jsonl"),
            concat!(
                "{\"id\":\"target\",\"thread_name\":\"first   name\"}\n",
                "{\"id\":\"target\",\"thread_name\":\"  clean\\n code  \"}\n",
            ),
        )
        .unwrap();
        let outside = home.path().join("outside.jsonl");
        fs::write(
            &outside,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"escaped\"}}\n",
        )
        .unwrap();
        let options = SqliteConnectOptions::new()
            .filename(root.join("state_5.sqlite"))
            .create_if_missing(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)")
            .execute(&mut db)
            .await
            .unwrap();
        for (id, path) in [("target", &rollout), ("escaped", &outside)] {
            sqlx::query("INSERT INTO threads VALUES (?, ?)")
                .bind(id)
                .bind(path.to_string_lossy().as_ref())
                .execute(&mut db)
                .await
                .unwrap();
        }
        db.close().await.unwrap();

        let observed = run(
            home.path(),
            &[
                target("codex", "target", "/unused", None),
                target("codex", "escaped", "/unused", None),
                target("codex", "unknown", "/unused", None),
            ],
        );
        let exact = observed[0].as_ref().unwrap();
        assert_eq!(exact.title.as_deref(), Some("clean code"));
        assert_eq!(exact.activity_at.as_deref(), Some("2026-09-11T00:02:00Z"));
        assert_eq!(exact.recent_prompts, vec!["Deploy the fix"]);
        // A rollout outside the provider's session roots is never read.
        assert_eq!(observed[1].as_ref().unwrap(), &absent());
        assert_eq!(observed[2].as_ref().unwrap(), &absent());
    }

    #[test]
    fn missing_interpreter_output_is_nothing_observed_and_short_output_is_refused() {
        assert_eq!(
            parse_remote_read_output("[]\n", 2).unwrap(),
            vec![None, None]
        );
        assert!(parse_remote_read_output("[null]", 2).is_err());
        assert!(parse_remote_read_output("not json", 1).is_err());
        assert!(remote_read_request(&vec![None; MAX_REMOTE_TARGETS + 1]).is_err());
    }
}
