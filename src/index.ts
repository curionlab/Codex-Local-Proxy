import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Parse JSON, but keep raw body for streaming compatibility if needed
app.use(express.json({ limit: '50mb' }));

app.all(/.*/, async (req, res) => {
  const upstreamBase = (process.env.UPSTREAM_LLM_BASE_URL || 'http://127.0.0.1:1234').replace(/\/+$/, '');
  const upstreamAuth = process.env.UPSTREAM_LLM_KEY || '';

  let path = req.path;
  if (upstreamBase.endsWith('/v1') && path.startsWith('/v1/')) {
    path = path.substring(3); // remove '/v1' to prevent '/v1/v1/responses'
  }

  const isOpenAI = upstreamBase.includes('api.openai.com');

  const targetUrl = upstreamBase + path;
  console.log(`[Proxy] ${req.method} -> ${targetUrl}`);

  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();
      if (typeof value === 'string' && !['host', 'content-length', 'connection'].includes(lowerKey)) {
        headers[key] = value;
      }
    }

    const finalAuth = upstreamAuth ? upstreamAuth.trim().replace(/^Bearer\s+/i, '').replace(/[\r\n"']/g, '') : '';
    if (finalAuth) {
      delete headers['authorization'];
      delete headers['Authorization'];
      headers['Authorization'] = `Bearer ${finalAuth}`;
    }

    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      let body = { ...req.body };

      // ── Tool normalisation ──
      // Flatten Codex CLI tools (namespace) to standard function tools for LM Studio
      if (!isOpenAI && body.tools && Array.isArray(body.tools)) {
        const normalised: any[] = [];
        for (const item of body.tools) {
          if (item.type === 'namespace' && Array.isArray(item.tools)) {
            const nsPrefix = item.name;
            for (const nested of item.tools) {
              const flatName = `${nsPrefix}__${nested.name}`;
              normalised.push({
                type: 'function',
                name: flatName,
                description: nested.description || '',
                parameters: nested.parameters || nested.inputSchema || { type: 'object', properties: {} }
              });
            }
          } else if (item.type === 'function') {
            const fn = item.function || item;
            normalised.push({
              type: 'function',
              name: fn.name,
              description: fn.description || '',
              parameters: fn.parameters || { type: 'object', properties: {} }
            });
          }
        }
        body.tools = normalised;
        console.log(`[Proxy] Flattened ${normalised.length} tools for upstream`);
      }

      fetchOptions.body = JSON.stringify(body);
    }

    const proxyRes = await fetch(targetUrl, fetchOptions);

    if (!proxyRes) return;
    if (!proxyRes.ok) {
      const errText = await proxyRes.text();
      res.status(proxyRes.status).send(errText);
      return;
    }

    proxyRes.headers.forEach((val, key) => res.setHeader(key, val));
    res.status(proxyRes.status);
    if (!proxyRes.body) { res.end(); return; }

    const reader = proxyRes.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';
    let lastResponseId: string | null = null;
    let currentItemId: string | null = null;
    let hasSentItemCreated = false;

    const processLine = (line: string): string => {
      if (!line.startsWith('data: ')) return line;
      const dataStr = line.slice(6).trim();
      if (dataStr === '[DONE]') return line;

      try {
        let data = JSON.parse(dataStr);
        if (data.id) lastResponseId = data.id;
        if (data.item_id) currentItemId = data.item_id;

        // ── Responses API: Unflatten tool calls for Codex CLI ──
        let modified = false;

        const processToolCall = (tc: any) => {
          if (!tc || isOpenAI) return;
          const rawName = tc.name || tc.function?.name;
          if (rawName && rawName.startsWith('mcp__') && rawName.includes('__', 5)) {
            const lastDelimiterIndex = rawName.lastIndexOf('__');
            const extractedNamespace = rawName.substring(0, lastDelimiterIndex);
            const extractedFunctionName = rawName.substring(lastDelimiterIndex + 2);

            if (tc.name) {
              tc.name = extractedFunctionName;
              tc.namespace = extractedNamespace;
            }
            if (tc.function) {
              tc.function.name = extractedFunctionName;
              tc.function.namespace = extractedNamespace;
            }
            console.log(`[Proxy] Remapped Tool Call: name="${extractedFunctionName}", namespace="${extractedNamespace}"`);
            modified = true;
          }
        };

        if (data.item?.type === 'function_call') {
          processToolCall(data.item);
        }
        if (data.delta?.tool_calls) {
          data.delta.tool_calls.forEach(processToolCall);
        }
        if (data.item?.tool_calls) {
          data.item.tool_calls.forEach(processToolCall);
        }

        if (modified) {
          return `data: ${JSON.stringify(data)}`;
        }

        return `data: ${JSON.stringify(data)}`;
      } catch (e) { return line; }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (lineBuffer) res.write(processLine(lineBuffer) + '\n\n');
        break;
      }
      lineBuffer += decoder.decode(value, { stream: true });
      let newlineIdx;
      while ((newlineIdx = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, newlineIdx).trim();
        lineBuffer = lineBuffer.slice(newlineIdx + 1);
        if (line) res.write(processLine(line) + '\n\n');
      }
    }
    res.end();
  } catch (error: any) {
    console.error('[Proxy Error]', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'LLM Proxy failed' });
    else res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Codex-Local-Proxy listening on port ${PORT}`);
});
