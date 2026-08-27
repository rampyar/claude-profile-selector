#!/usr/bin/env node
/**
 * OmniRoute Hot-Swap Proxy v2
 *
 * - Sits between Claude Code and OmniRoute on port 20130
 * - Watches .claude/settings.local.json for model changes
 * - Swaps the model on EVERY outgoing request automatically
 * - Self-healing: re-patches ANTHROPIC_BASE_URL if anything resets it to 20128
 *
 * Run: node proxy.js   (keep this terminal open alongside omniroute)
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── Config ───────────────────────────────────────────────────────────────────

const OMNIROUTE_HOST  = 'localhost';
const OMNIROUTE_PORT  = 20128;
const PROXY_PORT      = 20130;

// The workspace settings file to watch
const WORKSPACE_DIR   = path.resolve(__dirname, '..', '..', '.claude');
const LOCAL_SETTINGS  = path.join(WORKSPACE_DIR, 'settings.local.json');

// ─── State ────────────────────────────────────────────────────────────────────

let activeModel = null;

// ─── Read model from settings.local.json ─────────────────────────────────────

function readModel() {
  try {
    if (fs.existsSync(LOCAL_SETTINGS)) {
      const json = JSON.parse(fs.readFileSync(LOCAL_SETTINGS, 'utf-8'));
      return json.model || json.env?.ANTHROPIC_MODEL || null;
    }
  } catch {}
  return null;
}

// ─── Patch settings.local.json to always point base URL at proxy ──────────────

function ensureProxyUrl() {
  try {
    if (!fs.existsSync(LOCAL_SETTINGS)) return;
    const raw  = fs.readFileSync(LOCAL_SETTINGS, 'utf-8');
    const json = JSON.parse(raw);
    const currentUrl = json.env?.ANTHROPIC_BASE_URL || '';
    if (!currentUrl.includes(':20130')) {
      json.env = json.env || {};
      json.env.ANTHROPIC_BASE_URL = `http://localhost:${PROXY_PORT}`;
      fs.writeFileSync(LOCAL_SETTINGS, JSON.stringify(json, null, 2));
      console.log(`[Self-heal] ANTHROPIC_BASE_URL reset → http://localhost:${PROXY_PORT}`);
    }
  } catch (e) {
    console.error('[Self-heal error]', e.message);
  }
}

// ─── Watch settings.local.json for changes ───────────────────────────────────

function startWatcher() {
  if (!fs.existsSync(WORKSPACE_DIR)) return;

  // Initial read
  activeModel = readModel();
  console.log(`[Init] Active model: ${activeModel || '(none)'}`);

  // Patch URL immediately
  ensureProxyUrl();

  // Watch for changes
  try {
    fs.watch(LOCAL_SETTINGS, { persistent: true }, (event) => {
      if (event !== 'change') return;
      // Small delay to let the writer finish
      setTimeout(() => {
        const newModel = readModel();
        if (newModel && newModel !== activeModel) {
          console.log(`[Model changed] ${activeModel} → ${newModel}`);
          activeModel = newModel;
        }
        // Always re-patch the URL in case something reset it
        ensureProxyUrl();
      }, 100);
    });
    console.log(`[Watcher] Watching ${LOCAL_SETTINGS}`);
  } catch (e) {
    console.warn(`[Watcher] Could not watch settings file: ${e.message}`);
  }
}

// ─── Proxy Server ─────────────────────────────────────────────────────────────

const server = http.createServer((clientReq, clientRes) => {
  let bodyChunks = [];

  clientReq.on('data', chunk => bodyChunks.push(chunk));
  clientReq.on('end', () => {
    const rawBody = Buffer.concat(bodyChunks);
    let finalBody = rawBody;
    let finalLen  = rawBody.length;

    // Hot-swap model in POST requests
    if (clientReq.method === 'POST' && activeModel) {
      try {
        const json = JSON.parse(rawBody.toString());
        if (json.model !== undefined) {
          const prev = json.model;
          json.model = activeModel;
          const newBody = Buffer.from(JSON.stringify(json));
          finalBody = newBody;
          finalLen  = newBody.length;
          if (prev !== activeModel) {
            console.log(`[Swap] ${clientReq.url} | ${prev} → ${activeModel}`);
          }
        }
      } catch {}
    }

    // Forward to OmniRoute
    const headers = { ...clientReq.headers };
    delete headers['host'];
    headers['content-length'] = finalLen;

    const opts = {
      hostname: OMNIROUTE_HOST,
      port:     OMNIROUTE_PORT,
      path:     clientReq.url,
      method:   clientReq.method,
      headers,
    };

    const proxyReq = http.request(opts, proxyRes => {
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes, { end: true });
    });

    proxyReq.on('error', err => {
      console.error(`[Proxy Error] ${err.message}`);
      if (!clientRes.headersSent) clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { message: 'OmniRoute unreachable', type: 'proxy_error' } }));
    });

    proxyReq.write(finalBody);
    proxyReq.end();
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

startWatcher();

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`
  ┌─────────────────────────────────────────────────────┐
  │  OmniRoute Hot-Swap Proxy v2                        │
  │                                                     │
  │  Proxy:     http://127.0.0.1:${PROXY_PORT}                │
  │  Gateway:   http://localhost:${OMNIROUTE_PORT}                │
  │  Watching:  ${LOCAL_SETTINGS.replace(os.homedir(), '~')}
  │                                                     │
  │  Change model in VS Code → takes effect instantly!  │
  │  No Claude terminal restart needed.                 │
  └─────────────────────────────────────────────────────┘
`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌  Port ${PROXY_PORT} already in use. Kill existing process first:\n   netstat -ano | findstr :${PROXY_PORT}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

process.on('SIGINT',  () => { console.log('\nProxy stopped.'); server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
