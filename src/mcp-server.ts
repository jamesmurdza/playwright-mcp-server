import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BrowserSession, BrowserSessionError } from "./browser-session.js";

/**
 * Creates one McpServer instance wired to one BrowserSession. Every tool
 * handler just delegates to the session and converts thrown errors into MCP
 * tool errors so the agent sees a readable message instead of a transport
 * failure.
 */
export function createMcpServer(session: BrowserSession): McpServer {
  const server = new McpServer({
    name: "remote-playwright-mcp",
    version: "1.0.0",
  });

  const run = async (fn: () => Promise<unknown>) => {
    try {
      const result = await fn();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message =
        error instanceof BrowserSessionError
          ? error.message
          : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  };

  server.registerTool(
    "browser_start",
    {
      title: "Start browser",
      description:
        "Launches a Chromium browser with video recording enabled. Call this once before any other browser_* tool. Only one browser session is allowed per MCP session -- call browser_end() before starting another.",
      inputSchema: {},
    },
    () => run(() => session.start()),
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate",
      description: "Navigates the current page to the given URL.",
      inputSchema: {
        url: z.string().url().describe("Absolute URL to navigate to, e.g. https://example.com"),
      },
    },
    ({ url }) => run(() => session.navigate(url)),
  );

  server.registerTool(
    "browser_snapshot",
    {
      title: "Snapshot",
      description:
        "Returns an accessibility-style tree of the current page. Interactive elements (links, buttons, inputs, ...) are tagged with a ref like [ref=e3] that browser_click and browser_type can target. Prefer this over screenshots for deciding what to interact with.",
      inputSchema: {},
    },
    () => run(() => session.snapshot()),
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click",
      description: "Clicks the element identified by `ref`, as returned by browser_snapshot().",
      inputSchema: {
        ref: z.string().describe('Element ref from the latest browser_snapshot(), e.g. "e3"'),
      },
    },
    ({ ref }) => run(() => session.click(ref)),
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type",
      description:
        "Types text into the element identified by `ref`, as returned by browser_snapshot(). Replaces the element's existing value.",
      inputSchema: {
        ref: z.string().describe('Element ref from the latest browser_snapshot(), e.g. "e5"'),
        text: z.string().describe("Text to type into the element"),
      },
    },
    ({ ref, text }) => run(() => session.type(ref, text)),
  );

  server.registerTool(
    "browser_end",
    {
      title: "End browser session",
      description:
        "Closes the browser, finalizes the video recording, uploads it to the configured bucket, and returns where it was stored. Always call this when you're done, even if something went wrong, so the recording isn't lost.",
      inputSchema: {},
    },
    () => run(() => session.end()),
  );

  return server;
}
