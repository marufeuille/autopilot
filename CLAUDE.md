# CLAUDE.md

## プロジェクトドキュメント

このプロジェクトのドキュメントは Obsidian Vault で管理されており、**Obsidian MCP (`mcp__obsidian-mcp-tools__*`)** 経由でアクセスできます。

### 格納場所

```
Projects/claude-workflow-kit/
```

### 主要ファイル

| ファイル | 内容 |
|---|---|
| `Projects/claude-workflow-kit/README.md` | プロジェクト概要・コンセプト・ワークフロー |

### アクセス方法

```
# ファイル一覧を確認
mcp__obsidian-mcp-tools__list_vault_files(directory="Projects/claude-workflow-kit")

# ファイルを読む
mcp__obsidian-mcp-tools__get_vault_file(filename="Projects/claude-workflow-kit/README.md")
```

ストーリーやタスクも同 Vault 内で管理されており、スキル（`run-workflow`, `execute-story-task` 等）はこの Vault を読み書きして状態を管理します。

> [!IMPORTANT]
> **Vault の `Projects/` 内のディレクトリ・ファイル構成は、Vault ルートの `README.md` に定義された構造に従うこと。**
> ファイルやディレクトリを新規作成・移動・削除する際は、事前に Vault ルートの `README.md` を確認し、定義された構造に従うこと。
