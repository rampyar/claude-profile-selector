// Claude Code Model Selector – VS Code Extension v3
// Fetches live model list from OmniRoute (localhost:20128).
// "auto/*" models = OmniRoute picks the best provider automatically.
// Provider-prefixed models = you pick exact provider + model.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// ─── Constants ────────────────────────────────────────────────────────────────

const OMNIROUTE_BASE_URL = 'http://localhost:20128';
const OMNIROUTE_MODELS_URL = `${OMNIROUTE_BASE_URL}/v1/models`;

const LOCAL_SETTINGS_SCHEMA = 'https://json.schemastore.org/claude-code-settings.json';

// Standalone hot-swap proxy (proxy.js) runs on this port
const PROXY_PORT     = 20130;
const PROXY_BASE_URL = `http://localhost:${PROXY_PORT}`;

// Shared state file read by proxy.js on every request
const STATE_FILE = path.join(os.homedir(), '.claude', 'omniroute-active-model.json');

// ─── State ────────────────────────────────────────────────────────────────────

let statusBarItem;
let currentModelId = null;
let _modelCache = null;
let _modelCacheTime = 0;
const MODEL_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

// Health probe cache — { modelId: 'ok'|'error'|'slow' }
const _probeCache = new Map();
const PROBE_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const _probeTimes = new Map();

// ─── OmniRoute API ────────────────────────────────────────────────────────────

function fetchOmniRouteModels(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _modelCache && (now - _modelCacheTime) < MODEL_CACHE_TTL_MS) {
    return Promise.resolve(_modelCache);
  }

  return new Promise((resolve, reject) => {
    const req = http.get(OMNIROUTE_MODELS_URL, { timeout: 8000 }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          const all = json.data || json;

          // Filter: text output only, skip no-think/* duplicates, skip media types
          const SKIP_TYPES = ['image', 'video', 'audio', 'rerank'];
          const models = all.filter(m => {
            if (m.id.startsWith('no-think/')) return false;
            if (m.type && SKIP_TYPES.includes(m.type)) return false;
            if (m.output_modalities && !m.output_modalities.includes('text')) return false;
            return true;
          });

          _modelCache = models;
          _modelCacheTime = Date.now();
          resolve(models);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OmniRoute timed out')); });
  });
}

// ─── Health probe ─────────────────────────────────────────────────────────────

/**
 * Probe a model with a minimal request. Returns 'ok', 'error', or 'slow'.
 * Results are cached for PROBE_CACHE_TTL_MS.
 */
function probeModel(modelId, apiKey) {
  const now = Date.now();
  const cached = _probeCache.get(modelId);
  const cachedAt = _probeTimes.get(modelId) || 0;
  if (cached && (now - cachedAt) < PROBE_CACHE_TTL_MS) {
    return Promise.resolve(cached);
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: modelId,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const opts = {
      hostname: 'localhost',
      port: 20128,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 12000,
    };

    const req = http.request(opts, (res) => {
      res.resume(); // drain
      const status = res.statusCode >= 200 && res.statusCode < 400 ? 'ok' : 'error';
      _probeCache.set(modelId, status);
      _probeTimes.set(modelId, Date.now());
      resolve(status);
    });

    req.on('error', () => {
      _probeCache.set(modelId, 'error');
      _probeTimes.set(modelId, Date.now());
      resolve('error');
    });
    req.on('timeout', () => {
      req.destroy();
      _probeCache.set(modelId, 'slow');
      _probeTimes.set(modelId, Date.now());
      resolve('slow');
    });

    req.write(body);
    req.end();
  });
}

/**
 * Status badge for probe result.
 */
function probeBadge(status) {
  if (status === 'ok')    return '✅';
  if (status === 'slow')  return '⏳';
  if (status === 'error') return '❌';
  return '○'; // unknown
}

// ─── Group / label logic ──────────────────────────────────────────────────────

// Logical section order — "Auto" always first (OmniRoute decides provider)
const SECTION_ORDER = [
  'auto',        // combo/auto models — OmniRoute picks best provider
  'auggie',
  'antigravity',
  'agentrouter',
  'kiro',
  'duckduckgo-web',
  'chipotle',
  'deepseek',
  'opencode',
  'mimocode',
  'openrouter',
  'nvidia',
  'theoldllm',
  'veoaifree-web',
];

const SECTION_LABELS = {
  'auto':          '🔀 Auto (OmniRoute decides provider)',
  'auggie':        '🔮 Auggie',
  'antigravity':   '⚡ Antigravity',
  'agentrouter':   '🤖 AgentRouter',
  'kiro':          '🎯 Kiro',
  'duckduckgo-web':'🦆 DuckDuckGo Web',
  'chipotle':      '🌯 Chipotle / Pepper',
  'deepseek':      '🐋 DeepSeek',
  'opencode':      '💻 OpenCode',
  'mimocode':      '🦜 MimoCode',
  'openrouter':    '🌐 OpenRouter',
  'nvidia':        '🟢 NVIDIA',
  'theoldllm':     '📜 TheOldLLM',
  'veoaifree-web': '🎬 Veo (Free)',
};

/**
 * Determine the section key for a model.
 * "combo"-owned models with id starting "auto/" go into the "auto" section.
 */
function sectionKey(model) {
  if (model.owned_by === 'combo' || model.id.startsWith('auto/')) return 'auto';
  return model.owned_by || 'other';
}

/**
 * Clean up the display name:
 * - Strip leading provider prefix from name (e.g. "kr/MiniMax M2.5" → "MiniMax M2.5")
 * - Fall back to prettifying the id
 */
function displayName(model) {
  let name = model.name || '';

  // Strip "provider/" prefix from name field
  name = name.replace(/^[a-z0-9_-]+\//i, '');

  if (!name || name === model.id) {
    // Prettify the id: strip first segment (provider prefix), replace dashes/dots
    const parts = model.id.split('/');
    const base = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
    name = base
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  return name.trim() || model.id;
}

/**
 * Determine pricing tag for a model based on ID signals and provider.
 *
 * Rules (in priority order):
 *  FREE  — id ends with ":free", contains "best-free", "offline", "duckduckgo-web" provider
 *  CHEAP — id ends with ":cheap", contains "cheap"
 *  PAID  — everything else
 *
 * Returns one of: { tag: 'FREE', badge: '🟢 FREE' }
 *                 { tag: 'CHEAP', badge: '🟡 CHEAP' }
 *                 { tag: 'PAID', badge: '🔴 PAID' }
 */
function getPricingTag(model) {
  const id = model.id.toLowerCase();
  const provider = (model.owned_by || '').toLowerCase();

  // Free signals
  if (
    id.endsWith(':free') ||
    id.includes('best-free') ||
    id.includes('/free') ||
    id.includes('offline') ||
    provider === 'duckduckgo-web'
  ) {
    return { tag: 'FREE',  badge: '🟢 FREE' };
  }

  // Cheap signals
  if (id.endsWith(':cheap') || id.includes('cheap')) {
    return { tag: 'CHEAP', badge: '🟡 CHEAP' };
  }

  // Default — paid
  return { tag: 'PAID', badge: '🔴 PAID' };
}

/**
 * Build QuickPick items grouped by section.
 */
function buildQuickPickItems(models, activeModelId) {
  const groups = new Map();

  for (const model of models) {
    const key = sectionKey(model);
    if (!groups.has(key)) groups.set(key, []);

    const isActive = model.id === activeModelId;
    const hasThinking = model.capabilities?.reasoning === true &&
                        model.capabilities?.supportsThinking !== false;
    const ctx = model.context_length
      ? `${Math.round(model.context_length / 1000)}k`
      : '';

    const name = displayName(model);
    const pricing = getPricingTag(model);

    // Build detail line: pricing tag | thinking badge | context length
    const detailParts = [
      pricing.badge,
      hasThinking ? '🧠 Thinking' : '',
      ctx ? `${ctx} ctx` : '',
    ].filter(Boolean);

    groups.get(key).push({
      label: isActive ? `$(check) ${name}` : `$(sparkle) ${name}`,
      description: isActive ? '• active' : '',
      detail: detailParts.join('   '),
      modelId: model.id,
      modelName: name,
      pricingTag: pricing.tag,
    });
  }

  // Build final ordered list
  const orderedKeys = [
    ...SECTION_ORDER.filter(k => groups.has(k)),
    ...[...groups.keys()].filter(k => !SECTION_ORDER.includes(k)).sort(),
  ];

  const items = [];
  for (const key of orderedKeys) {
    const sectionLabel = SECTION_LABELS[key] || `📦 ${key.toUpperCase()}`;
    items.push({ label: sectionLabel, kind: vscode.QuickPickItemKind.Separator });
    items.push(...groups.get(key));
  }
  return items;
}

// ─── Read/write settings ──────────────────────────────────────────────────────

function readCurrentModel(workspacePath) {
  // Prefer workspace local settings
  if (workspacePath) {
    try {
      const p = path.join(workspacePath, '.claude', 'settings.local.json');
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const m = j.model || j.env?.ANTHROPIC_MODEL;
        if (m) return m;
      }
    } catch {}
  }
  // Fall back to global
  try {
    const p = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return j.model || null;
    }
  } catch {}
  return null;
}

async function applyModel(modelId, workspacePath) {
  try {
    // ── Step 1: Write to shared state file (proxy.js reads this on every request) ──
    const stateDir = path.dirname(STATE_FILE);
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ model: modelId, updatedAt: new Date().toISOString() }, null, 2));

    // ── Step 2: Workspace .claude/settings.local.json ────────────────────────────
    if (workspacePath) {
      const dir  = path.join(workspacePath, '.claude');
      const file = path.join(dir, 'settings.local.json');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      let existing = {};
      if (fs.existsSync(file)) {
        try { existing = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
      }

      const merged = {
        $schema: existing.$schema || LOCAL_SETTINGS_SCHEMA,
        env: {
          ...(existing.env || {}),
          // Point Claude Code → standalone hot-swap proxy → OmniRoute
          ANTHROPIC_BASE_URL: PROXY_BASE_URL,
          ANTHROPIC_MODEL:    modelId,
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        },
        model: modelId,
      };

      // Preserve any other top-level keys (e.g. CLAUDE_CODE_AUTO_COMPACT_WINDOW)
      for (const k of Object.keys(existing)) {
        if (!(k in merged)) merged[k] = existing[k];
      }

      fs.writeFileSync(file, JSON.stringify(merged, null, 2));
    }

    // ── Step 3: Global ~/.claude/settings.json (model field only) ────────────────
    const globalPath = path.join(os.homedir(), '.claude', 'settings.json');
    let globalCfg = {};
    if (fs.existsSync(globalPath)) {
      try { globalCfg = JSON.parse(fs.readFileSync(globalPath, 'utf-8')); } catch {}
    }
    globalCfg.model = modelId;
    fs.writeFileSync(globalPath, JSON.stringify(globalCfg, null, 2));

    return true;
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to apply model: ${err.message}`);
    return false;
  }
}


// ─── Main command ─────────────────────────────────────────────────────────────

async function selectModel(forceRefresh = false) {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  const activeModel = readCurrentModel(workspacePath);

  // Read API key from local settings so we can probe
  let apiKey = '';
  try {
    const p = path.join(workspacePath || '', '.claude', 'settings.local.json');
    if (fs.existsSync(p)) {
      apiKey = JSON.parse(fs.readFileSync(p, 'utf-8'))?.env?.ANTHROPIC_API_KEY || '';
    }
  } catch {}

  // Create QuickPick and show immediately (with loading spinner)
  const qp = vscode.window.createQuickPick();
  qp.title = '🔀 Select Model — OmniRoute routes to best provider';
  qp.placeholder = 'Loading models from OmniRoute…';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.busy = true;
  qp.show();

  let models;
  try {
    models = await fetchOmniRouteModels(forceRefresh);
  } catch (err) {
    qp.hide();
    qp.dispose();
    vscode.window.showErrorMessage(
      `OmniRoute unavailable at ${OMNIROUTE_BASE_URL}: ${err.message}`
    );
    return;
  }

  const allItems = buildQuickPickItems(models, activeModel);
  qp.busy = false;
  qp.placeholder = `${models.length} models • probing health… (✅=OK ❌=Error ⏳=Slow)`;
  qp.items = allItems;

  // Pre-select the current active model
  if (activeModel) {
    const found = allItems.find(i => i.modelId === activeModel);
    if (found) qp.activeItems = [found];
  }

  qp.onDidAccept(async () => {
    const sel = qp.selectedItems[0];
    qp.hide();
    if (!sel?.modelId) return;

    const success = await applyModel(sel.modelId, workspacePath);
    if (success) {
      currentModelId = sel.modelId;
      updateStatusBar(sel.modelId, sel.modelName);

      const action = await vscode.window.showInformationMessage(
        `✅ Model: ${sel.modelName}   (OmniRoute will pick the best provider)`,
        'View settings.local.json'
      );
      if (action && workspacePath) {
        const p = path.join(workspacePath, '.claude', 'settings.local.json');
        vscode.window.showTextDocument(vscode.Uri.file(p));
      }
    }
  });

  qp.onDidHide(() => qp.dispose());
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function updateStatusBar(modelId, name) {
  if (!statusBarItem) return;
  // Short label: last meaningful segment
  const shortName = name || (modelId || 'No Model').split('/').pop();
  statusBarItem.text = `$(robot) ${shortName}`;
  statusBarItem.tooltip = [
    '🔀 OmniRoute Model Selector',
    `Model ID : ${modelId || 'none'}`,
    `Gateway  : ${OMNIROUTE_BASE_URL}`,
    `Proxy    : ${PROXY_BASE_URL}`,
    '',
    'Click to switch model mid-conversation!',
    'Your next prompt will instantly use',
    'the new model (no restart required).'
  ].join('\n');
}

// ─── Extension lifecycle ──────────────────────────────────────────────────────

function activate(context) {
  // Status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'claudeProfileSelector.selectProfile';
  context.subscriptions.push(statusBarItem);

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  currentModelId = readCurrentModel(workspacePath);

  // Ensure settings.local.json points to the hot-swap proxy (port 20130)
  if (currentModelId && workspacePath) {
    applyModel(currentModelId, workspacePath);
  }

  updateStatusBar(currentModelId, currentModelId ? displayName({ id: currentModelId, name: currentModelId }) : null);
  statusBarItem.show();

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProfileSelector.selectProfile',
      () => selectModel(false))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProfileSelector.refreshModels',
      () => { _modelCache = null; selectModel(true); })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProfileSelector.showCurrentProfile', () => {
      const m = readCurrentModel(workspacePath);
      if (m) {
        vscode.window.showInformationMessage(
          `Current model: ${m}\nProxy: ${PROXY_BASE_URL} → OmniRoute: ${OMNIROUTE_BASE_URL}`
        );
      } else {
        vscode.window.showInformationMessage('No model currently set.');
      }
    })
  );

  // Watch workspace local settings
  if (workspacePath) {
    const localDir = path.join(workspacePath, '.claude');
    if (fs.existsSync(localDir)) {
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(localDir), 'settings.local.json')
      );
      w.onDidChange(() => {
        currentModelId = readCurrentModel(workspacePath);
        updateStatusBar(currentModelId, currentModelId ? currentModelId.split('/').pop() : null);
      });
      context.subscriptions.push(w);
    }
  }

  console.log(`Claude Code Model Selector activated. Proxy: ${PROXY_BASE_URL} → ${OMNIROUTE_BASE_URL}`);
}

function deactivate() {}

module.exports = { activate, deactivate };
