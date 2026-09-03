/**
 * Local Development Server
 * Simulates Vercel serverless functions locally
 */

import http from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env for local development. Node only gained --env-file in 20, and this
// project supports 18, so read it here rather than add a dependency for four
// lines. Real environments (Vercel, CI) set variables directly and have no
// .env file, so this is a no-op there.
loadDotEnv();

const PORT = process.env.PORT || 3000;

/**
 * Read .env into process.env, without overwriting variables already set.
 * Supports `KEY=value`, `#` comments and blank lines — no quoting rules, which
 * is all this project's configuration needs.
 */
function loadDotEnv() {
  const envPath = join(__dirname, '.env');
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    // An explicit environment variable always wins over the file.
    if (key && process.env[key] === undefined) {
      process.env[key] = trimmed.slice(eq + 1).trim();
    }
  }
}

// MIME types
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Import API handlers
const handlers = {};

async function loadHandlers() {
  handlers['/api/2c2p/token'] = (await import('./api/2c2p/token.js')).default;
  handlers['/api/2c2p/inquiry'] = (await import('./lib/inquiryHandler.js')).default;
  handlers['/api/admin/login'] = (await import('./api/admin/login.js')).default;
  handlers['/api/admin/payments'] = (await import('./api/admin/payments/index.js')).default;
  handlers['/api/admin/config'] = (await import('./api/admin/config.js')).default;
  handlers['/api/admin/logs'] = (await import('./api/admin/logs.js')).default;
  
  // Dynamic routes loaded on demand
}

// Parse JSON body
async function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// Parse query string
function parseQuery(url) {
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return {};
  const queryString = url.slice(queryIndex + 1);
  return Object.fromEntries(new URLSearchParams(queryString));
}

// Create mock request/response for Vercel handlers
function createMockReqRes(req, res, body, query) {
  const mockReq = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
    query
  };

  const mockRes = {
    statusCode: 200,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      res.writeHead(this.statusCode, {
        'Content-Type': 'application/json',
        ...this.headers
      });
      res.end(JSON.stringify(data));
    },
    end(data) {
      res.writeHead(this.statusCode, this.headers);
      res.end(data);
    }
  };

  return { mockReq, mockRes };
}

// Serve static files
function serveStatic(res, filePath) {
  const fullPath = join(__dirname, 'public', filePath);
  
  if (!existsSync(fullPath)) {
    // Serve 404 page for HTML requests
    const notFoundPath = join(__dirname, 'public', '404.html');
    if (existsSync(notFoundPath)) {
      const content = readFileSync(notFoundPath);
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(content);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
    return;
  }

  const ext = extname(fullPath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  
  try {
    const content = readFileSync(fullPath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (error) {
    res.writeHead(500);
    res.end('Internal Server Error');
  }
}

// Main request handler
async function handleRequest(req, res) {
  const url = req.url;
  const pathname = url.split('?')[0];

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Mock-Delay, X-Mock-Error, X-Admin-Password'
    });
    res.end();
    return;
  }

  // API routes
  if (pathname.startsWith('/api/')) {
    const body = await parseBody(req);
    const query = parseQuery(url);

    // Handle consolidated routes (clear and response-codes)
    if (pathname === '/api/admin/payments/clear') {
      const handler = (await import('./api/admin/payments/index.js')).default;
      const { mockReq, mockRes } = createMockReqRes(req, res, body, query);
      try {
        await handler(mockReq, mockRes);
      } catch (error) {
        console.error('Handler error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    
    if (pathname === '/api/admin/response-codes') {
      const handler = (await import('./api/admin/config.js')).default;
      const { mockReq, mockRes } = createMockReqRes(req, res, body, query);
      try {
        await handler(mockReq, mockRes);
      } catch (error) {
        console.error('Handler error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    
    // Check for exact match first
    if (handlers[pathname]) {
      const { mockReq, mockRes } = createMockReqRes(req, res, body, query);
      try {
        await handlers[pathname](mockReq, mockRes);
      } catch (error) {
        console.error('Handler error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // Dynamic payment routes
    // Omise GET /api/omise/charges/:id - Explicit route (check BEFORE catch-all to match Vercel behavior)
    const omiseChargeGetMatch = pathname.match(/^\/api\/omise\/charges\/([^\/]+)$/);
    if (omiseChargeGetMatch && req.method === 'GET') {
      const handler = (await import('./api/omise/charges/[id].js')).default;
      const chargeId = omiseChargeGetMatch[1];
      const { mockReq, mockRes } = createMockReqRes(req, res, body, { ...query, id: chargeId });
      try {
        await handler(mockReq, mockRes);
      } catch (error) {
        console.error('Omise charge GET handler error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error', message: error.message }));
      }
      return;
    }
    
    // Demo endpoints: /api/demo/scenario, /api/demo/seed
    const demoMatch = pathname.match(/^\/api\/demo\/(.+)$/);
    if (demoMatch) {
      const handler = (await import('./api/demo/[...slug].js')).default;
      const { mockReq, mockRes } = createMockReqRes(req, res, body, { ...query, slug: demoMatch[1].split('/') });
      try {
        await handler(mockReq, mockRes);
      } catch (error) {
        console.error('Demo handler error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error', message: error.message }));
      }
      return;
    }
    
    // Callback inspector: /api/inspect and /api/inspect/:sessionId
    const inspectMatch = pathname.match(/^\/api\/inspect(?:\/(.+))?$/);
    if (inspectMatch) {
      const handler = (await import('./api/inspect/[[...slug]].js')).default;
      const slug = inspectMatch[1] ? inspectMatch[1].split('/') : [];
      const { mockReq, mockRes } = createMockReqRes(req, res, body, { ...query, slug });
      try {
        await handler(mockReq, mockRes);
      } catch (error) {
        console.error('Inspector handler error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error', message: error.message }));
      }
      return;
    }
    
    // Omise API routes - catch-all handler (for all other Omise routes)
    const omiseMatch = pathname.match(/^\/api\/omise\/(.+)$/);
    if (omiseMatch) {
      const handler = (await import('./api/omise/[...slug].js')).default;
      const pathSegments = omiseMatch[1].split('/');
      // Pass slug as array to match Vercel's behavior
      const { mockReq, mockRes } = createMockReqRes(req, res, body, { ...query, slug: pathSegments });
      try {
        await handler(mockReq, mockRes);
      } catch (error) {
        console.error('Omise handler error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error', message: error.message }));
      }
      return;
    }
    
    // Matches: /api/admin/payments/:invoiceNo (base) or /api/admin/payments/:invoiceNo/:action (sub-path)
    // Use index.js for base path (no action), [...slug].js for sub-paths (with action)
    const paymentMatch = pathname.match(/^\/api\/admin\/payments\/([^\/]+)(?:\/(.+))?$/);
    if (paymentMatch) {
      const invoiceNo = paymentMatch[1];
      const action = paymentMatch[2] || null;
      
      // Use index.js for base path (no action), [...slug].js for sub-paths (with action)
      const handlerPath = action 
        ? './api/admin/payments/[invoiceNo]/[...slug].js'
        : './api/admin/payments/[invoiceNo]/index.js';
      
      const handler = (await import(handlerPath)).default;
      const { mockReq, mockRes } = createMockReqRes(req, res, body, { ...query, invoiceNo, action });
      try {
        await handler(mockReq, mockRes);
      } catch (error) {
        console.error('Handler error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    
    // 2C2P catch-all routes (info, optionDetails, payment, qr)
    // Note: token and inquiry are handled above as specific routes
    const c2pMatch = pathname.match(/^\/api\/2c2p\/(.+)$/);
    if (c2pMatch) {
      const handler = (await import('./api/2c2p/[...slug].js')).default;
      const pathSegments = c2pMatch[1].split('/');
      const { mockReq, mockRes } = createMockReqRes(req, res, body, { ...query, slug: pathSegments });
      try {
        await handler(mockReq, mockRes);
      } catch (error) {
        console.error('2C2P handler error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error', message: error.message }));
      }
      return;
    }

    // Not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  // Static routes with rewrites
  if (pathname.startsWith('/payment/')) {
    serveStatic(res, 'payment.html');
    return;
  }

  if (pathname.startsWith('/mock-pay/')) {
    serveStatic(res, 'mock-pay.html');
    return;
  }

  // Clean URL for login
  if (pathname === '/login') {
    serveStatic(res, 'login.html');
    return;
  }

  // Static file serving
  let filePath = pathname;
  if (filePath === '/') filePath = '/index.html';
  // Extensionless routes mirror the rewrites in vercel.json.
  if (filePath === '/dashboard') filePath = '/dashboard.html';
  if (filePath === '/inspector') filePath = '/inspector.html';
  
  serveStatic(res, filePath);
}

// Start server
async function start() {
  await loadHandlers();
  
  const server = http.createServer(handleRequest);
  
  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Paygate Sandbox                                             ║
║                                                              ║
║    Dashboard:  http://localhost:${PORT}                         ║
║    Inspector:  http://localhost:${PORT}/inspector               ║
║    Password:   mockpay                                       ║
║                                                              ║
║  Provider APIs                                               ║
║    POST /api/2c2p/token                                      ║
║    POST /api/2c2p/inquiry                                    ║
║    POST /api/2c2p/payment            (QR)                    ║
║    POST /api/omise/charges                                   ║
║    GET  /api/omise/charges/:id                               ║
║                                                              ║
║  Sandbox APIs                                                ║
║    POST /api/inspect/:sessionId      (callback sink)         ║
║    POST /api/demo/scenario           (guided demo)           ║
║    POST /api/demo/seed                                       ║
╚══════════════════════════════════════════════════════════════╝
    `);
  });
}

start();
