// install.js – packages the extension as .vsix and installs it into VS Code / Antigravity IDE
// Run: node install.js

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXT_DIR = __dirname;
const EXT_NAME = 'claude-profile-selector';
const VSIX_FILE = path.join(EXT_DIR, `${EXT_NAME}.vsix`);

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  try {
    const result = execSync(cmd, { cwd: EXT_DIR, stdio: 'pipe', ...opts });
    return result?.toString() || '';
  } catch (e) {
    return e.stdout?.toString() || e.message;
  }
}

// Step 1: Install vsce if needed
console.log('\n📦 Checking for vsce (VS Code extension bundler)...');
const vscePath = run('npm list -g @vscode/vsce --depth=0 2>nul || echo missing');
const hasVsce = !vscePath.includes('missing') && !vscePath.includes('empty');

if (!hasVsce) {
  console.log('Installing @vscode/vsce globally...');
  run('npm install -g @vscode/vsce', { stdio: 'inherit' });
}

// Step 2: Package the extension
console.log('\n📦 Packaging extension...');
if (fs.existsSync(VSIX_FILE)) fs.unlinkSync(VSIX_FILE);

const packResult = run(`npx vsce package --no-dependencies --out ${EXT_NAME}.vsix`);
console.log(packResult);

if (!fs.existsSync(VSIX_FILE)) {
  console.error('❌ Packaging failed! Could not find .vsix file.');
  process.exit(1);
}

console.log(`✅ Packaged: ${VSIX_FILE}`);

// Step 3: Install into known VS Code / Antigravity IDE instances
const editors = [
  { name: 'Antigravity IDE', cmd: 'agide' },
  { name: 'VS Code', cmd: 'code' },
  { name: 'VS Code Insiders', cmd: 'code-insiders' },
  { name: 'Cursor', cmd: 'cursor' },
];

let installed = false;
for (const editor of editors) {
  const result = spawnSync(editor.cmd, ['--install-extension', VSIX_FILE, '--force'], {
    shell: true,
    encoding: 'utf-8',
  });
  if (result.status === 0) {
    console.log(`✅ Installed into ${editor.name}`);
    installed = true;
  } else if (result.stdout?.includes('installed')) {
    console.log(`✅ Installed into ${editor.name}`);
    installed = true;
  }
}

// Fallback: copy directly to extensions folder
if (!installed) {
  console.log('\n⚠️  Could not find a known editor CLI. Trying direct copy...');

  const candidateDirs = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
    path.join(process.env.APPDATA || '', 'Antigravity IDE', 'User', 'extensions'),
  ].filter(d => fs.existsSync(d));

  for (const extDir of candidateDirs) {
    const dest = path.join(extDir, EXT_NAME);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(EXT_DIR, 'package.json'), path.join(dest, 'package.json'));
    fs.copyFileSync(path.join(EXT_DIR, 'extension.js'), path.join(dest, 'extension.js'));
    console.log(`✅ Copied to: ${dest}`);
    installed = true;
  }
}

if (installed) {
  console.log('\n🎉 Done! Reload VS Code / Antigravity IDE to activate the extension.');
  console.log('   Look for the 🤖 robot icon in the bottom status bar.');
  console.log('   Or run command: "Claude: Select Profile"');
} else {
  console.log('\n⚠️  Please manually install the .vsix:');
  console.log(`   agide --install-extension "${VSIX_FILE}"`);
  console.log('   or drag & drop the .vsix into VS Code Extensions panel.');
}
