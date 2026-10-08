# Shotboard HTML service

Production HTTP service for Shotboard's HTML workflows.

## Routes

- `GET /__shotboard/rich-media-proxy?url=...` fetches remote HTML and preserves the final source URL in `x-shotboard-source-url`.
- `POST /__shotboard/html-screenshot` accepts `{ "html": "..." }` and returns a native Chrome PNG at `960 × 1440`.

Both routes include CORS headers for a frontend hosted on another origin.

## Run

Requires Node.js 18+. `npm ci` installs Puppeteer and its managed Chrome for native screenshots. Set `SHOTBOARD_CHROME_PATH` or `PUPPETEER_EXECUTABLE_PATH` only when using a system browser.
Puppeteer stores that browser under `.cache/puppeteer` inside the service directory so the executable remains available at runtime.

```bash
npm start
```

Set `PORT` and a browser path only when overriding the managed browser:

```bash
PORT=4176 SHOTBOARD_CHROME_PATH=/usr/bin/google-chrome npm start
```

The Shotboard frontend should be built with:

```bash
VITE_RICH_MEDIA_SERVICE_URL=https://your-service.example.com npm run build
```

## Render

Create a **Web Service** from the `main` branch and select **Docker**. Render will use `Dockerfile`; no separate build or start command is required. Set the health check path to `/healthz`. The Docker image installs Chromium and uses Render's assigned `PORT`.
