import type { SubcommandHandler } from '../slash-commands';
import { buildHelpMessage } from '../slash-commands';

/**
 * /ap help サブコマンドのハンドラー
 *
 * 利用可能なコマンド一覧と使い方を返す。
 * 通常は registerSlashCommands 内で ack() 経由の ephemeral メッセージとして
 * 即時返答されるが、ハンドラーとしても登録しておくことで一貫性を保つ。
 */
export const handleHelp: SubcommandHandler = async (_args, respond) => {
  await respond(buildHelpMessage());
};
