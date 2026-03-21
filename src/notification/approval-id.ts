/**
 * 承認リクエストの一意識別子を生成する
 *
 * ストーリー slug、タスク slug、タイムスタンプを組み合わせて
 * 各承認リクエストが一意になるようにする。
 */
export function generateApprovalId(storySlug: string, taskSlug: string): string {
  return `${storySlug}--${taskSlug}--${Date.now()}`;
}
