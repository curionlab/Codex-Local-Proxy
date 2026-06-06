# Codex-Local-Proxy

[日本語版 (Japanese)](./README-jp.md)

A lightweight, standalone Node.js proxy server designed to solve schema incompatibilities between OpenAI Codex CLI and Local LLM inference servers (like LM Studio, Ollama, vLLM) when using the Model Context Protocol (MCP).

## The Problem

Codex CLI implements OpenAI's latest Responses API (`/v1/responses`) and introduces a nested `namespace` tool type to group MCP tools:
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
Local LLM server expects the standard Chat Completions `function` tool schema. When it receives `namespace`, it throws an `Ignoring unsupported tool type(s): namespace` error, and the model never sees your MCP tools.

## The Solution

**Codex-Local-Proxy** intercepts the HTTP traffic between Codex CLI and your Local LLM and solves this in three steps:

1. **Request Flattening**: It intercepts incoming tools, unwraps any `namespace` payloads, and flattens them into standard `function` definitions (e.g., `mcp__my-local-mcp__my_custom_tool`) so the LLM can understand them.
2. **LLM Generation**: The LLM processes the request and returns the tool call using the flattened name it was provided.
3. **Response Remapping**: Codex CLI strictly requires the `name` and `namespace` to be returned as two separate fields. The proxy intercepts the SSE stream coming back from the LLM, detects the flattened tool calls, and restructures them into the strict schema that Codex CLI expects:
```json
{
  "name": "my_custom_tool",
  "namespace": "mcp__my-local-mcp"
}
```

*Note: If the destination is OpenAI (`api.openai.com`), the proxy acts as a transparent pass-through and applies no transformations.*

## Installation

```bash
git clone https://github.com/curionlab/Codex-Local-Proxy.git
cd Codex-Local-Proxy
npm install
```

## Configuration

Copy the example environment file:
```bash
cp .env.example .env
```

Edit `.env`:
```env
# ---- LM Studio / Local LLM Settings ----
UPSTREAM_LLM_BASE_URL=http://127.0.0.1:1234/
UPSTREAM_LLM_KEY=lm-studio

# Proxy Port
PORT=3001
```

## Usage

Start the proxy server:
```bash
npm run dev
```

### Configuring Codex CLI

You need to configure Codex CLI to route traffic through this proxy instead of directly to LM Studio.

See the `codex_config_examples/` directory for configuration templates:
- `codex_config_examples/config.toml.sample`: General Codex global config defining the `localproxy` provider and your `mcp_servers`.
- `codex_config_examples/lm-studio.config.toml.sample`: Profile-specific configuration setting `model_provider = "localproxy"`.

Update your Codex CLI `config.toml` (or your profile config) to point to the proxy:
```toml
[model_providers.localproxy]
name = "Local Proxy"
base_url = "http://127.0.0.1:3001/"
```

Start Codex CLI using your profile (e.g., if you named your profile `lm-studio`):
```bash
codex --profile lm-studio
```

Now you can use custom MCP tools seamlessly with your local LLMs!
