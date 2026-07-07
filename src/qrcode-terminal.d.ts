// qrcode-terminal.d.ts — 型定義の無い qrcode-terminal（ゼロ依存）向けの最小アンビエント宣言。
// 実体は CJS だが Node の ESM 相互運用で default = module.exports として取り込む。

declare module "qrcode-terminal" {
  interface GenerateOptions {
    /** true でハーフブロック（▀▄）を使い密度を上げる。 */
    small?: boolean;
  }
  function generate(input: string, options: GenerateOptions, callback: (qrcode: string) => void): void;
  function generate(input: string, callback: (qrcode: string) => void): void;
  function generate(input: string, options?: GenerateOptions): void;
  function setErrorLevel(level: "L" | "M" | "Q" | "H"): void;

  const _default: { generate: typeof generate; setErrorLevel: typeof setErrorLevel };
  export default _default;
}
