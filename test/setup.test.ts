// setup.test.ts — setup サブコマンドの単体テスト
// Swift 版 PairingPayloadEmitTests（--emit-payload の byte 形状 fidelity）+ 鍵/authorized_keys ロジックの移植。
//
// 契約: --emit-payload の JSON は protocol/pairing-payload-v{1,2}.json と byte 一致
// （sortedKeys・prettyPrinted・`/`→`\/`）。実 ~/.tailii/~/.ssh には触れず一時 dir を注入。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  detectLanIP,
  emitPayloadJSON,
  encodePairingPayload,
  ensureKeypair,
  registerAuthorizedKey,
} from "../src/setup.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tailii-${prefix}-`));
}

/** golden の REDACTED プレースホルダ鍵（実鍵を repo に持ち込まないための固定値）。 */
const REDACTED_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nREDACTED-POC-KEY-DO-NOT-USE\n-----END OPENSSH PRIVATE KEY-----\n";

// MARK: - encodePairingPayload（golden と byte 一致）

describe("encodePairingPayload", () => {
  it("v1 が golden pairing-payload-v1.json と byte 一致する", () => {
    const golden = fs.readFileSync(path.join(REPO_ROOT, "protocol", "pairing-payload-v1.json"), "utf8");
    const encoded = encodePairingPayload({
      host: "192.168.1.2",
      port: 22,
      user: "alice",
      key: REDACTED_KEY,
    });
    // golden はファイル末尾に改行あり。encode は本体のみを返すため "\n" を付けて比較する。
    expect(encoded + "\n").toBe(golden);
  });

  it("v2 が golden pairing-payload-v2.json と byte 一致する（`/`→`\\/` エスケープ込み）", () => {
    const golden = fs.readFileSync(path.join(REPO_ROOT, "protocol", "pairing-payload-v2.json"), "utf8");
    const encoded = encodePairingPayload({
      host: "192.168.1.2",
      port: 22,
      user: "alice",
      key: REDACTED_KEY,
      sessionName: "work",
      sessionCwd: "/Users/alice/proj",
    });
    expect(encoded + "\n").toBe(golden);
    // sessionCwd が sortedKeys 形式で `\/` エスケープされている。
    expect(encoded).toContain('"sessionCwd" : "\\/Users\\/alice\\/proj"');
  });

  it("v2 で session-cwd 未指定なら sessionCwd を JSON から省略する", () => {
    const encoded = encodePairingPayload({
      host: "h",
      port: 22,
      user: "u",
      key: "k",
      sessionName: "work",
    });
    const obj = JSON.parse(encoded);
    expect(obj.v).toBe(2);
    expect(obj.sessionName).toBe("work");
    expect(Object.keys(obj).sort()).toEqual(["host", "key", "port", "sessionName", "user", "v"]);
  });

  it("秘密鍵内の `/` も `\\/` にエスケープする（Swift JSONEncoder パリティ）", () => {
    const encoded = encodePairingPayload({ host: "h", port: 22, user: "u", key: "a/b+c" });
    expect(encoded).toContain('"key" : "a\\/b+c"');
    // JSON として復号すると元に戻る。
    expect(JSON.parse(encoded).key).toBe("a/b+c");
  });
});

// MARK: - emitPayloadJSON（副作用なし）

describe("emitPayloadJSON", () => {
  it("既存の秘密鍵があれば読み込んで payload に載せる", () => {
    const base = tempDir("emit");
    fs.writeFileSync(path.join(base, "poc_id_ed25519"), REDACTED_KEY);
    const json = emitPayloadJSON({ base, username: "alice", lanIP: "192.168.1.2" });
    const obj = JSON.parse(json);
    expect(obj.v).toBe(1);
    expect(obj.key).toBe(REDACTED_KEY);
    expect(obj.host).toBe("192.168.1.2");
    expect(obj.user).toBe("alice");
    expect(obj.port).toBe(22);
  });

  it("鍵が無ければ擬似値で継続する（形状検査目的）", () => {
    const json = emitPayloadJSON({ base: tempDir("emit"), username: "u", lanIP: "1.2.3.4" });
    expect(JSON.parse(json).key).toBe("<no-private-key-emit-payload-mode>");
  });

  it("--session/--session-cwd 相当で v2 を発行する", () => {
    const base = tempDir("emit");
    fs.writeFileSync(path.join(base, "poc_id_ed25519"), REDACTED_KEY);
    const json = emitPayloadJSON({
      base,
      username: "alice",
      lanIP: "192.168.1.2",
      sessionName: "work",
      sessionCwd: "/Users/alice/proj",
    });
    const obj = JSON.parse(json);
    expect(obj.v).toBe(2);
    expect(obj.sessionName).toBe("work");
    expect(obj.sessionCwd).toBe("/Users/alice/proj");
  });
});

// MARK: - registerAuthorizedKey

describe("registerAuthorizedKey", () => {
  const PUB = "ssh-ed25519 AAAAC3Nza...key TailiiPoC";

  it("空の authorized_keys に追加する（0600）", () => {
    const sshDir = tempDir("ssh");
    expect(registerAuthorizedKey(sshDir, PUB)).toBe("added");
    const authKeys = path.join(sshDir, "authorized_keys");
    expect(fs.readFileSync(authKeys, "utf8")).toBe(PUB + "\n");
    expect(fs.statSync(authKeys).mode & 0o777).toBe(0o600);
  });

  it("既に登録済みなら二重登録しない（冪等）", () => {
    const sshDir = tempDir("ssh");
    registerAuthorizedKey(sshDir, PUB);
    expect(registerAuthorizedKey(sshDir, PUB)).toBe("already-present");
    expect(fs.readFileSync(path.join(sshDir, "authorized_keys"), "utf8")).toBe(PUB + "\n");
  });

  it("既存内容の末尾に改行が無くても壊さず追記する", () => {
    const sshDir = tempDir("ssh");
    const authKeys = path.join(sshDir, "authorized_keys");
    fs.writeFileSync(authKeys, "ssh-rsa EXISTING other@host"); // 末尾改行なし
    expect(registerAuthorizedKey(sshDir, PUB)).toBe("added");
    expect(fs.readFileSync(authKeys, "utf8")).toBe("ssh-rsa EXISTING other@host\n" + PUB + "\n");
  });
});

// MARK: - ensureKeypair（keygen 注入）

describe("ensureKeypair", () => {
  /** ssh-keygen を回避するダミー keygen（keyPath と keyPath.pub にダミー鍵を書く）。 */
  function fakeKeygen(keyPath: string): void {
    fs.writeFileSync(keyPath, REDACTED_KEY);
    fs.writeFileSync(`${keyPath}.pub`, "ssh-ed25519 AAAAFAKE TailiiPoC\n");
  }

  it("鍵が無ければ生成し、PEM と公開鍵行を返す", () => {
    const base = tempDir("keys");
    const result = ensureKeypair(base, fakeKeygen);
    expect(result.status).toBe("generated");
    expect(result.privateKeyPem).toBe(REDACTED_KEY);
    expect(result.publicKeyLine).toBe("ssh-ed25519 AAAAFAKE TailiiPoC"); // trim 済み
    expect(fs.existsSync(path.join(base, "poc_id_ed25519"))).toBe(true);
  });

  it("鍵が既存なら再利用して keygen を呼ばない", () => {
    const base = tempDir("keys");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "poc_id_ed25519"), REDACTED_KEY);
    fs.writeFileSync(path.join(base, "poc_id_ed25519.pub"), "ssh-ed25519 REUSED TailiiPoC\n");
    let called = false;
    const result = ensureKeypair(base, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(result.status).toBe("reused");
    expect(result.publicKeyLine).toBe("ssh-ed25519 REUSED TailiiPoC");
  });
});

// MARK: - detectLanIP

describe("detectLanIP", () => {
  it("en0 の非内部 IPv4 を優先する", () => {
    const ip = detectLanIP({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo],
      en0: [{ address: "192.168.1.20", family: "IPv4", internal: false } as os.NetworkInterfaceInfo],
      en1: [{ address: "10.0.0.5", family: "IPv4", internal: false } as os.NetworkInterfaceInfo],
    });
    expect(ip).toBe("192.168.1.20");
  });

  it("en0/en1 が無ければ最初の非内部 IPv4 を返す", () => {
    const ip = detectLanIP({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo],
      utun3: [{ address: "172.16.4.9", family: "IPv4", internal: false } as os.NetworkInterfaceInfo],
    });
    expect(ip).toBe("172.16.4.9");
  });

  it("非内部 IPv4 が無ければ空文字", () => {
    expect(
      detectLanIP({
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo],
      }),
    ).toBe("");
  });
});
