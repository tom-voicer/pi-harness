---
name: kernel-browser
description: Cloud browser automation via Kernel (onkernel.com). Use when you need to browse the real web — open pages, click, type, scroll, take screenshots, run Playwright scripts, or make HTTP requests through a browser's network stack. This gives you a sandboxed Chromium browser in the cloud with anti-bot stealth, cookie persistence, and live view.
license: MIT
---

# Kernel Browser Automation

Kernel provides sandboxed cloud Chromium browsers accessible via REST API. Use it when you need to interact with real websites — scraping, form filling, testing, research, or any task requiring a real browser's rendering and network stack.

**Base URL:** `https://api.onkernel.com`
**API Key location:** `~/.pi/agent/auth.json` → `.kernel.key`

## Quick Decision Tree

```
Need browser access?
├─ Navigate a page, extract content, fill forms → Playwright execution (best for content extraction)
├─ Click, type, scroll at specific coordinates → Computer Controls API
├─ Take a screenshot → captureScreenshot (OS-level, faster than CDP)
├─ Make HTTP requests with browser cookies/fingerprint → Browser curl / fetch
├─ Interactive browsing with a human in the loop → Live View URL
├─ Persistent login state across sessions → Profiles
└─ See what's on screen before acting → captureScreenshot
```

## Retrieving the API Key

The Kernel API key is stored in `~/.pi/agent/auth.json`:

```json
{
  "kernel": {
    "type": "api_key",
    "key": "sk_..."
  }
}
```

Read it with: `cat ~/.pi/agent/auth.json | jq -r '.kernel.key'`

Use the REST API directly with `curl` — the Kernel SDK (`@onkernel/sdk`) is a thin wrapper around `fetch` calls to `https://api.onkernel.com`.

## Core Workflow

```
1. CREATE a browser session      POST /browsers
2. NAVIGATE to a URL              Playwright: page.goto() or start_url param
3. INTERACT with the page         Playwright, Computer Controls, or Curl
4. SEE what's happening           captureScreenshot → view the image
5. DELETE the browser             DELETE /browsers/{id}
```

Always delete browsers when done. Unused browsers auto-terminate after `timeout_seconds` (default 60s, max 72h).

## REST API Reference

All requests use `Authorization: Bearer <kernel-api-key>` header and `Content-Type: application/json`.

### Create a Browser

```bash
curl -s https://api.onkernel.com/browsers \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "stealth": true,
    "headless": false,
    "timeout_seconds": 300,
    "start_url": "https://example.com",
    "viewport": {"width": 1280, "height": 800}
  }'
```

**Response** includes:
- `session_id` — required for all subsequent API calls
- `cdp_ws_url` — CDP WebSocket for Playwright/Puppeteer (manual CDP connections)
- `browser_live_view_url` — interactive live view URL (only non-headless)
- `base_url` — base URL for metro-API calls (computer controls, playwright, filesystem, curl)

**Key params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stealth` | bool | `false` | Anti-bot detection (recommended for scraping) |
| `headless` | bool | `false` | Headless mode (no GUI, slightly faster) |
| `timeout_seconds` | int | `60` | Inactivity timeout before auto-delete (10–259200) |
| `start_url` | string | — | URL to navigate to on creation (fire-and-forget) |
| `viewport` | object | `{width:1920, height:1080}` | Window size in pixels |
| `name` | string | — | Human-readable name for later reference |
| `profile` | object | — | Load a saved profile: `{id: "..."}` or `{name: "..."}` |
| `kiosk_mode` | bool | `false` | Fullscreen live view without browser chrome |
| `gpu` | bool | `false` | GPU acceleration (requires paid plan, headless=false) |

### Get Browser Details

```bash
curl -s https://api.onkernel.com/browsers/$SESSION_ID \
  -H "Authorization: Bearer $KERNEL_API_KEY"
```

### List Browsers

```bash
curl -s "https://api.onkernel.com/browsers?status=active&limit=20" \
  -H "Authorization: Bearer $KERNEL_API_KEY"
```

### Delete a Browser

```bash
curl -s -X DELETE https://api.onkernel.com/browsers/$SESSION_ID \
  -H "Authorization: Bearer $KERNEL_API_KEY"
```

## Playwright Execution

**This is the recommended way to extract content and interact with pages.** Your TypeScript code runs inside the browser's VM with access to `page`, `context`, and `browser` objects. No CDP latency — code runs in the same VM.

**Endpoint:** `POST /browsers/{id}/playwright/execute`

```bash
# Navigate and get page title
curl -s https://api.onkernel.com/browsers/$SESSION_ID/playwright/execute \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "await page.goto(\"https://example.com\"); return await page.title();",
    "timeout_sec": 60
  }'
```

**Response:** `{ "success": true, "result": "Example Domain", "error": null, "stderr": "" }`

**Use cases:**

```typescript
// Extract page text content
await page.goto('https://example.com');
const text = await page.evaluate(() => document.body.innerText);
return text;

// Scrape a list
await page.goto('https://news.ycombinator.com');
const titles = await page.$$eval('.titleline > a',
  links => links.map(l => l.textContent)
);
return titles.slice(0, 10);

// Fill and submit forms
await page.goto('https://example.com/login');
await page.fill('#email', 'user@example.com');
await page.fill('#password', 's3cret');
await page.click('button[type="submit"]');
await page.waitForLoadState('networkidle');
return page.url();

// Take a screenshot via Playwright (returns base64)
await page.goto('https://example.com');
const screenshot = await page.screenshot({ type: 'png', fullPage: true });
return screenshot.toString('base64');

// Get cookies and localStorage
const cookies = await context.cookies();
const ls = await page.evaluate(() =>
  JSON.stringify(window.localStorage)
);
return { cookies, ls };
```

**Limits:** Default timeout 60s, max 300s. Code runs in an isolated context each time — no persistent variables between calls.

## Computer Controls

Low-level mouse, keyboard, and screen control. Use when Playwright selectors don't work or you need human-like interaction.

**Base path:** `POST /browsers/{id}/computer/*`

### Take Screenshot

```
POST /browsers/{id}/computer/screenshot
```

Returns `image/png` binary.

```bash
# Full screenshot (must use POST)
curl -s -X POST https://api.onkernel.com/browsers/$SESSION_ID/computer/screenshot \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -o screenshot.png

# Region screenshot
curl -s -X POST https://api.onkernel.com/browsers/$SESSION_ID/computer/screenshot \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"region": {"x": 0, "y": 0, "width": 800, "height": 600}}' \
  -o region.png
```

### Click Mouse

```
POST /browsers/{id}/computer/click-mouse
```

```json
{ "x": 100, "y": 200 }
// Optional: "button": "right", "click_type": "dblclick", "num_clicks": 2
```

### Move Mouse

```
POST /browsers/{id}/computer/move-mouse
```

```json
{ "x": 500, "y": 300 }
// Optional: "smooth": false (instant teleport), "duration_ms": 1500
```

Default movement uses human-like Bézier curves. Set `smooth: false` for instant movement.

### Type Text

```
POST /browsers/{id}/computer/type-text
```

```json
{ "text": "Hello, World!" }
// Optional: "smooth": false, "delay": 100 (ms between keystrokes when not smooth)
// Optional: "typo_chance": 0.03 (3% per-character typo rate, smooth mode only)
```

Default typing uses human-like variable timing. Set `smooth: false` for instant input.

### Press Key

```
POST /browsers/{id}/computer/press-key
```

```json
{ "keys": ["Ctrl+t"] }
// "keys": ["Ctrl+Shift+Tab"], "duration": 250, "hold_keys": ["Alt"]
```

### Scroll

```
POST /browsers/{id}/computer/scroll
```

```json
{ "x": 300, "y": 400, "delta_y": 120 }
// Positive delta_y = scroll down; positive delta_x = scroll right
```

### Drag Mouse

```
POST /browsers/{id}/computer/drag-mouse
```

```json
{
  "path": [[100, 200], [400, 350], [700, 200]],
  "button": "left"
}
```

Default: smooth Bézier curves between waypoints. Set `smooth: false` for linear interpolation.

## Browser Curl (HTTP through browser network stack)

Send HTTP requests through the browser's Chromium network stack — inherits cookies, TLS fingerprint, headers, proxy, and stealth settings.

### Buffered Curl

```
POST /browsers/{id}/curl
```

```bash
curl -s https://api.onkernel.com/browsers/$SESSION_ID/curl \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://httpbin.org/ip",
    "method": "GET",
    "timeout_ms": 30000
  }'
```

**Response:** `{ "status": 200, "headers": {...}, "body": "...", "duration_ms": 123 }`

For POST with body:

```json
{
  "url": "https://httpbin.org/post",
  "method": "POST",
  "headers": {"Content-Type": "application/json"},
  "body": "{\"key\": \"value\"}",
  "response_encoding": "utf8"
}
```

Use `response_encoding: "base64"` for binary responses.

### Streaming Fetch (SDK-only)

The SDK exposes `browsers.fetch(sessionId, url)` which returns a Web `Response` with streaming body. For raw REST, use buffered curl. For large downloads, prefer Playwright execution:

```typescript
// In Playwright — stream a download
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#download-link')
]);
return await download.path();
```

## Profiles (Persistent State)

Save browser state (cookies, localStorage) across sessions:

```bash
# Create a profile
curl -s https://api.onkernel.com/profiles \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-session"}'

# Use profile when creating a browser
curl -s https://api.onkernel.com/browsers \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "stealth": true,
    "profile": {"name": "my-session", "save_changes": true}
  }'

# List profiles
curl -s https://api.onkernel.com/profiles \
  -H "Authorization: Bearer $KERNEL_API_KEY"
```

Set `save_changes: true` to persist cookies/storage from the session back to the profile.

## Live View

Non-headless browsers get a `browser_live_view_url` for human-in-the-loop interaction. The URL is valid until the browser is deleted.

## Best Practices

1. **Always delete browsers when done.** Use bash traps or `finally` blocks.
   ```bash
   trap 'curl -s -X DELETE "$URL" -H "Authorization: Bearer $KEY"' EXIT
   ```

2. **Set realistic timeouts.** Default 60s is short. For research tasks, set 300–600s.

3. **Use Playwright for navigation, not `start_url`.** `start_url` is fire-and-forget — it dispatches navigation without waiting. The page may not be loaded when you take a screenshot. Always use `page.goto()` with `waitUntil: "networkidle"` inside a Playwright execute call for reliable navigation.

4. **Use Playwright screenshots in headless mode.** `POST /computer/screenshot` captures the OS-level screen which may show a blank/black canvas in headless browsers. Use Playwright's `page.screenshot()` instead — it runs in-VM and captures the rendered page reliably. Example:
   ```javascript
   const screenshot = await page.screenshot({ type: "png" });
   return screenshot.toString("base64");
   ```

5. **Use Playwright for content extraction.** It's faster than computer controls (no CDP overhead) and gives structured results.

6. **Use screenshots to see what's happening.** Before clicking, take a screenshot. After actions, take another to verify.

7. **Use profiles for authenticated sessions.** If you need to stay logged in across multiple browser sessions, create a profile with `save_changes: true`.

8. **Stealth mode for scraping.** Set `stealth: true` to reduce bot detection. Combine with browser curl for lightweight API calls that need browser cookies.

9. **Handling errors in Playwright.** Check `response.success` — failures surface in `response.error` and `response.stderr`.

10. **Concurrency limits.** Kernel enforces org/project concurrency caps. If you get 529 (Capacity Exhausted), wait and retry.

## Typical Patterns

### Pattern: Navigate, screenshot, and describe (combined with describe-image skill)

```bash
KERNEL_KEY=$(jq -r '.kernel.key' ~/.pi/agent/auth.json)

# 1. Create browser
BROWSER=$(curl -s https://api.onkernel.com/browsers \
  -H "Authorization: Bearer $KERNEL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"stealth":true,"headless":true,"timeout_seconds":120,"viewport":{"width":1280,"height":900}}')
SESSION_ID=$(echo "$BROWSER" | jq -r '.session_id')

# 2. Navigate + screenshot via Playwright (in-VM, reliable in headless)
RESULT=$(curl -s "https://api.onkernel.com/browsers/$SESSION_ID/playwright/execute" \
  -H "Authorization: Bearer $KERNEL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "await page.goto(\"https://en.wikipedia.org/wiki/Strawberry\", { waitUntil: \"networkidle\", timeout: 30000 }); const title = await page.title(); const screenshot = await page.screenshot({ type: \"png\" }); return { title, screenshot: screenshot.toString(\"base64\") };",
    "timeout_sec": 30
  }')

# 3. Decode screenshot
echo "$RESULT" | jq -r '.result.screenshot' | base64 -d > /tmp/page.png
echo "Page: $(echo "$RESULT" | jq -r '.result.title')"

# 4. Describe with Gemini
~/.pi/agent/skills/describe-image/describe-image /tmp/page.png \
  "Describe what this webpage is about and what key elements are visible."

# 5. Cleanup
curl -s -X DELETE "https://api.onkernel.com/browsers/$SESSION_ID" \
  -H "Authorization: Bearer $KERNEL_KEY" > /dev/null
```

### Pattern: Open page, extract content

```bash
# 1. Create browser
BROWSER=$(curl -s https://api.onkernel.com/browsers \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"stealth":true,"headless":true,"timeout_seconds":120}')
SESSION_ID=$(echo "$BROWSER" | jq -r '.session_id')

# 2. Navigate and extract via Playwright
RESULT=$(curl -s "https://api.onkernel.com/browsers/$SESSION_ID/playwright/execute" \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"code\": \"await page.goto('https://example.com'); return await page.evaluate(() => document.body.innerText);\"}")
echo "$RESULT" | jq -r '.result'

# 3. Clean up
curl -s -X DELETE "https://api.onkernel.com/browsers/$SESSION_ID" \
  -H "Authorization: Bearer $KERNEL_API_KEY"
```

### Pattern: Interactive browsing with screenshots

```bash
# Create headful browser with live view
BROWSER=$(curl -s https://api.onkernel.com/browsers \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"stealth":true,"headless":false,"timeout_seconds":600,"start_url":"https://example.com"}')
SESSION_ID=$(echo "$BROWSER" | jq -r '.session_id')
LIVE_URL=$(echo "$BROWSER" | jq -r '.browser_live_view_url')

echo "Live view: $LIVE_URL"

# Navigate and interact via Playwright
curl -s "https://api.onkernel.com/browsers/$SESSION_ID/playwright/execute" \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code":"await page.goto(\"https://github.com\"); return await page.title();"}'

# Take screenshot to see current state
curl -s "https://api.onkernel.com/browsers/$SESSION_ID/computer/screenshot" \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -o screenshot.png
```

### Pattern: Browser curl for API calls behind auth

```bash
# First, log in via Playwright
curl -s "https://api.onkernel.com/browsers/$SESSION_ID/playwright/execute" \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"
    await page.goto('https://example.com/login');
    await page.fill('#email', 'user@example.com');
    await page.fill('#password', 'pass');
    await page.click('button[type=\"submit\"]');
    await page.waitForLoadState('networkidle');
  \"}"

# Then use browser curl — inherits the login cookies
DATA=$(curl -s "https://api.onkernel.com/browsers/$SESSION_ID/curl" \
  -H "Authorization: Bearer $KERNEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/api/data","method":"GET"}')
echo "$DATA" | jq -r '.body'
```

## API Key Management

The API key is stored in `~/.pi/agent/auth.json` under the `kernel` key. To use in bash scripts:

```bash
KERNEL_API_KEY=$(jq -r '.kernel.key' ~/.pi/agent/auth.json)
```

To rotate the key: create a new one via the Kernel dashboard, update `auth.json`, delete the old key.

## Additional Resources

- **Full API reference:** https://kernel.sh/docs/llms.txt (index of all endpoints)
- **Concepts:** https://kernel.sh/docs/info/concepts
- **Docs home:** https://kernel.sh/docs/
- **Playwright API:** https://playwright.dev/docs/api/class-page
