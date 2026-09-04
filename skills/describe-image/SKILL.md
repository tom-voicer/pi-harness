---
name: describe-image
description: Describe images using Google Gemini Vision. Use when you need to understand what's in an image — photos, screenshots, diagrams, UI mockups, or any visual content. Supports both URLs and local file paths. Accepts an optional custom prompt to ask specific questions about the image.
license: MIT
---

# Describe Image (Gemini Vision)

Use Gemini 2.5 Flash to describe or analyze images. The skill provides a simple CLI script (`describe-image`) that handles URL downloading, local file reading, base64 encoding, and the Gemini Vision API call.

## Quick Usage

```bash
# Describe an image with the default prompt
~/.pi/agent/skills/describe-image/describe-image <image-url-or-path>

# Ask a custom question about the image
~/.pi/agent/skills/describe-image/describe-image <image-url-or-path> "What text is visible in this screenshot?"

# Use it on a screenshot you just took
~/.pi/agent/skills/describe-image/describe-image /tmp/screenshot.png

# Use it on an image URL
~/.pi/agent/skills/describe-image/describe-image "https://example.com/photo.jpg"
```

## How It Works

1. **Resolve source:** If the input starts with `http://` or `https://`, it downloads the image to a temp file. Otherwise, it treats it as a local file path.
2. **Detect MIME type:** Uses `file --mime-type` to determine the image format (jpeg, png, webp, gif, bmp, tiff supported).
3. **Base64 encode:** Converts the image to base64 for the Gemini API.
4. **Call Gemini:** Sends the image + prompt to `gemini-2.5-flash` via the REST API.
5. **Output:** Prints the text description to stdout.

## Default Prompt

When no custom prompt is given:

> *Describe in detail what you see in the image.*

## Custom Prompts — Examples

| Prompt | Use case |
|--------|----------|
| `"What text is visible in this screenshot?"` | Extract UI text, code, logs |
| `"What UI elements are on this page?"` | Analyze a screenshot of a website |
| `"Is there a form on this page? What fields?"` | Identify interactive elements |
| `"What error message is shown?"` | Debug from screenshots |
| `"Describe the layout and navigation of this page"` | UX analysis |
| `"What is the weather like in this photo?"` | Scene analysis |
| `"Are there any people in this image? How many?"` | Object/person detection |
| `"Extract all visible text verbatim"` | OCR-like text extraction |
| `"What colors and styling are used in this UI?"` | Design analysis |
| `"Does this screenshot show any error states?"` | QA / bug detection |

## Combined with Kernel Browser

A powerful pattern: use Kernel to navigate and screenshot, then Gemini to describe:

```bash
KEY=$(jq -r '.kernel.key' ~/.pi/agent/auth.json)

# 1. Create browser and navigate
BROWSER=$(curl -s https://api.onkernel.com/browsers \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"stealth":true,"headless":true,"timeout_seconds":120,"start_url":"https://example.com"}')
SESSION_ID=$(echo "$BROWSER" | jq -r '.session_id')
sleep 3

# 2. Take screenshot
curl -s -X POST "https://api.onkernel.com/browsers/$SESSION_ID/computer/screenshot" \
  -H "Authorization: Bearer $KEY" \
  -o /tmp/page.png

# 3. Describe with custom prompt
~/.pi/agent/skills/describe-image/describe-image /tmp/page.png \
  "What is this website about? Describe the layout and main content."

# 4. Cleanup
curl -s -X DELETE "https://api.onkernel.com/browsers/$SESSION_ID" \
  -H "Authorization: Bearer $KEY" > /dev/null
```

## API Key

The Gemini API key is stored in `~/.pi/agent/auth.json` under the `gemini` key:

```bash
jq -r '.gemini.key' ~/.pi/agent/auth.json
```

## Supported Image Types

- JPEG (`image/jpeg`)
- PNG (`image/png`)
- WebP (`image/webp`)
- GIF (`image/gif` — single frame)
- BMP (`image/bmp`)
- TIFF (`image/tiff`)

## Error Handling

- **Missing API key:** prints error and exits 1
- **Download failure:** prints error and exits 1
- **File not found:** prints error and exits 1
- **Unsupported MIME type:** prints error and exits 1
- **Gemini API error:** prints the error message from Gemini and exits 1

## Model

Uses `gemini-2.5-flash` which is fast, cost-effective, and supports vision. To use a different model, edit the script or pass `MODEL` env var.
