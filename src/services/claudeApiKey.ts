/** 通常のワークスペースキーと個人用キー。管理キー・OAuthトークンは対象外。 */
export function validClaudeApiKey(key: string): boolean {
  return key === key.trim() && /^[\x21-\x7e]+$/.test(key) && /^sk-ant-(?:api\d+|usr\d*)-[\x21-\x7e]{10,4000}$/.test(key);
}
