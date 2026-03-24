# autopilot

ObsidianのVaultを監視し、ストーリーのステータスが `Doing` になると Claude エージェントが自動でタスクを実行する自律ワークフローボットです。各ステップの開始・完了はSlackで承認できます。

## 動作の流れ

1. Obsidian VaultのストーリーファイルのStatusを `Doing` に変更する
2. タスクファイルが存在しない場合、Claudeがストーリーを分解してタスク候補をSlackに提示
3. 承認するとタスクファイルが作成され、順番に実行が始まる
4. 各タスクの開始・完了時にSlackで承認を求める（やり直しも可能）
   - 「マージ準備完了」通知にはNGボタンがあり、Slack上で理由を入力してPRを却下できる（却下理由は次の実装に自動反映される）
5. 全タスク完了後、ストーリーのStatusが `Done` に更新されSlackに通知

## タスク実行エンジン：Pipeline パターン

### 設計思想

> **「フローがコードを読めばグラフとして見える」**

`runTask` は **Pipeline パターン** で実装されています。タスクの実行フロー全体が `createPipeline([...])` の1箇所に宣言されており、コードを読むだけでグラフとして把握できます。

```typescript
// src/pipeline/task-pipeline.ts ← フロー定義の唯一の場所
export const taskPipeline = createPipeline<TaskContext>([
  step('start-approval',  handleStartApproval),  // タスク開始を Slack で承認
  step('sync-main',       handleSyncMain),        // main ブランチと同期
  step('implementation',  handleImplementation),  // Claude Agent で実装 + セルフレビュー
  step('pr-lifecycle',    handlePRLifecycle),      // PR 作成 + CI + 手動マージ待機（ポーリング / Slack NG却下）
  step('doc-update',      handleDocUpdate),        // ドキュメント更新
  step('done',            handleDone),             // 完了通知 + ステータス更新
]);
```

### フロー図

```mermaid
flowchart LR
    SA([start-approval]) -->|continue| SM([sync-main])
    SM -->|continue| IM([implementation])
    IM -->|continue| PR([pr-lifecycle])
    PR -->|continue| DU([doc-update])
    DU -->|continue| DN([done])

    SA -->|skip| SK(((Skipped)))
    DN --> FN(((Done)))

    PR -->|"retry from: implementation\nCI失敗 / PRクローズ / Slack却下"| IM
    IM -->|"retry from: implementation\nレビューNG"| IM
```

### FlowSignal

各 step は処理結果を **FlowSignal** として返します。「次に何が起きるか」を step 自身が宣言し、ループ制御は Pipeline が担います。

| シグナル | 意味 | 発生例 |
|---|---|---|
| `continue` | 次の step へ進む | 正常完了 |
| `retry(from, reason)` | 指定 step まで巻き戻す | CI失敗 → `from: 'implementation'`<br>PRクローズ → `from: 'implementation'`<br>Slack却下 → `from: 'implementation'`（却下理由付き） |
| `skip` | Pipeline を即終了（Skipped 扱い） | タスク開始承認で却下 |
| `abort(error)` | エラーを throw して強制終了 | 致命的エラー |

### retry の明示性

retry 先を `from:` フィールドで宣言するため、**「どこまで巻き戻るか」の意図がコードから直接読めます**。

```typescript
// CI失敗 → 実装からやり直し（コードを直して再実装が必要）
return { kind: 'retry', from: 'implementation', reason: `CI未通過: ${ciResult.finalStatus}` }

// PRがマージされずクローズ → 実装からやり直し
return { kind: 'retry', from: 'implementation', reason: `PRクローズ: ${reason}` }
```

### 実装ファイル構成

```
src/pipeline/
├── types.ts           # FlowSignal / TaskContext / Step の型定義
├── runner.ts          # createPipeline / step / createTaskContext の実装
├── task-pipeline.ts   # 6 step のフロー定義（← ここがグラフ）
└── steps/
    ├── start-approval.ts  # handleStartApproval
    ├── sync-main.ts       # handleSyncMain
    ├── implementation.ts  # handleImplementation（Agent 実行 + レビュー）
    ├── pr-lifecycle.ts    # handlePRLifecycle（PR + CI + 手動マージ待機）
    ├── doc-update.ts      # handleDocUpdate
    └── done.ts            # handleDone
```

---

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

**スラッシュコマンドを登録**（"Slash Commands"）
- "Create New Command" をクリック
- Command: `/ap`
- Short Description: `autopilot操作`
- Usage Hint: `status | retry <task-slug>`
- 保存後、Appを再インストール

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

## `/ap` コマンド

Slackから autopilot を操作できます。

> **前提**: `/ap` コマンドはSlackバックエンドが起動している場合のみ動作します。
> `.env` に `NOTIFY_BACKEND=slack` が設定されていること、かつ `npm run dev` または `node dist/index.js` が起動中であることを確認してください。

| コマンド | 説明 |
|---|---|
| `/ap status` | 実行中のストーリー・タスク一覧を表示 |
| `/ap retry <task-slug>` | 失敗タスクをTodoに戻して再実行 |

例:
```
/ap status
/ap retry my-feature-task-01
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
