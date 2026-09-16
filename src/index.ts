import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { BrowserSession } from "./browser-session.js";
import { createMcpServer } from "./mcp-server.js";

// v1 keeps this in memory: one Express process, one browser per MCP
// session, no external session store. Fine for a single Railway instance.
const transports = new Map<string, StreamableHTTPServerTransport>();
const sessions = new Map<string, BrowserSession>();

async function cleanupSession(sessionId: string): Promise<void> {
  transports.delete(sessionId);
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (session) {
    await session.dispose().catch((error) => {
      console.error(`[mcp] failed to clean up session ${sessionId}:`, error);
    });
  }
}

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!config.mcpApiKey) {
    next();
    return;
  }
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (token !== config.mcpApiKey) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }
  next();
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

app.post("/mcp", requireApiKey, async (req, res) => {
  const sessionId = req.header("mcp-session-id");

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // Mint the session id ourselves so the BrowserSession and McpServer
      // can be built before the transport starts handling the request.
      const newSessionId = randomUUID();
      const browserSession = new BrowserSession(newSessionId);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: () => {
          transports.set(newSessionId, transport);
          sessions.set(newSessionId, browserSession);
        },
        onsessionclosed: () => {
          void cleanupSession(newSessionId);
        },
      });
      transport.onclose = () => {
        void cleanupSession(newSessionId);
      };

      const server = createMcpServer(browserSession);
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[mcp] error handling POST /mcp:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.header("mcp-session-id");
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
}

app.get("/mcp", requireApiKey, handleSessionRequest);
app.delete("/mcp", requireApiKey, handleSessionRequest);

app.listen(config.port, () => {
  console.log(`Remote Playwright MCP listening on port ${config.port}`);
  console.log(`  MCP endpoint: POST http://localhost:${config.port}/mcp`);
  console.log(`  Health check: GET  http://localhost:${config.port}/health`);
  if (!config.mcpApiKey) {
    console.warn("[mcp] MCP_API_KEY is not set -- the /mcp endpoint is unauthenticated.");
  }
});
