# Codex-Local-Proxy

[English](./README.md)

OpenAI Codex CLI と、ローカル LLM 推論サーバー（LM Studio, Ollama, vLLMなど）との間で、Model Context Protocol (MCP) を使用する際に発生するスキーマの非互換性を解決するための、軽量で独立した Node.js プロキシサーバーです。

## 解決する課題

Codex CLI は OpenAI の最新の Responses API (`/v1/responses`) を実装しており、MCP ツールをグループ化するためにネストされた `namespace` という独自のツールタイプを導入しています：
```json
{
  "type": "namespace",
  "name": "mcp__my-local-mcp",
  "description": "Tools in the mcp__my-local-mcp namespace",
  "tools": [
    {
      "type": "function",
      "name": "my_custom_tool",
      "description": "My custom tool",
      "strict":false,
      "parameters": {
        "type": "object",
        "properties": {}
      }
    }
  ]
}
```
しかし、ローカル LLM 推論サーバーは標準の Chat Completions API に準拠した `function` スキーマを期待しています。そのため `namespace` を受信すると `Ignoring unsupported tool type(s): namespace` というエラーを投げ、LLMはMCPツールを一切認識できなくなってしまいます。

## 解決策

**Codex-Local-Proxy** は、Codex CLI とローカル LLM 間の HTTP トラフィックに介在し、以下の3つのステップでこの問題を解決します：

1. **リクエストの平坦化 (Request Flattening)**: 入力されたツールを傍受し、`namespace` ペイロードを展開して、LLMが理解できる標準の `function` 定義（例：`mcp__my-local-mcp__my_custom_tool`）に平坦化（フラット化）します。
2. **LLMのツール生成**: LLMはプロキシが平坦化したツール名を受け取り、その平坦化された名前のままツール呼び出しを生成して返します。
3. **レスポンスの再構築 (Response Remapping)**: Codex CLI はツール呼び出しの結果として、`name` と `namespace` を2つの独立したフィールドに分割して返すことを厳密に要求します。プロキシは LLM から返ってくる SSE ストリームを傍受し、平坦化されたツール呼び出しを検出して、Codex CLI が期待する形式に変換します：
```json
{
  "name": "my_custom_tool",
  "namespace": "mcp__my-local-mcp"
}
```

*注: 宛先が OpenAI (`api.openai.com`) の場合、プロキシは変換を一切行わず、そのまま通過させるトランスペアレント・パススルーとして機能します。*

## インストール

```bash
git clone https://github.com/curionlab/Codex-Local-Proxy.git
cd Codex-Local-Proxy
npm install
```

## 設定

環境設定ファイルのサンプルをコピーします：
```bash
cp .env.example .env
```

`.env` を編集します：
```env
# ---- LM Studio / ローカル LLM の設定 ----
UPSTREAM_LLM_BASE_URL=http://127.0.0.1:1234/
UPSTREAM_LLM_KEY=lm-studio

# プロキシのポート
PORT=3001
```

## 使い方

プロキシサーバーを起動します：
```bash
npm run dev
```

### Codex CLI の設定

トラフィックが LM Studio に直接向かうのではなく、このプロキシを経由するように Codex CLI を設定する必要があります。

CODEX CLIの設定テンプレートについては `codex_config_examples/` ディレクトリを参照してください：
- `codex_config_examples/config.toml.sample`: `localproxy` プロバイダーと `mcp_servers` を定義する Codex のグローバル設定。
- `codex_config_examples/lm-studio.config.toml.sample`: `model_provider = "localproxy"` を設定するプロファイル固有の設定。

Codex CLI の `config.toml` （またはプロファイル設定）を更新し、プロキシを向くように設定します：
```toml
[model_providers.localproxy]
name = "Local Proxy"
base_url = "http://127.0.0.1:3001/"
```

プロファイルを指定して Codex CLI を起動します（例: プロファイル名が `lm-studio` の場合）：
```bash
codex --profile lm-studio
```

これで、ローカル LLM でもシームレスに独自の MCP ツールを使用できるようになります！
