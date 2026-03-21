# apps/autopilot

Anthropic SDK（Claude Agent SDK）+ Slack Socket Mode + Vault ファイルで動くシンプルな自律ワークフローオーケストレーター。

Temporalを使わず、Story の `status: Doing` を検知して Claude エージェントがタスクを順次実行する。

## アーキテクチャ

```
src/
  index.ts        # エントリポイント（Vault watcher + Slack bot 起動）
  runner.ts       # Story/Task の実行ループ
  approval.ts     # request_approval（in-memory Promise + Slack連携）
  config.ts       # 環境変数読み込み
  slack/
    bot.ts        # Slack Bolt Socket Mode
  vault/
    reader.ts     # Vault ファイル読み込み
    writer.ts     # Vault ファイル書き込み（status更新）
```

## セットアップ

### 1. 依存パッケージのインストール

```bash
cd apps/autopilot
npm install
```

### 2. 環境変数の設定

リポジトリルート（`claude-workflow-kit/`）に `.env` ファイルを作成する。

```bash
cp .env.example .env   # テンプレートがある場合
# または直接作成
```

`.env` の内容:

```env
# Vault（Obsidian）のローカルパス
VAULT_PATH=/path/to/your/obsidian/vault

# Slack Bot Token（xoxb-...）
# Slack App の "OAuth & Permissions" → Bot Token Scopes に以下が必要:
#   chat:write, im:write, channels:read
SLACK_BOT_TOKEN=xoxb-...

# Slack App-Level Token（xapp-...）
# Slack App の "Basic Information" → App-Level Tokens で生成
# スコープ: connections:write
SLACK_APP_TOKEN=xapp-...

# 通知先の Slack チャンネル ID
SLACK_CHANNEL_ID=C0XXXXXXXXX

# 監視するプロジェクト名（カンマ区切りで複数指定可）
# Vault の Projects/{WATCH_PROJECTS}/stories/ を監視する
WATCH_PROJECTS=claude-workflow-kit
```

### 3. Slack App の設定

1. [api.slack.com/apps](https://api.slack.com/apps) で新規 App を作成
2. **Socket Mode** を有効化（"Socket Mode" メニュー）
3. **App-Level Token** を生成（スコープ: `connections:write`）→ `SLACK_APP_TOKEN`
4. **Bot Token Scopes** を追加（"OAuth & Permissions"）:
   - `chat:write`
   - `im:write`
   - `channels:read`
5. **Interactivity** を有効化（"Interactivity & Shortcuts"）
6. App をワークスペースにインストール → `SLACK_BOT_TOKEN`
7. 通知先チャンネルに Bot を招待: `/invite @YourBotName`

### 4. 起動

```bash
# 開発モード（ts-node）
npm run dev

# ビルドして実行
npm run build
node dist/index.js
```

## 使い方

### ワークフローの起動

Obsidian Vault で対象 Story ファイルの `status` を `Doing` に変更する。

```yaml
# Projects/my-project/stories/my-story.md
---
status: Doing   # ← これを変更するとワークフローが起動
---
```

### ワークフローの流れ

1. Vault watcher が `status: Doing` を検知
2. ストーリーに紐づくタスク（`tasks/{story-slug}/*.md`）を取得
3. `status: Todo` のタスクを順番に処理:
   - Slack に「タスク開始確認」ボタン付きメッセージを送信
   - 承認 → Claude エージェントがタスクを実装
   - 完了確認 → 承認で次のタスクへ、やり直しで修正ループ
4. 全タスクが `Done` になるとストーリーが `Done` に更新され Slack 通知

### Vault のステータス遷移

| タイミング | Vault の更新 |
|---|---|
| タスク開始承認後 | タスク `status: Doing` |
| タスク完了承認後 | タスク `status: Done` |
| 全タスク完了後 | ストーリー `status: Done` |

## 常駐運用（pm2）

```bash
npm install -g pm2
npm run build
pm2 start dist/index.js --name autopilot
pm2 save
pm2 startup   # OS 起動時の自動起動設定
```
