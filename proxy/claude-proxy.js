// Claude API 本地代理 — 解决浏览器跨域问题
// 用法: npm run proxy
// 然后在 Settings 面板把 API URL 改为 http://localhost:8787/v1/messages
import http from 'node:http';
import { request as httpsRequest } from 'node:https';

const PORT = process.env.PROXY_PORT || 8787;
const TARGET = 'https://api.neorouter.ai';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access',
};

const server = http.createServer((req, res) => {
  // CORS: 允许浏览器跨域访问
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

  // 预检请求直接返回
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    const proxyReq = httpsRequest(
      TARGET + req.url,
      {
        method: req.method,
        headers: { ...req.headers, host: 'api.neorouter.ai' },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res); // 流式转发,支持 stream:true
      },
    );

    proxyReq.on('error', (err) => {
      console.error('[proxy] upstream error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: err.message } }));
    });

    if (body.length > 0) proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`\n  Claude API 代理已启动`);
  console.log(`  ───────────────────────────────────────`);
  console.log(`  代理地址: http://localhost:${PORT}`);
  console.log(`  目标地址: ${TARGET}`);
  console.log(`  ───────────────────────────────────────`);
  console.log(`  在 Settings → API URL 填入:`);
  console.log(`  http://localhost:${PORT}/v1/messages\n`);
});
