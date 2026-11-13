// Unix ソケットの固定コマンド起動と重複よけ。sandbox 外で実行する。
use std::{os::unix::fs::PermissionsExt, path::PathBuf, time::Duration};
use tailii_quic_gw::hub_spawn::{HubSpawnOptions, HubSpawnServer};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

struct Fixture {
    _server: Option<HubSpawnServer>,
    home: PathBuf,
    socket: PathBuf,
    log: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
    }
}
fn start() -> Fixture {
    let home = std::env::temp_dir().join(format!(
        "tgh-{}-{:x}",
        std::process::id(),
        rand::random::<u64>()
    ));
    let socket = home.join("run/g.sock");
    let log = home.join("hub.log");
    let command = "echo $$ > \"$HOME/pid\"; printf 'hub:%s:%s:%s\\n' \"$TAILII_HUB_VIA_GATEWAY\" \"$PATH\" \"$HOME\"; if read line; then echo unexpected-stdin; fi".into();
    let options = HubSpawnOptions {
        socket_path: socket.clone(),
        log_path: log.clone(),
        command,
        home: Some(home.clone()),
    };
    std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
    std::fs::write(&socket, "stale").unwrap();
    let server = HubSpawnServer::start(options, "/test/injected/path".into()).unwrap();
    Fixture {
        _server: Some(server),
        home,
        socket,
        log,
    }
}
async fn request(f: &Fixture, line: &str) -> String {
    let mut stream = tokio::net::UnixStream::connect(&f.socket).await.unwrap();
    stream
        .write_all(format!("{line}\n").as_bytes())
        .await
        .unwrap();
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).await.unwrap();
    reply
}
async fn wait_lines(f: &Fixture, count: usize) -> String {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let log = std::fs::read_to_string(&f.log).unwrap_or_default();
            if log.lines().count() >= count {
                break log;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn spawns_fixed_command_and_deduplicates_for_three_seconds() {
    let f = start();
    assert_eq!(
        std::fs::metadata(f.socket.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(&f.socket).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let reply: serde_json::Value = serde_json::from_str(&request(&f, r#"{"spawn":"hub"}"#).await).unwrap();
    assert_eq!(reply["ok"], true);
    let pid = reply["pid"].as_u64().unwrap();
    assert!(pid > 0);
    let log = wait_lines(&f, 1).await;
    assert_eq!(std::fs::read_to_string(f.home.join("pid")).unwrap().trim().parse::<u64>().unwrap(), pid);
    assert_eq!(
        log.trim(),
        format!("hub:1:/test/injected/path:{}", f.home.display())
    );
    assert_eq!(
        std::fs::metadata(&f.log).unwrap().permissions().mode() & 0o777,
        0o600
    );
    for _ in 0..3 {
        assert_eq!(serde_json::from_str::<serde_json::Value>(&request(&f, r#"{"spawn":"hub"}"#).await).unwrap(), reply);
    }
    assert_eq!(std::fs::read_to_string(&f.log).unwrap().lines().count(), 1);
    tokio::time::sleep(Duration::from_millis(3100)).await;
    let next: serde_json::Value = serde_json::from_str(&request(&f, r#"{"spawn":"hub"}"#).await).unwrap();
    assert_eq!(next["ok"], true);
    assert!(next["pid"].as_u64().unwrap() > 0);
    assert_ne!(next["pid"], reply["pid"]);
    assert_eq!(wait_lines(&f, 2).await.lines().count(), 2);
}
#[tokio::test]
async fn rejects_other_requests_without_spawning() {
    let f = start();
    for request_line in [
        "oops",
        r#"{"spawn":"engine"}"#,
        r#"{"spawn":"hub","cmd":"echo injected"}"#,
    ] {
        assert_eq!(request(&f, request_line).await, "{\"ok\":false}\n");
    }
    assert!(!f.log.exists());
}
#[tokio::test]
async fn closing_server_removes_socket() {
    let mut f = start();
    drop(f._server.take());
    assert!(!f.socket.exists());
    assert!(f.home.exists());
}
