# autopilot

ObsidianのVaultを監視し、ストーリーのステータスが `Doing` になると Claude エージェントが自動でタスクを実行する自律ワークフローボットです。各ステップの開始・完了はSlackで承認できます。

## 動作の流れ

1. Obsidian VaultのストーリーファイルのStatusを `Doing` に変更する
2. タスクファイルが存在しない場合、Claudeがストーリーを分解してタスク候補をSlackに提示
3. 承認するとタスクファイルが作成され、順番に実行が始まる
4. 各タスクの開始・完了時にSlackで承認を求める（やり直しも可能）
5. 全タスク完了後、ストーリーのStatusが `Done` に更新されSlackに通知

## セットアップ

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. `.env` の作成

```bash
cp .env.example .env
```

`.env` の内容:

```env
# ObsidianのVaultのローカルパス
VAULT_PATH=/path/to/your/obsidian/vault

# 監視するVaultのプロジェクト名（Projects/{WATCH_PROJECT}/stories/ を監視する）
WATCH_PROJECT=my-project

# Slack Bot Token（xoxb-...）
SLACK_BOT_TOKEN=xoxb-...

# Slack App-Level Token（xapp-...）
SLACK_APP_TOKEN=xapp-...

# 通知・承認に使うSlackチャンネルID
SLACK_CHANNEL_ID=C0XXXXXXXXX
```

### 3. Slack Appの設定

[api.slack.com/apps](https://api.slack.com/apps) で新規Appを作成し、以下を設定します。

**Socket Modeを有効化**
- "Socket Mode" メニューから有効化
- App-Level Token（スコープ: `connections:write`）を生成 → `SLACK_APP_TOKEN`

**Bot Token Scopesの追加**（"OAuth & Permissions"）
- `chat:write`
- `im:write`
- `channels:read`

**Interactivityを有効化**（"Interactivity & Shortcuts"）

**Appをワークスペースにインストール** → `SLACK_BOT_TOKEN`

**Botをチャンネルに招待**
```
/invite @YourBotName
```

### 4. 起動

```bash
# 開発モード
npm run dev

# ビルドして実行
npm run build
node dist/index.js
```

## Vaultのファイル構造

autopilot は Obsidian Vault 内の以下のディレクトリ構造を前提としています。

```
Projects/
  {project}/              ← WATCH_PROJECT で指定するプロジェクト名
    stories/
      my-story.md         ← ストーリーファイル（status を Doing にすると実行開始）
    tasks/
      my-story/           ← ストーリー名と同名のディレクトリ
        01-task-a.md      ← タスクファイル（Claudeが自動生成、アルファベット順に実行）
        02-task-b.md
```

また、autopilot はリポジトリが `~/dev/{project}` に存在することを前提として Claude エージェントを実行します。

### ストーリーファイルの例

```markdown
---
status: Doing
---

## 概要
認証機能を実装する

## 完了条件
- ログインAPIが動作する
- テストが通る
```

`status` を `Doing` に変更すると autopilot が検知して実行を開始します。

### タスクファイルの例（Claudeが自動生成）

```markdown
---
status: Todo
priority: high
effort: medium
story: my-story
project: my-project
created: 2025-01-01
---

# JWTトークン生成の実装

## 目的

ログイン後のセッション管理に使うトークンを発行する

## 詳細

...

## 完了条件

- [ ] トークンが正しく生成される
- [ ] テストが通る
```

## 常駐運用（pm2）

```bash
npm install -g pm2
npm run build
pm2 start dist/index.js --name autopilot
pm2 save
pm2 startup
```
