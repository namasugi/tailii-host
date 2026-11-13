// 待機プロセスは単一の管理タスクで補充する。失敗しても通常の exec を妨げない。
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime};

use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

const HOST: &str = "~/.local/bin/tailii-host";

/// シェルとして解釈せず、iOS が生成する既知の文字列だけを受け入れる。
pub fn parse_command(cmd: &str) -> Option<Vec<String>> {
    let tail = cmd.strip_prefix(&format!("{HOST} "))?;
    let sub = tail.split_once(';').map_or(tail, |(sub, _)| sub);
    let parts: Vec<&str> = sub.split(' ').collect();
    match parts.as_slice() {
        ["engine"] => {}
        ["serve", "--session", name] | ["serve", "--session", name, "--client-id", _]
            if !name.is_empty()
                && name.len() <= 128
                && name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) =>
        {
            if parts.len() == 5 {
                let uuid = parts[4];
                if uuid.len() != 36
                    || !uuid
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || c == b'-')
                {
                    return None;
                }
            }
        }
        _ => return None,
    }
    let fallback = format!("{HOST} {sub}; s=$?; if [ $s -eq 126 ] || [ $s -eq 127 ]; then exec {HOST}.prev {sub}; fi; exit $s");
    if cmd != format!("{HOST} {sub}") && cmd != fallback {
        return None;
    }
    Some(parts.iter().map(|s| s.to_string()).collect())
}

pub fn standby_count(value: Option<&str>) -> usize {
    value
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(2)
        .clamp(0, 4) as usize
}

#[derive(Clone)]
pub struct StandbyOptions {
    pub count: usize,
    pub command: String,
    pub shim_path: PathBuf,
    pub ack_timeout: Duration,
    /// テストでも実 HOME の host は起動しない。
    pub home: Option<PathBuf>,
}
impl Default for StandbyOptions {
    fn default() -> Self {
        Self {
            count: standby_count(std::env::var("TAILII_QUIC_STANDBY").ok().as_deref()),
            // process.title 用の argv 領域を確保する（有効化後のセッション名まで表示）。
            command: format!("exec {HOST} standby {}", "_".repeat(512)),
            shim_path: PathBuf::from(crate::expand_home("~/.local/bin/tailii-host")),
            ack_timeout: Duration::from_secs(5),
            home: None,
        }
    }
}

#[derive(PartialEq, Eq)]
struct Fingerprint {
    modified: SystemTime,
    size: u64,
    inode: u64,
}
fn fingerprint(path: &PathBuf) -> Option<Fingerprint> {
    let m = std::fs::metadata(path).ok()?;
    Some(Fingerprint {
        modified: m.modified().ok()?,
        size: m.len(),
        inode: m.ino(),
    })
}
struct Idle {
    child: Child,
    control: tokio::net::UnixStream,
    shim: Option<Fingerprint>,
}

fn spawn(options: &StandbyOptions, path: &str) -> std::io::Result<Idle> {
    let (parent, child_socket) = std::os::unix::net::UnixStream::pair()?;
    parent.set_nonblocking(true)?;
    // fd 3 は spawn の stdio 配置と衝突しない番号から複製する。
    let fd = unsafe { libc::fcntl(child_socket.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 10) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let control_fd = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
    let shim = fingerprint(&options.shim_path);
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(&options.command)
        .env("PATH", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(home) = &options.home {
        command.env("HOME", home);
    }
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(fd, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    drop(control_fd);
    drop(child_socket);
    Ok(Idle {
        child,
        control: tokio::net::UnixStream::from_std(parent)?,
        shim,
    })
}

enum Request {
    Take(oneshot::Sender<Option<Idle>>),
    Activated,
    EarlyExit,
}
#[derive(Clone)]
pub(crate) struct StandbyHandle {
    tx: mpsc::Sender<Request>,
    timeout: Duration,
}
/// この所有者を落とせば接続タスクの有無によらず待機中の子を回収する。
pub(crate) struct StandbyPool {
    pub handle: StandbyHandle,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for StandbyPool {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl StandbyPool {
    pub fn start(options: StandbyOptions, path: String) -> Self {
        let (tx, mut rx) = mpsc::channel::<Request>(16);
        let handle = StandbyHandle {
            tx,
            timeout: options.ack_timeout.min(Duration::from_secs(5)),
        };
        let task = tokio::spawn(async move {
            let mut idle: Vec<Idle> = Vec::new();
            let mut next = Instant::now();
            let mut backoff = Duration::ZERO;
            let mut logged = Duration::ZERO;
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            loop {
                tokio::select! {
                    request = rx.recv() => {
                        let reply = match request {
                            Some(Request::Take(reply)) => reply,
                            Some(Request::Activated) => {
                                backoff = Duration::ZERO;
                                logged = Duration::ZERO;
                                next = Instant::now() + Duration::from_secs(2);
                                continue;
                            }
                            Some(Request::EarlyExit) => {
                                note_early_exit(&mut backoff, &mut logged, &mut next);
                                continue;
                            }
                            None => break,
                        };
                        let picked = idle.pop();
                        if let Some(entry) = picked {
                            next = next.max(Instant::now() + Duration::from_secs(2));
                            if entry.shim.is_none() || fingerprint(&options.shim_path) != entry.shim {
                                idle.clear();
                                drop(entry);
                                backoff = Duration::ZERO;
                                logged = Duration::ZERO;
                                next = Instant::now() + Duration::from_secs(2);
                                let _ = reply.send(None);
                            } else {
                                let _ = reply.send(Some(entry));
                            }
                        } else { let _ = reply.send(None); }
                    }
                    _ = tick.tick() => {
                        let mut i = 0;
                        while i < idle.len() {
                            match idle[i].child.try_wait() {
                                Ok(None) => { i += 1; }
                                result => {
                                    idle.swap_remove(i);
                                    // 有効化前の失敗は、何秒生存していても成功とみなさない。
                                    let success = matches!(result, Ok(Some(status)) if status.success());
                                    note_idle_exit(success, &mut backoff, &mut logged, &mut next);
                                }
                            }
                        }
                        if idle.len() < options.count.min(4) && Instant::now() >= next {
                            match spawn(&options, &path) {
                                Ok(entry) => { idle.push(entry); next = Instant::now() + Duration::from_secs(2); }
                                Err(e) => {
                                    backoff = retry_delay(backoff);
                                    if logged != backoff {
                                        crate::log_line(&format!("standby spawn failed: {e}; retry in {}s", backoff.as_secs()));
                                        logged = backoff;
                                    }
                                    next = Instant::now() + backoff;
                                }
                            }
                        }
                    }
                }
            }
        });
        Self { handle, task }
    }
}
fn note_idle_exit(success: bool, backoff: &mut Duration, logged: &mut Duration, next: &mut Instant) {
    if success {
        *next = (*next).max(Instant::now() + Duration::from_secs(2));
    } else {
        note_early_exit(backoff, logged, next);
    }
}
fn note_early_exit(backoff: &mut Duration, logged: &mut Duration, next: &mut Instant) {
    *backoff = retry_delay(*backoff);
    if *logged != *backoff {
        crate::log_line(&format!(
            "standby early exit; retry in {}s",
            backoff.as_secs()
        ));
        *logged = *backoff;
    }
    *next = Instant::now() + *backoff;
}

fn retry_delay(previous: Duration) -> Duration {
    if previous.is_zero() {
        Duration::from_secs(30)
    } else {
        (previous * 2).min(Duration::from_secs(600))
    }
}
impl StandbyHandle {
    pub async fn activate(&self, argv: Vec<String>) -> Option<Child> {
        let (reply, result) = oneshot::channel();
        self.tx.send(Request::Take(reply)).await.ok()?;
        let mut idle = result.await.ok()??;
        // まだクライアントの stdin は渡さない。制御 ACK を受けた場合だけ既存の配管へ進む。
        let accepted = tokio::time::timeout(self.timeout, async {
            idle.control
                .write_all(
                    format!("{}\n", serde_json::json!({"activate": {"argv": argv}})).as_bytes(),
                )
                .await
                .ok()?;
            let line = crate::read_control_line(&mut idle.control).await.ok()?;
            let value: serde_json::Value = serde_json::from_slice(&line).ok()?;
            (value.get("ok") == Some(&serde_json::Value::Bool(true))).then_some(())
        })
        .await;
        if matches!(accepted, Ok(Some(()))) {
            let _ = self.tx.send(Request::Activated).await;
            Some(idle.child)
        } else {
            crate::log_line("standby activation failed; falling back to exec");
            // stale / EOF の正常終了だけは通常補充。拒否・異常終了・無応答は失敗として間をあける。
            let success = matches!(
                tokio::time::timeout(Duration::from_millis(100), idle.child.wait()).await,
                Ok(Ok(status)) if status.success()
            );
            let _ = idle.child.kill().await;
            if !success {
                let _ = self.tx.send(Request::EarlyExit).await;
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_commands_only() {
        for sub in [
            "engine",
            "serve --session a._-9",
            "serve --session x --client-id 01234567-89ab-cdef-0123-456789abcdef",
        ] {
            let plain = format!("{HOST} {sub}");
            let fallback = format!("{plain}; s=$?; if [ $s -eq 126 ] || [ $s -eq 127 ]; then exec {HOST}.prev {sub}; fi; exit $s");
            assert!(parse_command(&plain).is_some());
            assert_eq!(parse_command(&plain), parse_command(&fallback));
            for bad in [
                format!("{plain};"),
                format!("{plain} "),
                format!("{fallback}; echo oops"),
                fallback.replace(".prev", ".other"),
                fallback.replace("exit $s", "exit 0"),
            ] {
                assert!(parse_command(&bad).is_none(), "{bad}");
            }
        }
        for bad in ["/tmp/tailii-host engine", "~/.local/bin/tailii-host engine$(id)", "~/.local/bin/tailii-host serve --session $(id)", "~/.local/bin/tailii-host serve --session a;b", "~/.local/bin/tailii-host serve --session", "~/.local/bin/tailii-host hub", "~/.local/bin/tailii-host  engine", "~/.local/bin/tailii-host engine\n", "~/.local/bin/tailii-host serve --session x --client-id A1234567-89ab-cdef-0123-456789abcdef"] { assert!(parse_command(bad).is_none(), "{bad}"); }
        assert!(parse_command(&format!("{HOST} serve --session {}", "a".repeat(129))).is_none());
    }
    #[test]
    fn bounds_and_backoff() {
        assert_eq!(
            [
                None,
                Some("-1"),
                Some("0"),
                Some("4"),
                Some("99"),
                Some("bad")
            ]
            .map(standby_count),
            [2, 0, 0, 4, 4, 2]
        );
        let mut delay = Duration::ZERO;
        for expected in [30, 60, 120, 240, 480, 600, 600] {
            delay = retry_delay(delay);
            assert_eq!(delay.as_secs(), expected);
        }
    }

    #[test]
    fn idle_exit_uses_status_without_resetting_for_long_lifetime() {
        let mut backoff = Duration::ZERO;
        let mut logged = Duration::ZERO;
        let mut next = Instant::now();
        // 生存時間ではリセットしないため、遅れて落ちる旧 host でも失敗は積み上がる。
        for seconds in [30, 60, 120] {
            let before = Instant::now();
            note_idle_exit(false, &mut backoff, &mut logged, &mut next);
            assert_eq!(backoff, Duration::from_secs(seconds));
            assert!(next >= before + backoff);
        }
        next = Instant::now();
        let before = next;
        note_idle_exit(true, &mut backoff, &mut logged, &mut next);
        assert!(next >= before + Duration::from_secs(2));
        assert!(next < before + Duration::from_secs(3));
        assert_eq!(backoff, Duration::from_secs(120));
    }
}
