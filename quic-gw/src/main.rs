// tailii-quic-gw — CLI エントリ
//
// 設計正本: docs/quic-transport.md（リポジトリルート）。
//
// 使い方:
//   tailii-quic-gw serve        [--port 46853] [--dir ~/.tailii/quic] [--path <PATH>]
//   tailii-quic-gw credentials  [--dir ~/.tailii/quic] [--json]
//   tailii-quic-gw client --pin <cert sha256 b64> --token <b64> [--host 127.0.0.1] [--port 46853]
//
//   serve        : ゲートウェイ本体（launchd 常駐）。監査ログは stdout
//                  （launchd が ~/.tailii/quic-gw.log にリダイレクトする）。
//   credentials  : 資格情報（P-256 証明書 / 32byte トークン）を生成 or 読込して表示する。
//                  `--json` は `tailii setup` が payload v3 を組むために使う機械可読出力。
//   client       : serve 中のゲートウェイへの自己検証（exec / pty / tcp / 認証拒否）。

use std::path::PathBuf;

use anyhow::{anyhow, bail, Result};
use tailii_quic_gw::{
    default_credentials_dir, expand_home, load_or_create_credentials, run_selfcheck, serve,
    GatewayOptions, DEFAULT_PORT,
};

struct Flags {
    port: u16,
    host: String,
    dir: PathBuf,
    pin: Option<String>,
    token: Option<String>,
    json: bool,
    path: Option<String>,
}

fn parse_flags(rest: &[String]) -> Result<Flags> {
    let mut flags = Flags {
        port: DEFAULT_PORT,
        host: "127.0.0.1".into(),
        dir: default_credentials_dir(),
        pin: None,
        token: None,
        json: false,
        path: None,
    };
    let mut it = rest.iter();
    while let Some(key) = it.next() {
        let mut val = || {
            it.next()
                .cloned()
                .ok_or_else(|| anyhow!("missing value for {key}"))
        };
        match key.as_str() {
            "--port" => flags.port = val()?.parse()?,
            "--host" => flags.host = val()?,
            "--dir" => flags.dir = PathBuf::from(expand_home(&val()?)),
            "--pin" => flags.pin = Some(val()?),
            "--token" => flags.token = Some(val()?),
            "--path" => flags.path = Some(val()?),
            "--json" => flags.json = true,
            other => bail!("unknown flag: {other}"),
        }
    }
    Ok(flags)
}

fn main() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("serve");
    let rest = if args.is_empty() { &args[..] } else { &args[1..] };
    let flags = parse_flags(rest)?;

    match mode {
        "serve" => {
            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(serve(GatewayOptions {
                dir: flags.dir,
                port: flags.port,
                injected_path: flags.path,
            }))
        }
        "credentials" => {
            let creds = load_or_create_credentials(&flags.dir)?;
            if flags.json {
                // `tailii setup` が消費する機械可読出力（stdout 1 行）。
                println!(
                    "{}",
                    serde_json::json!({
                        "dir": flags.dir.to_string_lossy(),
                        "spkiPin": creds.spki_pin(),
                        "certPin": creds.cert_pin(),
                        "token": creds.token_b64(),
                        "port": DEFAULT_PORT,
                    })
                );
            } else {
                println!("credentials dir : {}", flags.dir.display());
                println!("pin (spki sha256): {}", creds.spki_pin());
                println!("pin (cert sha256): {}", creds.cert_pin());
                println!("token            : {}", creds.token_b64());
            }
            Ok(())
        }
        "client" => {
            let pin = flags
                .pin
                .ok_or_else(|| anyhow!("--pin <cert sha256 b64> is required"))?;
            let token = flags
                .token
                .ok_or_else(|| anyhow!("--token <b64> is required"))?;
            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(run_selfcheck(&flags.host, flags.port, &pin, &token))
        }
        other => bail!("unknown mode: {other} (expected: serve | credentials | client)"),
    }
}
