/**
 * RejectionRegistry
 *
 * Bolt action handler とポーリングループ間で却下シグナルを受け渡すための
 * インメモリ Registry。prUrl をキーにするため並行タスクでも安全。
 */

type Resolve = (reason: string) => void;

const registry = new Map<string, Resolve>();

/**
 * 指定 prUrl の却下シグナルを待機する Promise を返す。
 * signalRejection が呼ばれると reason 文字列で resolve される。
 */
export function waitForRejection(prUrl: string): Promise<string> {
  return new Promise((resolve) => {
    registry.set(prUrl, resolve);
  });
}

/**
 * 指定 prUrl の却下シグナルを送信する。
 * waitForRejection で待機中の Promise を reason で resolve し、エントリを削除する。
 *
 * @returns 待機中のエントリが存在して resolve できた場合 true、未登録なら false
 */
export function signalRejection(prUrl: string, reason: string): boolean {
  const resolve = registry.get(prUrl);
  if (!resolve) return false;
  registry.delete(prUrl);
  resolve(reason);
  return true;
}
