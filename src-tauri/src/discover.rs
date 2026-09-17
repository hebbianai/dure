use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// A git worktree of a repo, annotated with evidence of external
/// claude/codex sessions that ran in it (found on disk, not spawned by us).
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DetectedWorktree {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
    pub claude_sessions: u32,
    pub claude_last_ts: Option<u64>, // epoch ms
    pub codex_sessions: u32,
    pub codex_last_ts: Option<u64>,
}

/// How many recent codex rollout files to inspect per scan. Each costs one
/// first-line read; sessions dir can hold thousands over time.
const CODEX_SCAN_CAP: usize = 500;

pub fn scan_worktrees(repo: &str) -> Result<Vec<DetectedWorktree>, String> {
    let out = crate::gitx::run_git(repo, &["worktree", "list", "--porcelain"])?;
    let home = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?);
    let codex = scan_codex_sessions(&home);

    let mut wts: Vec<(String, String)> = Vec::new();
    let mut cur_path: Option<String> = None;
    let mut cur_branch = String::new();
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(cp) = cur_path.take() {
                wts.push((cp, std::mem::take(&mut cur_branch)));
            }
            cur_path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
        } else if line == "detached" {
            cur_branch = "(detached)".into();
        }
    }
    if let Some(cp) = cur_path.take() {
        wts.push((cp, cur_branch));
    }

    Ok(wts
        .into_iter()
        .enumerate()
        .map(|(i, (path, branch))| {
            let (claude_sessions, claude_last_ts) = scan_claude_sessions(&home, &path);
            let (codex_sessions, codex_last_ts) = codex
                .get(&path)
                .map(|&(n, ts)| (n, Some(ts)))
                .unwrap_or((0, None));
            DetectedWorktree {
                path,
                branch,
                is_main: i == 0,
                claude_sessions,
                claude_last_ts,
                codex_sessions,
                codex_last_ts,
            }
        })
        .collect())
}

/// Claude Code encodes a session cwd by replacing every non-alphanumeric
/// char with '-' (e.g. /a/b.c -> -a-b-c).
fn encode_claude_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Claude Code stores sessions under ~/.claude/projects/<encoded cwd>/.
fn scan_claude_sessions(home: &Path, cwd: &str) -> (u32, Option<u64>) {
    let dir = home.join(".claude").join("projects").join(encode_claude_cwd(cwd));
    let mut count = 0u32;
    let mut last: Option<u64> = None;
    let Ok(rd) = std::fs::read_dir(dir) else {
        return (0, None);
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "jsonl") {
            count += 1;
            if let Some(ms) = mtime_ms(&e) {
                last = Some(last.map_or(ms, |l| l.max(ms)));
            }
        }
    }
    (count, last)
}

/// Codex stores sessions as ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl;
/// the first line is a session_meta record whose payload carries the cwd.
/// Returns cwd -> (session count, latest mtime ms) for recent files.
fn scan_codex_sessions(home: &Path) -> HashMap<String, (u32, u64)> {
    let mut files: Vec<(PathBuf, u64)> = Vec::new();
    collect_jsonl(&home.join(".codex").join("sessions"), &mut files, 5);
    files.sort_by_key(|file| std::cmp::Reverse(file.1));
    files.truncate(CODEX_SCAN_CAP);

    let mut map: HashMap<String, (u32, u64)> = HashMap::new();
    for (p, mtime) in files {
        let Some(cwd) = codex_session_cwd(&p) else {
            continue;
        };
        let e = map.entry(cwd).or_insert((0, 0));
        e.0 += 1;
        e.1 = e.1.max(mtime);
    }
    map
}

fn collect_jsonl(dir: &Path, out: &mut Vec<(PathBuf, u64)>, depth: u32) {
    if depth == 0 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_jsonl(&p, out, depth - 1);
        } else if p.extension().is_some_and(|x| x == "jsonl") {
            out.push((p, mtime_ms(&e).unwrap_or(0)));
        }
    }
}

fn codex_session_cwd(p: &Path) -> Option<String> {
    let f = std::fs::File::open(p).ok()?;
    let mut line = String::new();
    std::io::BufReader::new(f).read_line(&mut line).ok()?;
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    Some(v.get("payload")?.get("cwd")?.as_str()?.to_string())
}

fn mtime_ms(e: &std::fs::DirEntry) -> Option<u64> {
    let m = e.metadata().ok()?.modified().ok()?;
    Some(m.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn safe_conv_id(conv_id: &str) -> String {
    conv_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

/// Copy a claude session log to another cwd's project dir, so
/// `claude --resume <id>` works from the new worktree (fork).
pub fn copy_claude_session(from_cwd: &str, to_cwd: &str, conv_id: &str) -> Result<(), String> {
    let home = PathBuf::from(std::env::var("HOME").map_err(|e| e.to_string())?);
    let projects = home.join(".claude").join("projects");
    let file = format!("{}.jsonl", safe_conv_id(conv_id));
    let src = projects.join(encode_claude_cwd(from_cwd)).join(&file);
    let dst_dir = projects.join(encode_claude_cwd(to_cwd));
    std::fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;
    std::fs::copy(&src, dst_dir.join(&file))
        .map_err(|e| format!("Could not copy the session file ({}): {e}", src.display()))?;
    Ok(())
}

/// Same copy as a shell command, for remote (ssh) forks.
pub fn copy_claude_session_command(from_cwd: &str, to_cwd: &str, conv_id: &str) -> String {
    let file = format!("{}.jsonl", safe_conv_id(conv_id));
    let enc_from = encode_claude_cwd(from_cwd);
    let enc_to = encode_claude_cwd(to_cwd);
    format!(
        "mkdir -p \"$HOME/.claude/projects/{enc_to}\" && \
         cp \"$HOME/.claude/projects/{enc_from}/{file}\" \"$HOME/.claude/projects/{enc_to}/{file}\""
    )
}

/// POSIX shell script that performs the same scan on a remote host over ssh.
/// Emits a line-based format parsed by `parse_scan`:
///   W <worktree path>
///   B <branch>
///   C <claude session count> <mtime seconds>
///   S <mtime seconds> <codex session cwd>
/// `stat -c` is GNU (Linux), `stat -f` the BSD/macOS fallback.
pub fn scan_command(repo: &str) -> String {
    format!(
        r#"REPO='{repo}'
git -C "$REPO" worktree list --porcelain | while IFS= read -r line; do
  case "$line" in
    "worktree "*)
      p="${{line#worktree }}"
      echo "W $p"
      enc=$(printf '%s' "$p" | sed 's/[^a-zA-Z0-9]/-/g')
      d="$HOME/.claude/projects/$enc"
      n=$(find "$d" -maxdepth 1 -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')
      mt=0
      if [ "$n" -gt 0 ]; then
        newest=$(ls -t "$d"/*.jsonl 2>/dev/null | head -1)
        [ -n "$newest" ] && mt=$(stat -c %Y "$newest" 2>/dev/null || stat -f %m "$newest" 2>/dev/null || echo 0)
      fi
      echo "C $n $mt"
      ;;
    "branch refs/heads/"*) echo "B ${{line#branch refs/heads/}}" ;;
    "detached") echo "B (detached)" ;;
  esac
done
find "$HOME/.codex/sessions" -type f -name '*.jsonl' 2>/dev/null | sort -r | head -{cap} | while IFS= read -r f; do
  cwd=$(head -1 "$f" 2>/dev/null | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p')
  if [ -n "$cwd" ]; then
    mt=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
    echo "S $mt $cwd"
  fi
done
true"#,
        // 셸 주입 방지 — repo 경로의 작은따옴표를 이스케이프('→'\''). REPO='{repo}'
        // 안에서 안전하게 닫히고 다시 열린다.
        repo = repo.replace('\'', "'\\''"),
        cap = CODEX_SCAN_CAP,
    )
}

/// Parse the output of the `scan_command` script into worktrees.
pub fn parse_scan(output: &str) -> Vec<DetectedWorktree> {
    let mut wts: Vec<DetectedWorktree> = Vec::new();
    let mut codex: HashMap<String, (u32, u64)> = HashMap::new();
    for line in output.lines() {
        if let Some(p) = line.strip_prefix("W ") {
            wts.push(DetectedWorktree {
                path: p.to_string(),
                is_main: wts.is_empty(),
                ..Default::default()
            });
        } else if let Some(b) = line.strip_prefix("B ") {
            if let Some(w) = wts.last_mut() {
                w.branch = b.to_string();
            }
        } else if let Some(c) = line.strip_prefix("C ") {
            let mut it = c.split_whitespace();
            let n: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            let mt: u64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            if let Some(w) = wts.last_mut() {
                w.claude_sessions = n;
                w.claude_last_ts = (n > 0 && mt > 0).then_some(mt * 1000);
            }
        } else if let Some(s) = line.strip_prefix("S ") {
            let Some((mt, cwd)) = s.split_once(' ') else {
                continue;
            };
            let mt: u64 = mt.parse().unwrap_or(0);
            let e = codex.entry(cwd.to_string()).or_insert((0, 0));
            e.0 += 1;
            e.1 = e.1.max(mt * 1000);
        }
    }
    for w in &mut wts {
        if let Some(&(n, mt)) = codex.get(&w.path) {
            w.codex_sessions = n;
            w.codex_last_ts = (mt > 0).then_some(mt);
        }
    }
    wts
}

#[cfg(test)]
mod tests {
    #[test]
    fn parse_scan_output() {
        let out = "\
W /srv/app
B main
C 2 1700000000
W /srv/app/.worktrees/agent x
B agent/x
C 0 0
S 1700000100 /srv/app/.worktrees/agent x
S 1700000200 /srv/app/.worktrees/agent x
S 1700000000 /elsewhere
";
        let wts = super::parse_scan(out);
        assert_eq!(wts.len(), 2);
        assert!(wts[0].is_main);
        assert_eq!(wts[0].claude_sessions, 2);
        assert_eq!(wts[0].claude_last_ts, Some(1_700_000_000_000));
        assert_eq!(wts[1].path, "/srv/app/.worktrees/agent x");
        assert_eq!(wts[1].branch, "agent/x");
        assert_eq!(wts[1].claude_last_ts, None);
        assert_eq!(wts[1].codex_sessions, 2);
        assert_eq!(wts[1].codex_last_ts, Some(1_700_000_200_000));
    }
}
