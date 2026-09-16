# Remote Playwright MCP

A remote MCP server that lets an agent drive a real Chromium browser over HTTP — every session is screen-recorded, and the recording is uploaded to a Railway Bucket when the session ends.

## What it does

The server exposes a small set of [MCP](https://modelcontextprotocol.io) tools over Streamable HTTP. An MCP client (Claude, an agent framework, your own code) connects, calls `browser_start`, drives the page with `browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type`, and calls `browser_end` when it's done. The whole session is recorded as a `.webm` video by Playwright and uploaded to an S3-compatible bucket.

v1 is intentionally minimal: **one browser per MCP session**, no session manager, no database, no queue. It's meant to be small enough to read end to end in one sitting.

## Available tools

| Tool | Description |
| --- | --- |
| `browser_start()` | Launches Chromium with video recording enabled. Call once per MCP session. |
| `browser_navigate(url)` | Navigates the page to `url`. |
| `browser_snapshot()` | Returns an accessibility/DOM-style tree of the page. Interactive elements are tagged with a `[ref=e3]` that `browser_click`/`browser_type` can target — this is far more reliable for an agent than clicking on screenshot coordinates. |
| `browser_click(ref)` | Clicks the element with the given ref. |
| `browser_type(ref, text)` | Types text into the element with the given ref. |
| `browser_end()` | Closes the browser, finalizes the recording, uploads it to the bucket, and returns where it landed. |

Only one browser session is allowed at a time per MCP session — call `browser_end()` before starting another.

## Run locally

1. Clone this repo.
2. Install dependencies (this also needs the Playwright browser binaries):
   ```
   npm install
   npx playwright install --with-deps chromium
   ```
3. Copy `.env.example` to `.env` and fill in your bucket credentials (see [Configuration](#configuration)). You can skip the bucket variables while developing everything except `browser_end`.
4. Start the dev server:
   ```
   npm run dev
   ```
5. Server is up at `http://localhost:8080` — `GET /health` should return `200 OK`, and the MCP endpoint is `POST /mcp`.

## Deploy to Railway

1. Create a new Railway project.
2. Deploy this GitHub repo into it (Railway detects the `Dockerfile` automatically).
3. Add a **Bucket** to the project from the Railway dashboard.
4. Open the bucket's "Connect" tab and copy its credentials into the service's variables: `BUCKET_ENDPOINT`, `BUCKET_NAME`, `BUCKET_ACCESS_KEY`, `BUCKET_SECRET_KEY`, `BUCKET_REGION`.
5. Generate a public domain for the service (Settings → Networking → Generate Domain).
6. Your MCP endpoint is:
   ```
   https://<your-domain>.up.railway.app/mcp
   ```

Railway injects `PORT` automatically; the server reads it directly.

## Connect an MCP client

Most MCP clients support remote Streamable HTTP servers by URL. For example, in a client config file:

```json
{
  "mcpServers": {
    "playwright-remote": {
      "url": "https://<your-domain>.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_API_KEY, if you set one>"
      }
    }
  }
}
```

Drop the `headers` block if you didn't set `MCP_API_KEY`.

## Try it

Once connected, ask your agent:

> "Open example.com, click 'More information', then end the browser session."

The agent will call `browser_start` → `browser_navigate` → `browser_snapshot` → `browser_click` → `browser_end`, and the final response will include the bucket key of the recording.

## Recordings

- Recordings are written to `/tmp/videos/<session-id>/` while the browser is running — this is scratch space only, not a persistent volume.
- On `browser_end()`, the video is finalized, uploaded to `recordings/<session-id>-<file>.webm` in your bucket, and the local temp file/directory is deleted.
- If an MCP client disconnects without calling `browser_end()` (e.g. it crashes), the server still closes the browser and deletes the local temp recording on session teardown — but in that case the video is **not** uploaded, since there was no clean `browser_end()` call to trigger it. Always call `browser_end()` when you're finished.

## Architecture

```
Railway Project

┌───────────────────────┐
│ Playwright MCP         │
│                         │
│ Node + Chromium         │
│ POST /mcp                │
│ GET  /health               │
└───────────┬───────────┘
            │
            │ S3 API
            ▼
┌───────────────────────┐
│ Railway Bucket          │
│                         │
│ recordings/*.webm        │
└───────────────────────┘
```

No database, Redis, worker, or volume. One process, one browser per MCP session, one bucket.

## Configuration

| Variable | Description |
| --- | --- |
| `PORT` | Port to listen on. Provided by Railway automatically. |
| `BUCKET_ENDPOINT` | S3-compatible endpoint for your Railway Bucket. |
| `BUCKET_NAME` | Bucket name. |
| `BUCKET_ACCESS_KEY` | Access key credential. |
| `BUCKET_SECRET_KEY` | Secret key credential. |
| `BUCKET_REGION` | Bucket region (defaults to `auto`). |
| `MCP_API_KEY` | Optional. If set, `/mcp` requires `Authorization: Bearer <MCP_API_KEY>` on every request. |

## Security

**Do not expose an unauthenticated browser MCP server to the public internet in production.** Anyone who can reach `/mcp` can drive a real browser from your infrastructure — set `MCP_API_KEY` (or put the service behind your own auth/gateway) before sharing the URL outside your own testing.

## Development

- `npm run dev` — run with hot reload (`tsx watch`).
- `npm run build` — type-check and compile to `dist/`.
- `npm start` — run the compiled server (what the Docker image runs).
- `npm run typecheck` — type-check without emitting.

Project layout:

```
src/
  index.ts             Express app: POST /mcp, GET /health, session/transport wiring
  mcp-server.ts        MCP tool definitions, one McpServer per session
  browser-session.ts   Playwright lifecycle: launch, snapshot, click, type, end
  bucket.ts            S3 upload
  config.ts            Environment variable loading
Dockerfile              Based on mcr.microsoft.com/playwright, pinned to the playwright npm version
```

## License

MIT
