import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { Buffer } from 'node:buffer';

const DEFAULT_PORT = 8080;

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function formatDurationMs(startMs) {
  return `${(nowMs() - startMs).toFixed(1)}ms`;
}

function logRequest(event, details) {
  const parts = [`[localpilot] ${event}`];
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === '') continue;
    parts.push(`${key}=${JSON.stringify(value)}`);
  }
  console.log(parts.join(' '));
}

function isDebugEnabled(config) {
  return config.debug === true;
}

function jsonResponse(status, body) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function normalizeBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  return url.toString().replace(/\/$/, '');
}

async function readJsonBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  return {
    raw: body,
    json: body ? JSON.parse(body) : {},
  };
}

async function resolveModel(config) {
  if (config.model) return config.model;
  if (config.cachedModel) return config.cachedModel;

  const response = await fetch(`${config.lmStudioBaseUrl}/v1/models`);
  if (!response.ok) {
    throw new Error(`Failed to discover LM Studio model: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const model = payload?.data?.[0]?.id;
  if (!model) {
    throw new Error('LM Studio did not return any models');
  }

  config.cachedModel = model;
  return model;
}

export async function translateRequest({ pathname, method, headers, body, config }) {
  if (method === 'GET' && pathname === '/health') {
    return { type: 'local', response: jsonResponse(200, { ok: true }) };
  }

  if (method === 'GET' && (pathname === '/' || pathname === '')) {
    return {
      type: 'local',
      response: jsonResponse(200, {
        name: 'localpilot',
        ok: true,
        lmStudioBaseUrl: config.lmStudioBaseUrl,
      }),
    };
  }

  if (method === 'GET' && pathname.endsWith('/models')) {
    return {
      type: 'forward',
      targetUrl: `${config.lmStudioBaseUrl}/v1/models`,
      method: 'GET',
      headers: {},
    };
  }

  if (method !== 'POST') {
    return {
      type: 'local',
      response: jsonResponse(404, {
        error: `Unsupported route: ${method} ${pathname}`,
      }),
    };
  }

  const contentType = String(headers['content-type'] || '');
  if (!contentType.includes('application/json')) {
    return {
      type: 'local',
      response: jsonResponse(415, { error: 'Only application/json requests are supported' }),
    };
  }

  const payload = body ?? {};
  const model = payload.model || await resolveModel(config);

  if (pathname.includes('/chat/completions') || Array.isArray(payload.messages)) {
    return {
      type: 'forward',
      targetUrl: `${config.lmStudioBaseUrl}/v1/chat/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, model }),
    };
  }

  if (pathname.includes('/completions') || typeof payload.prompt === 'string') {
    return {
      type: 'forward',
      targetUrl: `${config.lmStudioBaseUrl}/v1/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, model }),
    };
  }

  return {
    type: 'local',
    response: jsonResponse(400, {
      error: 'Unable to map request to an LM Studio completion endpoint',
    }),
  };
}

async function fetchUpstream(route) {
  const response = await fetch(route.targetUrl, {
    method: route.method,
    headers: route.headers,
    body: route.body,
  });

  return response;
}

function copyHeaders(response, res) {
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-length') return;
    res.setHeader(key, value);
  });
}

async function writeFetchResponse(response, res) {
  copyHeaders(response, res);
  res.writeHead(response.status);
  if (!response.body) {
    res.end();
    return;
  }

  for await (const chunk of response.body) {
    res.write(chunk);
  }
  res.end();
}

async function handleHttpRequest(req, res, config) {
  const startedAt = nowMs();
  try {
    const requestUrl = parseIncomingRequestUrl(req);
    const pathname = requestUrl.pathname;
    logRequest('request:start', {
      transport: 'http',
      method: req.method,
      path: pathname,
      rawUrl: req.url,
      client: req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
    });
    const requestBody = req.method === 'POST' ? await readJsonBody(req) : undefined;
    const body = requestBody?.json;
    if (requestBody?.raw && isDebugEnabled(config)) {
      logRequest('request:body', {
        transport: 'http',
        method: req.method,
        path: pathname,
        body: requestBody.raw,
      });
    }
    const route = await translateRequest({
      pathname,
      method: req.method,
      headers: req.headers,
      body,
      config,
    });
    logRequest('request:routed', {
      transport: 'http',
      method: req.method,
      path: pathname,
      routeType: route.type,
      upstream: route.targetUrl,
    });

    if (route.type === 'local') {
      res.writeHead(route.response.status, route.response.headers);
      res.end(route.response.body);
      logRequest('request:done', {
        transport: 'http',
        method: req.method,
        path: pathname,
        status: route.response.status,
        duration: formatDurationMs(startedAt),
      });
      return;
    }

    const response = await fetchUpstream(route);
    await writeFetchResponse(response, res);
    logRequest('request:done', {
      transport: 'http',
      method: req.method,
      path: pathname,
      upstream: route.targetUrl,
      status: response.status,
      duration: formatDurationMs(startedAt),
    });
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
    logRequest('request:error', {
      transport: 'http',
      method: req.method,
      rawUrl: req.url,
      error: error.message,
      duration: formatDurationMs(startedAt),
    });
  }
}

function parseIncomingRequestUrl(req) {
  const host = req.headers.host || 'localhost';
  const raw = req.url || '/';
  if (/^https?:\/\//i.test(raw)) {
    return new URL(raw);
  }
  return new URL(raw, `http://${host}`);
}

function createTunnelResponse(statusCode, statusMessage, headers, body) {
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
  const finalHeaders = { ...headers };
  if (body && finalHeaders['Content-Length'] === undefined) {
    finalHeaders['Content-Length'] = Buffer.byteLength(body);
  }
  for (const [key, value] of Object.entries(finalHeaders)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('', body || '');
  return lines.join('\r\n');
}

function parseHttpLikeMessage(raw) {
  const [head, body = ''] = raw.split('\r\n\r\n');
  const [requestLine, ...headerLines] = head.split('\r\n');
  const [method, target] = requestLine.split(' ');
  const headers = {};
  for (const line of headerLines) {
    if (!line) continue;
    const index = line.indexOf(':');
    if (index === -1) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    headers[key] = line.slice(index + 1).trim();
  }
  return { method, target, headers, body };
}

async function handleTunnelTraffic(rawRequest, socket, config) {
  const startedAt = nowMs();
  try {
    const parsed = parseHttpLikeMessage(rawRequest);
    const url = /^https?:\/\//i.test(parsed.target)
      ? new URL(parsed.target)
      : new URL(parsed.target, 'http://placeholder');
    logRequest('request:start', {
      transport: 'connect',
      method: parsed.method,
      path: url.pathname,
      rawTarget: parsed.target,
      client: socket.remoteAddress,
    });
    if (parsed.body && isDebugEnabled(config)) {
      logRequest('request:body', {
        transport: 'connect',
        method: parsed.method,
        path: url.pathname,
        body: parsed.body,
      });
    }
    const payload = parsed.body ? JSON.parse(parsed.body) : undefined;
    const route = await translateRequest({
      pathname: url.pathname,
      method: parsed.method,
      headers: parsed.headers,
      body: payload,
      config,
    });
    logRequest('request:routed', {
      transport: 'connect',
      method: parsed.method,
      path: url.pathname,
      routeType: route.type,
      upstream: route.targetUrl,
    });

    if (route.type === 'local') {
      socket.end(createTunnelResponse(
        route.response.status,
        'OK',
        {
          'Content-Type': route.response.headers['content-type'],
          Connection: 'close',
        },
        route.response.body,
      ));
      logRequest('request:done', {
        transport: 'connect',
        method: parsed.method,
        path: url.pathname,
        status: route.response.status,
        duration: formatDurationMs(startedAt),
      });
      return;
    }

    const response = await fetchUpstream(route);
    const text = await response.text();
    const headers = { Connection: 'close' };
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'content-length') return;
      headers[key] = value;
    });
    socket.end(createTunnelResponse(response.status, response.statusText, headers, text));
    logRequest('request:done', {
      transport: 'connect',
      method: parsed.method,
      path: url.pathname,
      upstream: route.targetUrl,
      status: response.status,
      duration: formatDurationMs(startedAt),
    });
  } catch (error) {
    socket.end(createTunnelResponse(500, 'Internal Server Error', {
      'Content-Type': 'application/json; charset=utf-8',
      Connection: 'close',
    }, JSON.stringify({ error: error.message })));
    logRequest('request:error', {
      transport: 'connect',
      error: error.message,
      duration: formatDurationMs(startedAt),
    });
  }
}

function handleConnect(req, socket, head, config) {
  logRequest('connect:accepted', {
    target: req.url,
    client: socket.remoteAddress,
  });
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  let buffer = head && head.length ? head : Buffer.alloc(0);

  const onData = async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const asString = buffer.toString('utf8');
    const headerEnd = asString.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const headersPart = asString.slice(0, headerEnd);
    const contentLengthMatch = headersPart.match(/content-length:\s*(\d+)/i);
    const contentLength = contentLengthMatch ? Number(contentLengthMatch[1]) : 0;
    const totalLength = headerEnd + 4 + contentLength;
    if (buffer.length < totalLength) return;

    socket.removeListener('data', onData);
    await handleTunnelTraffic(asString.slice(0, totalLength), socket, config);
  };

  socket.on('data', onData);
  socket.on('error', () => {
    socket.destroy();
  });
}

export function createProxyServer(options = {}) {
  const config = {
    port: Number(options.port ?? process.env.PORT ?? DEFAULT_PORT),
    lmStudioBaseUrl: normalizeBaseUrl(options.lmStudioBaseUrl || process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234'),
    model: options.model || process.env.LM_STUDIO_MODEL || '',
    debug: (options.debug ?? process.env.DEBUG ?? 'false') === 'true',
    cachedModel: options.cachedModel,
  };

  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res, config);
  });

  server.on('connect', (req, socket, head) => {
    handleConnect(req, socket, head, config);
  });

  return { server, config };
}

export async function startProxyServer(options = {}) {
  const { server, config } = createProxyServer(options);
  await new Promise((resolve) => {
    server.listen(config.port, resolve);
  });
  return { server, config };
}
