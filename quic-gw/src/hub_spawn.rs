// hub をゲートウェイの子孫として起動する固定コマンド専用の口。
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixListener;

#[derive(Clone)]
pub struct HubSpawnOptions {
    pub socket_path: PathBuf,
    pub log_path: PathBuf,
    pub command: String,
    pub home: Option<PathBuf>,
}
impl Default for HubSpawnOptions {
    fn default() -> Self {
        Self {
            socket_path: PathBuf::from(crate::expand_home("~/.tailii/run/gw-spawn.sock")),
            log_path: PathBuf::from(crate::expand_home("~/.tailii/hub.log")),
            command: "exec ~/.local/bin/tailii-host hub".into(),
            home: None,
        }
    }
}

pub struct HubSpawnServer {
    task: tokio::task::JoinHandle<()>,
    socket: PathBuf,
    inode: u64,
}
impl Drop for HubSpawnServer {
    fn drop(&mut self) {
        self.task.abort();
        // 後継のサービスが同じ名前で待ち受けていたら消さない。
        if std::fs::symlink_metadata(&self.socket).is_ok_and(|m| m.ino() == self.inode) {
            let _ = std::fs::remove_file(&self.socket);
        }
    }
}
impl HubSpawnServer {
    pub fn start(options: HubSpawnOptions, path: String) -> std::io::Result<Self> {
        if let Some(parent) = options.socket_path.parent() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)?;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
        match std::fs::remove_file(&options.socket_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let listener = UnixListener::bind(&options.socket_path)?;
        if let Err(e) =
            std::fs::set_permissions(&options.socket_path, std::fs::Permissions::from_mode(0o600))
        {
            let _ = std::fs::remove_file(&options.socket_path);
            return Err(e);
        }
        let socket = options.socket_path.clone();
        let inode = std::fs::symlink_metadata(&socket)?.ino();
        let task = tokio::spawn(async move {
            let mut last_spawn: Option<(Instant, u32)> = None;
            loop {
                let (mut client, _) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(e) => {
                        crate::log_line(&format!("gw-spawn accept failed: {e}"));
                        break;
                    }
                };
                // 不完全な要求で後続を永久に待たせない。要求をコマンドへ展開することはない。
                let request = tokio::time::timeout(
                    Duration::from_secs(1),
                    crate::read_control_line(&mut client),
                )
                .await;
                let valid = match request {
                    Ok(Ok(line)) => serde_json::from_slice::<serde_json::Value>(&line)
                        .ok()
                        .is_some_and(|value| value == serde_json::json!({"spawn":"hub"})),
                    _ => false,
                };
                let pid = if !valid {
                    None
                } else if let Some((_, pid)) =
                    last_spawn.filter(|(at, _)| at.elapsed() < Duration::from_secs(3))
                {
                    Some(pid)
                } else {
                    match spawn_hub(&options, &path) {
                        Ok(mut child) => {
                            let pid = child.id();
                            if let Some(pid) = pid {
                                last_spawn = Some((Instant::now(), pid));
                            }
                            // detached の子も wait して zombie を残さない。hub は GW の終了後も存続できる。
                            tokio::spawn(async move {
                                let _ = child.wait().await;
                            });
                            pid
                        }
                        Err(e) => {
                            crate::log_line(&format!("gw-spawn hub spawn failed: {e}"));
                            None
                        }
                    }
                };
                let reply = if let Some(pid) = pid {
                    format!("{{\"ok\":true,\"pid\":{pid}}}\n")
                } else {
                    "{\"ok\":false}\n".into()
                };
                let _ = tokio::time::timeout(
                    Duration::from_secs(1), client.write_all(reply.as_bytes()),
                ).await;
            }
        });
        Ok(Self {
            task,
            socket,
            inode,
        })
    }
}

fn spawn_hub(options: &HubSpawnOptions, path: &str) -> std::io::Result<tokio::process::Child> {
    if let Some(parent) = options.log_path.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    }
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&options.log_path)?;
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(&options.command)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        .env("PATH", path)
        .env("TAILII_HUB_VIA_GATEWAY", "1");
    if let Some(home) = &options.home {
        command.env("HOME", home);
    }
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn()
}
