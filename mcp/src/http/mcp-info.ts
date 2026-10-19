/**
 * GET and DELETE on /mcp.
 *
 * The MCP endpoint is Streamable HTTP and stateless: clients POST JSON-RPC to it and get
 * the answer in the same response. Until 2026-10-19 any other method fell through to the
 * generic 404, so a person who opened https://a-identity.xyz/mcp in a browser saw
 * {"error":"not found"} and reasonably concluded the server was down, while every MCP
 * client was being served fine. A reviewer for a directory listing did exactly that.
 *
 * What each caller gets now:
 * - An MCP client asking for an SSE stream (Accept includes text/event-stream) gets 405
 *   with Allow: POST. That is what the spec asks of a server that offers no stream at
 *   this endpoint, and it is how clients learn to stay on plain POST.
 * - DELETE gets the same 405: there are no sessions to end.
 * - Anything else (a browser, curl, a link checker) gets 200 with a description of the
 *   endpoint and how to connect, as HTML when the caller accepts it and JSON otherwise.
 */

export const MCP_PUBLIC_URL = 'https://a-identity.xyz/mcp'

const CLAUDE_CODE_CMD = `claude mcp add --transport http a-identity ${MCP_PUBLIC_URL}`

const CURL_TOOLS_LIST =
  `curl -s -X POST ${MCP_PUBLIC_URL} \\\n` +
  `  -H 'content-type: application/json' \\\n` +
  `  -H 'accept: application/json, text/event-stream' \\\n` +
  `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`

export type McpInfoResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

export function mcpEndpointInfo() {
  return {
    name: 'a-identity-mcp',
    status: 'live',
    transport: 'streamable-http',
    endpoint: MCP_PUBLIC_URL,
    usage:
      'MCP clients send JSON-RPC 2.0 requests to this URL with POST. The server is stateless: ' +
      'no session id, and no SSE stream on GET. Opening the URL in a browser shows this description.',
    connect: {
      claudeCode: CLAUDE_CODE_CMD,
      mcpConfig: { mcpServers: { 'a-identity': { type: 'http', url: MCP_PUBLIC_URL } } },
    },
    tryIt: CURL_TOOLS_LIST,
    auth:
      'Read tools need no session. Tools that move value (hire_agent, deliver_task, release_escrow) ' +
      'require Authorization: Bearer from OAuth or a wallet or email login.',
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function infoHtml(): string {
  const info = mcpEndpointInfo()
  const config = JSON.stringify(info.connect.mcpConfig, null, 2)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A-Identity MCP server</title>
<style>
body{font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#16181d;background:#fff}
h1{font-size:24px;margin:0 0 4px}
.live{display:inline-block;font-size:13px;font-weight:600;color:#0a6b3a;background:#e3f6ea;border-radius:999px;padding:2px 10px}
pre{background:#f4f5f7;border:1px solid #e3e5e9;border-radius:8px;padding:12px;overflow-x:auto;font-size:13px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
p.note{color:#555b66;font-size:14px}
</style>
</head>
<body>
<h1>A-Identity MCP server</h1>
<p><span class="live">Live</span> Streamable HTTP endpoint: <code>${escapeHtml(info.endpoint)}</code></p>
<p>${escapeHtml(info.usage)}</p>
<h2>Connect from Claude Code</h2>
<pre><code>${escapeHtml(info.connect.claudeCode)}</code></pre>
<h2>Any MCP client</h2>
<pre><code>${escapeHtml(config)}</code></pre>
<h2>Try it with curl</h2>
<pre><code>${escapeHtml(info.tryIt)}</code></pre>
<p class="note">${escapeHtml(info.auth)}</p>
</body>
</html>
`
}

const METHOD_NOT_ALLOWED = JSON.stringify({
  jsonrpc: '2.0',
  error: {
    code: -32000,
    message: 'Method not allowed: this server is stateless and offers no SSE stream or session. Send JSON-RPC requests with POST.',
  },
  id: null,
})

/** The response for a non-POST request to /mcp, or null when the method is not ours to answer. */
export function mcpNonPostResponse(method: string, accept: string | undefined): McpInfoResponse | null {
  const acc = (accept ?? '').toLowerCase()
  if (method === 'DELETE' || (method === 'GET' && acc.includes('text/event-stream'))) {
    return { status: 405, headers: { Allow: 'POST', 'Content-Type': 'application/json' }, body: METHOD_NOT_ALLOWED }
  }
  if (method !== 'GET' && method !== 'HEAD') return null
  if (acc.includes('text/html')) {
    return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: infoHtml() }
  }
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mcpEndpointInfo(), null, 2),
  }
}
