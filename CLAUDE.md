# CLAUDE.md

## プロジェクトドキュメント

このプロジェクトのドキュメントは Obsidian Vault で管理されており、**Obsidian MCP (`mcp__obsidian-mcp-tools__*`)** 経由でアクセスできます。

### 格納場所

```
Projects/autopilot/
```

### 主要ファイル

| ファイル | 内容 |
|---|---|
| `Projects/autopilot/README.md` | プロジェクト概要・コンセプト・ワークフロー |

### アクセス方法

```
# ファイル一覧を確認
mcp__obsidian-mcp-tools__list_vault_files(directory="Projects/autopilot")

# ファイルを読む
mcp__obsidian-mcp-tools__get_vault_file(filename="Projects/autopilot/README.md")
```

ストーリーやタスクも同 Vault 内で管理されており、スキル（`run-workflow`, `execute-story-task` 等）はこの Vault を読み書きして状態を管理します。

> [!IMPORTANT]
> **Vault の `Projects/` 内のディレクトリ・ファイル構成は、Vault ルートの `README.md` に定義された構造に従うこと。**
> ファイルやディレクトリを新規作成・移動・削除する際は、事前に Vault ルートの `README.md` を確認し、定義された構造に従うこと。

## Obsidian Bases（ダッシュボード）

`.base` ファイルでフロントマターを動的に一覧表示・編集できます。Obsidian 上でステータスをその場で変更可能。

### ファイル形式（YAML）

```yaml
views:
  - type: table
    name: 表示名
    filters:
      and:
        - file.folder == "Projects/foo/stories"   # 完全一致
        - file.path contains "Projects/foo/tasks"  # 部分一致（サブフォルダ対応）
    groupBy:
      property: status
      direction: ASC
    order:
      - file.name
      - status
      - priority
    sort:
      - property: created
        direction: DESC
```

### 既存の Base ファイル

| ファイル | 対象 | グループ |
|---|---|---|
| `Projects/autopilot/taskbase.base` | `stories/` | status |

### MCP で Base ファイルを作成する場合

`mcp__obsidian-mcp-tools__create_vault_file` で上記形式の YAML を書き込むだけで作成できます。
