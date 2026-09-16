# Remote Playwright MCP

A remote MCP server that lets an agent drive a real Chromium browser over HTTP — every session is recorded and uploaded to a Railway Bucket when it ends.

```mermaid
graph LR
    Client["MCP Client"] -->|"POST /mcp"| Server["Playwright MCP<br/>Node + Chromium"]
    subgraph "Railway Project"
        Server -->|"S3 API"| Bucket[("Railway Bucket<br/>recordings/*.webm")]
    end
```

One browser per MCP session. No database, queue, or volume — just this service and a bucket.

## Available tools

| Tool | Description |
| --- | --- |
| `browser_start()` | Launches Chromium with video recording enabled. Call once per MCP session. |
| `browser_navigate(url)` | Navigates the page to `url`. |
| `browser_snapshot()` | Returns an accessibility/DOM-style tree of the page. Interactive elements are tagged with a `[ref=e3]` that `browser_click`/`browser_type` can target — far more reliable for an agent than clicking on screenshot coordinates. |
| `browser_click(ref)` | Clicks the element with the given ref. |
| `browser_type(ref, text)` | Types text into the element with the given ref. |
| `browser_end()` | Closes the browser, finalizes the recording, uploads it to the bucket, and returns a temporary (7-day) signed URL to watch it. |

Only one browser session is allowed at a time per MCP session — call `browser_end()` before starting another.

## Deploying on Railway

1. Create a new Railway project.
2. Deploy this GitHub repo into it — Railway detects the `Dockerfile` automatically.
3. Add a **Bucket** to the project.
4. On the app service, go to **Variables → Connect Service to Bucket**, pick the bucket, choose the **AWS SDK (Generic)** style, and click **Add Variables**. This sets `AWS_ENDPOINT_URL`, `AWS_S3_BUCKET_NAME`, `AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` on the service directly — nothing to copy by hand.
5. Generate a public domain (Settings → Networking → Generate Domain). Your MCP endpoint is `https://<your-domain>.up.railway.app/mcp`.
6. **Before sharing that URL with anyone**, set `MCP_API_KEY` on the service — anyone who can reach `/mcp` can drive a real browser on your infrastructure. Then point an MCP client at it:
   ```json
   {
     "mcpServers": {
       "playwright-remote": {
         "url": "https://<your-domain>.up.railway.app/mcp",
         "headers": { "Authorization": "Bearer <MCP_API_KEY>" }
       }
     }
   }
   ```
7. Try it — ask your agent: *"Open example.com, click 'More information', then end the browser session."* It calls `browser_start → browser_navigate → browser_snapshot → browser_click → browser_end`, and the response includes a link to the recording.

## Running Locally

1. Clone this repo.
2. Install dependencies and the Playwright browser binaries:
   ```
   npm install
   npx playwright install --with-deps chromium
   ```
3. Copy `.env.example` to `.env`. The `AWS_*` bucket variables are optional locally — you only need them to exercise `browser_end()`'s upload step; everything else works without a bucket configured. Leave `MCP_API_KEY` unset for local dev.
4. Start the server:
   ```
   npm run dev
   ```
   It's up at `http://localhost:8080` — `GET /health` returns `200 OK`, and the MCP endpoint is `POST /mcp`.
5. Point a client at it with the same config as above, but `"url": "http://localhost:8080/mcp"` and no `Authorization` header.
