import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startProxyServer } from '../src/proxy.js';

async function startFakeLmStudio() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, url: req.url, body });

    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return;
    }

    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: 'hello from lm-studio' } }],
      }));
      return;
    }

    if (req.url === '/v1/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl-1',
        choices: [{ text: 'completion from lm-studio' }],
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('proxies GET /models to LM Studio', async () => {
  const lm = await startFakeLmStudio();
  const proxy = await startProxyServer({ port: 0, lmStudioBaseUrl: lm.baseUrl });
  const proxyAddress = proxy.server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/models`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [{ id: 'test-model' }] });
    assert.equal(lm.requests[0].url, '/v1/models');
  } finally {
    await closeServer(proxy.server);
    await closeServer(lm.server);
  }
});

test('maps chat completion requests to /v1/chat/completions', async () => {
  const lm = await startFakeLmStudio();
  const proxy = await startProxyServer({ port: 0, lmStudioBaseUrl: lm.baseUrl });
  const proxyAddress = proxy.server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.choices[0].message.content, 'hello from lm-studio');
    assert.equal(lm.requests[0].url, '/v1/models');
    assert.equal(lm.requests[1].url, '/v1/chat/completions');
    assert.equal(lm.requests[1].body.model, 'test-model');
  } finally {
    await closeServer(proxy.server);
    await closeServer(lm.server);
  }
});

test('maps legacy completion routes to /v1/completions', async () => {
  const lm = await startFakeLmStudio();
  const proxy = await startProxyServer({ port: 0, lmStudioBaseUrl: lm.baseUrl });
  const proxyAddress = proxy.server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/engines/copilot-codex/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'function hello() {' }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.choices[0].text, 'completion from lm-studio');
    assert.equal(lm.requests[1].url, '/v1/completions');
    assert.equal(lm.requests[1].body.model, 'test-model');
  } finally {
    await closeServer(proxy.server);
    await closeServer(lm.server);
  }
});

test('supports the Neovim Copilot completion endpoint path', async () => {
  const lm = await startFakeLmStudio();
  const proxy = await startProxyServer({ port: 0, lmStudioBaseUrl: lm.baseUrl });
  const proxyAddress = proxy.server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/engines/gpt-41-copilot/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'return 42' }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.choices[0].text, 'completion from lm-studio');
    assert.equal(lm.requests[1].url, '/v1/completions');
    assert.equal(lm.requests[1].body.prompt, 'return 42');
  } finally {
    await closeServer(proxy.server);
    await closeServer(lm.server);
  }
});

test('supports Copilot CONNECT reverse-proxy tunneling', async () => {
  const lm = await startFakeLmStudio();
  const proxy = await startProxyServer({ port: 0, lmStudioBaseUrl: lm.baseUrl });
  const proxyAddress = proxy.server.address();

  try {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyAddress.port });
    const chunks = [];
    const body = '{"prompt":"const x = 1;"}';
    let tunneledRequestSent = false;

    const result = await new Promise((resolve, reject) => {
      socket.on('connect', () => {
        socket.write('CONNECT api.githubcopilot.com HTTP/1.1\r\nHost: api.githubcopilot.com\r\n\r\n');
      });
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        if (!tunneledRequestSent && text.includes('\r\n\r\n') && text.startsWith('HTTP/1.1 200 Connection Established')) {
          tunneledRequestSent = true;
          socket.write(
            'POST https://api.githubcopilot.com/v1/engines/copilot-codex/completions HTTP/1.1\r\n' +
            'Host: api.githubcopilot.com\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
            body
          );
        } else if (text.includes('completion from lm-studio')) {
          socket.end();
          resolve(text);
        }
      });
      socket.on('error', reject);
    });

    assert.match(result, /HTTP\/1\.1 200 OK/);
    assert.match(result, /completion from lm-studio/);
    assert.equal(lm.requests[1].url, '/v1/completions');
  } finally {
    await closeServer(proxy.server);
    await closeServer(lm.server);
  }
});
