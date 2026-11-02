import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installQuicGatewayBinary } from "../src/services/quicGateway.js";
import {
  prepareQuicGatewaySignature,
  quicGatewaySigningIdentityPath,
} from "../src/services/quicGatewaySigning.js";

const requirement = 'identifier "com.tailii.quic-gw" and anchor apple generic and certificate leaf[subject.CN] = "Apple Development: fixture"';
const stableDescription = `Identifier=com.tailii.quic-gw\nAuthority=Apple Development: fixture\ndesignated => ${requirement}\n`;

describe("QUIC gateway の更新時コード署名", () => {
  let fakeHome: string;
  let previousHome: string | undefined;
  let installed: string;
  let source: string;

  beforeEach(() => {
    previousHome = process.env["HOME"];
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "tailii-quic-signing-"));
    process.env["HOME"] = fakeHome;
    installed = path.join(fakeHome, ".tailii", "bin", "tailii-quic-gw");
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, "working authorized gateway");
    source = path.join(fakeHome, "updated-gateway");
    fs.writeFileSync(source, "new gateway build");
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("ad-hoc の更新物が既設の証明書署名に一致しなければバイナリも許可条件も保持する", () => {
    expect(() => installQuicGatewayBinary(source, {
      platform: "darwin",
      codesign: (args) => {
        if (args[0] === "-d") return stableDescription;
        throw new Error("code failed to satisfy specified code requirement(s)");
      },
    })).toThrow("既設版を残しました");
    expect(fs.readFileSync(installed, "utf8")).toBe("working authorized gateway");
    expect(fs.readdirSync(path.dirname(installed))).toEqual(["tailii-quic-gw"]);
  });

  it("保存した証明書で候補を署名して同一の DR を検証してから入れ替える", () => {
    fs.writeFileSync(quicGatewaySigningIdentityPath(), "fixture-signing-identity\n");
    let signed = false;
    let identityChecked = false;
    const dest = installQuicGatewayBinary(source, {
      platform: "darwin",
      codesign: (args) => {
        if (args[0] === "--force") {
          expect(args[args.indexOf("--sign") + 1]).toBe("fixture-signing-identity");
          expect(args[args.indexOf("--identifier") + 1]).toBe("com.tailii.quic-gw");
          // 最後まで旧バイナリを残し、別ファイルだけに署名する。
          expect(args.at(-1)).not.toBe(installed);
          expect(fs.readFileSync(installed, "utf8")).toBe("working authorized gateway");
          signed = true;
        }
        if (args.includes("-R")) {
          expect(signed).toBe(true);
          expect(args[args.indexOf("-R") + 1]).toBe(`=${requirement}`);
          identityChecked = true;
        }
        return stableDescription;
      },
    });
    expect(identityChecked).toBe(true);
    expect(dest).toBe(installed);
    expect(fs.readFileSync(installed, "utf8")).toBe("new gateway build");
    expect(fs.statSync(installed).mode & 0o111).not.toBe(0);
    expect(fs.readdirSync(path.dirname(installed))).toEqual(["tailii-quic-gw"]);
  });

  it("同一内容の再設置でも ad-hoc から固定署名へ移行する", () => {
    fs.copyFileSync(source, installed);
    fs.writeFileSync(quicGatewaySigningIdentityPath(), "fixture-signing-identity\n");
    let signed = false;
    installQuicGatewayBinary(source, {
      platform: "darwin",
      codesign: (args) => {
        if (args[0] === "--force") {
          fs.appendFileSync(args.at(-1)!, ":certificate-signed");
          signed = true;
        }
        if (args.at(-1) === installed) {
          return 'Identifier=tailii_quic_gw-random\nSignature=adhoc\ndesignated => cdhash H"1234"\n';
        }
        return stableDescription;
      },
    });
    expect(signed).toBe(true);
    expect(fs.readFileSync(installed, "utf8")).toBe("new gateway build:certificate-signed");
    expect(fs.readdirSync(path.dirname(installed))).toEqual(["tailii-quic-gw"]);
  });

  it("秘密鍵が利用できなければ既設版を保持する", () => {
    expect(() => installQuicGatewayBinary(source, {
      platform: "darwin",
      identity: "unavailable-identity",
      codesign: () => { throw new Error("specified item could not be found in the keychain"); },
    })).toThrow("keychain");
    expect(fs.readFileSync(installed, "utf8")).toBe("working authorized gateway");
    expect(fs.readdirSync(path.dirname(installed))).toEqual(["tailii-quic-gw"]);
  });

  it("既設版の署名を調査できないときも上書きしない", () => {
    expect(() => installQuicGatewayBinary(source, {
      platform: "darwin",
      codesign: () => { throw new Error("codesign timed out"); },
    })).toThrow("timed out");
    expect(fs.readFileSync(installed, "utf8")).toBe("working authorized gateway");
  });

  it("既に同じ証明書で署名済みの配布物はローカル秘密鍵なしで更新できる", () => {
    let verified = false;
    installQuicGatewayBinary(source, {
      platform: "darwin",
      codesign: (args) => {
        if (args.includes("-R")) verified = true;
        return stableDescription;
      },
    });
    expect(verified).toBe(true);
    expect(fs.readFileSync(installed, "utf8")).toBe("new gateway build");
  });

  it("従来の ad-hoc 署名にはビルド固有の cdhash を継承しない", () => {
    prepareQuicGatewaySignature(source, installed, {
      platform: "darwin",
      codesign: (args) => {
        if (args.includes("-R")) throw new Error("legacy cdhash must not constrain updates");
        return 'Identifier=tailii_quic_gw-random\nSignature=adhoc\ndesignated => cdhash H"1234"\n';
      },
    });
  });

  it("Linux は macOS の署名設定に依存しない", () => {
    installQuicGatewayBinary(source, {
      platform: "linux",
      identity: "unused",
      codesign: () => { throw new Error("must not call codesign"); },
    });
    expect(fs.readFileSync(installed, "utf8")).toBe("new gateway build");
  });

  it("npm の過去 mtime かつ同サイズでも内容が違えば新版へ更新する", () => {
    fs.writeFileSync(installed, "old-build");
    fs.writeFileSync(source, "new-build");
    fs.utimesSync(source, new Date(0), new Date(0));
    installQuicGatewayBinary(source, { platform: "linux" });
    expect(fs.readFileSync(installed, "utf8")).toBe("new-build");
  });
});
