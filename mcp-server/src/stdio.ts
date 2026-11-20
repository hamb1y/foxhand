import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "@webmcp-controller/shared";
import { ExtensionBridge } from "./bridge/bridge.js";
import { DEFAULT_BIND, DEFAULT_PORT } from "./config.js";
import { registerFirefoxTools, SERVER_INSTRUCTIONS } from "./tools/index.js";

function localEndpoint(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && url.pathname === "/mcp" && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch {
    return null;
  }
}

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

/** Registry clients launch this shim; Firefox still owns the real native host. */
export async function runStdio(): Promise<void> {
  const token = process.env.FOXHAND_TOKEN ?? "";
  const url = localEndpoint(process.env.FOXHAND_URL ?? `http://localhost:${DEFAULT_PORT}/mcp`);
  const server = new McpServer({ name: "foxhand", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  let connecting: Promise<Client> | undefined;
  let upstream: Client | undefined;
  let closed = false;

  function connect(endpoint: URL): Promise<Client> {
    if (connecting) return connecting;
    const incoming = server.server.getClientVersion();
    const client = new Client(incoming ?? { name: "foxhand-stdio", version: VERSION });
    upstream = client;
    const reset = () => {
      if (upstream === client) { upstream = undefined; connecting = undefined; }
    };
    client.onclose = reset;
    connecting = client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "error" },
    }), { timeout: 5000 }).then(() => client, async (error: unknown) => {
      reset();
      await client.close().catch(() => {});
      throw error;
    });
    return connecting;
  }

  // Register the real schemas, even without a token. Every invocation, including
  // extension_status, goes through the authenticated helper, never this idle bridge.
  registerFirefoxTools(server, new ExtensionBridge(), {
    port: DEFAULT_PORT, bind: DEFAULT_BIND, token: "", confirmDestructive: true, cmdTimeoutMs: 30000, allowWsl: false,
  }, async (name, args, signal) => {
    if (!url) return failure("FOXHAND_URL must be a localhost HTTP MCP endpoint.");
    if (!/^[a-f0-9]{64}$/.test(token)) return failure("Set FOXHAND_TOKEN to the token from Foxhand Settings, without the Bearer prefix.");
    try {
      const client = await connect(url);
      return await client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema, {
        signal, timeout: 135000,
      });
    } catch {
      // Don't replay a call: it may already have acted before the connection dropped.
      return failure("Could not complete the Foxhand request. Keep Firefox open, check that Foxhand is Ready, and check the endpoint and token.");
    }
  });
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await Promise.allSettled([server.close(), upstream?.close()]);
  }
  process.stdin.once("end", () => void close());
  await server.connect(new StdioServerTransport());
}
