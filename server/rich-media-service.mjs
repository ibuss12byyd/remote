import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const RICH_MEDIA_PROXY_PATH = '/__shotboard/rich-media-proxy';
export const HTML_SCREENSHOT_PATH = '/__shotboard/html-screenshot';

const MAX_HTML_SOURCE_BYTES = 20 * 1024 * 1024;
const SCREENSHOT_TIMEOUT_MS = 30000;
const NATIVE_SCREENSHOT_LAYOUT_STYLE = `
<style id="shotboard-native-screenshot-layout">
  html, body {
    box-sizing: border-box !important;
    width: 320px !important;
    min-width: 320px !important;
    max-width: 320px !important;
    height: 480px !important;
    min-height: 480px !important;
    max-height: 480px !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
  }
  #hype_wrapper,
  #shotboard-rich-media-wrapper {
    position: fixed !important;
    top: 0 !important;
    right: auto !important;
    bottom: auto !important;
    left: 0 !important;
    width: 320px !important;
    height: 480px !important;
    margin: 0 !important;
  }
  #main_creative_container,
  #fullscreen_container,
  #container,
  #shotboard-rich-media-container,
  .HYPE_document {
    margin-left: 0 !important;
    margin-right: 0 !important;
  }
</style>
`;

function bundledChromeExecutable() {
  try {
    return puppeteer.executablePath();
  } catch {
    return null;
  }
}

function findChromeExecutable() {
  const candidates = [
    process.env.SHOTBOARD_CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : null,
    process.platform === 'darwin'
      ? '/Applications/Chromium.app/Contents/MacOS/Chromium'
      : null,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    bundledChromeExecutable(),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function prepareNativeScreenshotHtml(source) {
  const closingHead = /<\/head\s*>/i;
  if (closingHead.test(source)) {
    return source.replace(closingHead, `${NATIVE_SCREENSHOT_LAYOUT_STYLE}$&`);
  }
  const closingBody = /<\/body\s*>/i;
  if (closingBody.test(source)) {
    return source.replace(closingBody, `${NATIVE_SCREENSHOT_LAYOUT_STYLE}$&`);
  }
  return `${NATIVE_SCREENSHOT_LAYOUT_STYLE}${source}`;
}

async function readRequestBody(request) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_HTML_SOURCE_BYTES) {
      throw new Error('The HTML source is too large.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function runChromeScreenshot(executable, htmlPath, screenshotPath, profilePath) {
  const child = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-crash-reporter',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    '--run-all-compositor-stages-before-draw',
    '--window-size=320,480',
    '--force-device-scale-factor=3',
    '--virtual-time-budget=5000',
    `--user-data-dir=${profilePath}`,
    `--screenshot=${screenshotPath}`,
    pathToFileURL(htmlPath).href,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let processError = null;
  child.stderr?.on('data', () => {});
  child.once('error', (error) => {
    processError = error;
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < SCREENSHOT_TIMEOUT_MS) {
    if (processError) {
      throw processError;
    }
    try {
      const output = await stat(screenshotPath);
      if (output.size > 0) {
        child.kill('SIGKILL');
        return;
      }
    } catch {
      // Chrome has not written the screenshot yet.
    }
    await delay(100);
  }
  child.kill('SIGKILL');
  throw new Error('The native HTML screenshot timed out.');
}

function setCorsHeaders(response) {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
  response.setHeader('access-control-expose-headers', 'x-shotboard-source-url');
}

function handleOptions(response) {
  setCorsHeaders(response);
  response.statusCode = 204;
  response.end();
}

async function handleHtmlScreenshot(request, response) {
  setCorsHeaders(response);
  if (request.method === 'OPTIONS') {
    handleOptions(response);
    return;
  }
  if (request.method !== 'POST') {
    response.statusCode = 405;
    response.setHeader('allow', 'POST, OPTIONS');
    response.end('Method Not Allowed');
    return;
  }

  let source;
  try {
    const body = JSON.parse(await readRequestBody(request));
    if (typeof body.html !== 'string' || !body.html.trim()) {
      response.statusCode = 400;
      response.end('A non-empty html field is required.');
      return;
    }
    source = body.html;
  } catch (error) {
    response.statusCode = 400;
    response.end(error instanceof Error ? error.message : 'Invalid JSON.');
    return;
  }

  const executable = findChromeExecutable();
  if (!executable) {
    response.statusCode = 503;
    response.end('A Chrome or Chromium executable is required for native HTML screenshots.');
    return;
  }

  const workDirectory = await mkdtemp(join(tmpdir(), 'shotboard-html-'));
  const htmlPath = join(workDirectory, 'creative.html');
  const screenshotPath = join(workDirectory, 'creative.png');
  const profilePath = join(workDirectory, 'profile');
  try {
    await writeFile(htmlPath, prepareNativeScreenshotHtml(source), 'utf8');
    await runChromeScreenshot(executable, htmlPath, screenshotPath, profilePath);
    const png = await readFile(screenshotPath);
    response.statusCode = 200;
    response.setHeader('content-type', 'image/png');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-length', png.byteLength);
    response.end(png);
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : 'Native HTML screenshot failed.');
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function handleRichMediaProxy(request, response) {
  setCorsHeaders(response);
  if (request.method === 'OPTIONS') {
    handleOptions(response);
    return;
  }
  if (request.method !== 'GET') {
    response.statusCode = 405;
    response.setHeader('allow', 'GET, OPTIONS');
    response.end('Method Not Allowed');
    return;
  }

  const requestUrl = new URL(request.url ?? '/', 'http://shotboard.local');
  const targetUrl = requestUrl.searchParams.get('url');
  if (!targetUrl) {
    response.statusCode = 400;
    response.end('A valid HTTP(S) url query parameter is required.');
    return;
  }

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    response.statusCode = 400;
    response.end('A valid HTTP(S) url query parameter is required.');
    return;
  }
  if (!/^https?:$/i.test(target.protocol)) {
    response.statusCode = 400;
    response.end('A valid HTTP(S) url query parameter is required.');
    return;
  }

  try {
    const upstream = await fetch(targetUrl);
    response.statusCode = upstream.status;
    response.setHeader(
      'content-type',
      upstream.headers.get('content-type') || 'application/octet-stream',
    );
    response.setHeader('x-shotboard-source-url', upstream.url);
    response.setHeader('cache-control', 'no-store');
    response.end(new Uint8Array(await upstream.arrayBuffer()));
  } catch (error) {
    response.statusCode = 502;
    response.end(error instanceof Error ? error.message : 'Upstream request failed.');
  }
}

export async function handleRichMediaRequest(request, response) {
  const pathname = new URL(request.url ?? '/', 'http://shotboard.local').pathname;
  if (pathname.startsWith(HTML_SCREENSHOT_PATH)) {
    await handleHtmlScreenshot(request, response);
    return true;
  }
  if (pathname.startsWith(RICH_MEDIA_PROXY_PATH)) {
    await handleRichMediaProxy(request, response);
    return true;
  }
  return false;
}
