import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRichMediaRequest } from './server/rich-media-service.mjs';

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const distRoot = resolve(projectRoot, 'dist');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 4173);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4v': 'video/mp4',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function staticPath(requestPath) {
  const decodedPath = decodeURIComponent(requestPath);
  const relativePath = decodedPath.replace(/^\/+/, '') || 'index.html';
  const candidate = resolve(distRoot, relativePath);
  const fromRoot = relative(distRoot, candidate);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || fromRoot.startsWith(sep)) {
    return null;
  }
  return candidate;
}

async function resolveStaticFile(requestPath) {
  const candidate = staticPath(requestPath);
  if (!candidate) {
    return null;
  }
  try {
    const details = await stat(candidate);
    if (details.isFile()) {
      return candidate;
    }
    if (details.isDirectory()) {
      return resolve(candidate, 'index.html');
    }
  } catch {
    // Fall through to the SPA entry point.
  }
  return resolve(distRoot, 'index.html');
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host || 'localhost'}`);
  const filePath = await resolveStaticFile(requestUrl.pathname);
  if (!filePath) {
    response.statusCode = 403;
    response.end('Forbidden');
    return;
  }

  try {
    const details = await stat(filePath);
    response.statusCode = 200;
    response.setHeader('content-type', contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream');
    response.setHeader('content-length', details.size);
    response.setHeader('cache-control', filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  } catch {
    response.statusCode = 500;
    response.end('Static file service failed.');
  }
}

const server = createServer(async (request, response) => {
  try {
    if (await handleRichMediaRequest(request, response)) {
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('allow', 'GET, HEAD, OPTIONS');
      response.end('Method Not Allowed');
      return;
    }
    await serveStatic(request, response);
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : 'Server request failed.');
  }
});

server.listen(port, host, () => {
  console.log(`Shotboard production server listening on http://${host}:${port}`);
});
