/**
 * A small client for n8n's own MCP server (30 Sep 2026).
 *
 * n8n's public API has no Agents endpoints and cannot save a workflow as a draft
 * without publishing it, run a workflow with pinned data, or publish a chosen
 * version. Its MCP server can do all four, so the bridge uses it for the fixes it
 * prepares for a person to apply. JSON-RPC 2.0 over streamable HTTP, with no SDK:
 * a POST that answers either JSON or one SSE frame.
 *
 * `N8N_MCP_URL` and `N8N_MCP_TOKEN`; unset, `configured()` is false and every
 * path that needs this says so in its report rather than failing quietly.
 */
import { env } from './config.js';

export function configured() {
  return Boolean(env('N8N_MCP_URL') && env('N8N_MCP_TOKEN'));
}

export function serverConfig() {
  return { type: 'http', url: env('N8N_MCP_URL'), headers: { Authorization: `Bearer ${env('N8N_MCP_TOKEN')}` } };
}

export class McpError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = 'McpError';
    this.detail = detail;
  }
}

let session = null;
let nextId = 1;

function parseBody(text, id) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  // SSE: the frame whose JSON carries our id.
  for (const line of t.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const o = JSON.parse(line.slice(5).trim());
      if (id === undefined || o?.id === id) return o;
    } catch {
      /* not this frame */
    }
  }
  return null;
}

async function post(body, { timeoutMs = 120_000 } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${env('N8N_MCP_TOKEN')}`,
  };
  if (session) headers['mcp-session-id'] = session;
  const res = await fetch(env('N8N_MCP_URL'), { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) session = sid;
  const text = await res.text();
  return { status: res.status, text };
}

async function initialize() {
  session = null;
  const id = nextId++;
  const r = await post({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bha-repair-bridge', version: '1.0.0' } } });
  if (r.status >= 400) throw new McpError(`n8n MCP refused initialize (${r.status})`, r.text.slice(0, 300));
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
}

/**
 * Calls one n8n MCP tool and returns its result parsed from the text content.
 * A tool error or an `isError` result throws, carrying n8n's own words.
 */
export async function callTool(name, args = {}, { timeoutMs } = {}) {
  if (!configured()) throw new McpError('N8N_MCP_URL and N8N_MCP_TOKEN are not set on this service');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session) await initialize();
    const id = nextId++;
    const r = await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, { timeoutMs });
    if ((r.status === 404 || r.status === 400) && attempt === 0 && /session/i.test(r.text)) {
      session = null;
      continue;
    }
    if (r.status >= 400) throw new McpError(`n8n MCP answered ${r.status} to ${name}`, r.text.slice(0, 500));
    const msg = parseBody(r.text, id);
    if (!msg) throw new McpError(`n8n MCP gave no readable answer to ${name}`, r.text.slice(0, 300));
    if (msg.error) throw new McpError(`${name}: ${msg.error.message ?? 'error'}`, msg.error);
    const content = msg.result?.content ?? [];
    const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('');
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : msg.result?.structuredContent ?? null;
    } catch {
      parsed = { text };
    }
    if (msg.result?.isError) throw new McpError(`${name}: ${text.slice(0, 400) || 'error'}`, parsed);
    return parsed;
  }
  throw new McpError(`n8n MCP session could not be re-established for ${name}`);
}

export function resetForTests() {
  session = null;
  nextId = 1;
}
