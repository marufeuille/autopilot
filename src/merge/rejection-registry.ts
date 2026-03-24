/**
 * RejectionRegistry
 *
 * Bolt action handler とポーリングループ間で却下シグナルを受け渡すための
 * インメモリ Registry。prUrl をキーにするため並行タスクでも安全。
 *
 * シグナルのバッファリング機能を持ち、waitForRejection より先に
 * signalRejection が呼ばれた場合でもシグナルが失われない。
 */

type ResolveFunc = (reason: string) => void;

const registry = new Map<string, ResolveFunc>();
const pendingSignals = new Map<string, string>();

/**
 * 指定 prUrl の却下シグナルを待機する Promise を返す。
 * signalRejection が呼ばれると reason 文字列で resolve される。
 *
 * 既にバッファリングされたシグナルがある場合は即座に resolve する。
 */
export function waitForRejection(prUrl: string): Promise<string> {
  // 先行シグナルがバッファされている場合は即座に resolve
  const buffered = pendingSignals.get(prUrl);
  if (buffered !== undefined) {
    pendingSignals.delete(prUrl);
    return Promise.resolve(buffered);
  }

  return new Promise<string>((resolve) => {
    registry.set(prUrl, resolve);
  });
}

/**
 * 指定 prUrl の却下シグナルを送信する。
 * waitForRejection で待機中の Promise を reason で resolve し、エントリを削除する。
 *
 * 待機中のリスナーがいない場合はシグナルをバッファリングし、
 * 後続の waitForRejection で即座に resolve される。
 *
 * @returns 待機中のエントリが存在して即座に resolve できた場合 true、バッファリングした場合 false
 */
export function signalRejection(prUrl: string, reason: string): boolean {
  const resolve = registry.get(prUrl);
  if (!resolve) {
    // リスナー未登録 — シグナルをバッファリングして後続の waitForRejection に備える
    pendingSignals.set(prUrl, reason);
    return false;
  }
  registry.delete(prUrl);
  resolve(reason);
  return true;
}

/**
 * 指定 prUrl の待機エントリを削除し、保留中の Promise を完了させる（クリーンアップ用）。
 * ポーリング側が先に完了した場合に waitForRejection の Promise がリークしないよう、
 * resolve を呼んで Promise を確定させてから registry とバッファを取り除く。
 */
export function cancelWaitForRejection(prUrl: string): void {
  const resolve = registry.get(prUrl);
  if (resolve) {
    // Promise を完了させてメモリリークを防止。
    // Promise.race で既にポーリング側が勝っているため、この値は使われない。
    resolve('__cancelled__');
  }
  registry.delete(prUrl);
  pendingSignals.delete(prUrl);
}

/**
 * @internal テスト用: 全エントリとバッファをクリアする
 */
export function _resetForTest(): void {
  registry.clear();
  pendingSignals.clear();
}
