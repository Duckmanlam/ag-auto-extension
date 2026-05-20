// ===========================================================
// AG Auto Click & Scroll — VS Code Extension
// ===========================================================
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const buildSettingsHtmlV85 = require('./settingsWebviewHtml');

// Tag markers để tìm và xoá script đã inject
const TAG_START = '<!-- AG-AUTO-CLICK-SCROLL-START -->';
const TAG_END = '<!-- AG-AUTO-CLICK-SCROLL-END -->';

/**
 * Ghi file với auto-elevation trên Linux/macOS khi gặp EACCES
 * - Linux: dùng pkexec (native password dialog)
 * - macOS: dùng osascript (native password dialog)
 * - Windows: throw lại lỗi (user cần Run as Admin)
 */
function writeFileElevated(filePath, content) {
    try {
        fs.writeFileSync(filePath, content, 'utf8');
    } catch (err) {
        if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;

        const tmpPath = path.join(os.tmpdir(), 'ag-auto-' + Date.now() + '.tmp');
        fs.writeFileSync(tmpPath, content, 'utf8');

        try {
            if (process.platform === 'linux') {
                // pkexec shows native Linux password dialog
                execSync(`pkexec bash -c "cp '${tmpPath}' '${filePath}' && chmod 644 '${filePath}'"`, { timeout: 30000 });
                console.log('[AG Auto] ✅ Elevated write (pkexec) →', path.basename(filePath));
            } else if (process.platform === 'darwin') {
                // macOS: osascript shows native password dialog
                const cmd = `cp '${tmpPath}' '${filePath}' && chmod 644 '${filePath}'`;
                execSync(`osascript -e 'do shell script "${cmd}" with administrator privileges'`, { timeout: 30000 });
                console.log('[AG Auto] ✅ Elevated write (osascript) →', path.basename(filePath));
            } else {
                // Windows: throw original error
                throw err;
            }
        } catch (elevErr) {
            try { fs.unlinkSync(tmpPath); } catch (_) { }
            if (elevErr === err) throw err;
            console.error('[AG Auto] Elevation failed:', elevErr.message);
            throw new Error(`Permission denied. Trên Linux, hãy thử: sudo chmod -R a+w "${path.dirname(filePath)}"`);
        }

        try { fs.unlinkSync(tmpPath); } catch (_) { }
    }
}

/**
 * Tìm file workbench.html của VS Code
 */
function getWorkbenchPath() {
    const appRoot = vscode.env.appRoot;
    console.log('[AG Auto] appRoot:', appRoot);

    // Thử nhiều đường dẫn phổ biến (VS Code + Antigravity)
    const candidates = [
        path.join(appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'code', 'electron-main', 'workbench', 'workbench.html'),
    ];
    for (const p of candidates) {
        console.log('[AG Auto] Thử:', p, '->', fs.existsSync(p) ? 'TÌM THẤY!' : 'không có');
        if (fs.existsSync(p)) return p;
    }
    // Fallback: tìm bằng đệ quy với depth lớn hơn
    console.log('[AG Auto] Không tìm thấy trong candidates, thử tìm đệ quy...');
    const outDir = path.join(appRoot, 'out');
    const found = findFileRecursive(outDir, 'workbench.html', 6);
    console.log('[AG Auto] Kết quả tìm đệ quy:', found || 'KHÔNG TÌM THẤY');
    return found;
}

/**
 * Tìm file đệ quy với giới hạn depth
 */
function findFileRecursive(dir, filename, maxDepth) {
    if (maxDepth <= 0) return null;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name === filename) return fullPath;
            if (entry.isDirectory()) {
                const result = findFileRecursive(fullPath, filename, maxDepth - 1);
                if (result) return result;
            }
        }
    } catch (_) { }
    return null;
}

function getDisabledClickPatterns(context) {
    if (!context || !context.globalState) return [];
    const disabled = context.globalState.get('disabledClickPatterns', []);
    return Array.isArray(disabled) ? disabled : [];
}

function canonicalPatternName(pattern) {
    if (pattern === 'Allow This Conversation') return 'Allow This Con';
    if (pattern === 'Allow This Conversion') return null;
    return pattern;
}

function normalizePatternList(patterns) {
    if (!Array.isArray(patterns)) return [];
    const normalized = [];
    const seen = new Set();
    patterns.forEach(pattern => {
        const canonical = canonicalPatternName(pattern);
        if (!canonical || seen.has(canonical)) return;
        seen.add(canonical);
        normalized.push(canonical);
    });
    return normalized;
}

function resolveClickPatternState(context, configuredPatterns, options = {}) {
    const defaultPatterns = ['Run', 'Allow', 'Accept', 'Always Allow', 'Keep Waiting', 'Retry', 'Allow Once', 'Allow This Con', 'Allow in Workspace', 'Accept all', 'Approve', 'Always Approve', 'Approve Once', 'Allow Session'];
    const defaultOff = ['Accept all'];
    const disabledPats = normalizePatternList(getDisabledClickPatterns(context));
    const mergedPatterns = normalizePatternList(configuredPatterns);

    if (options.mergeDefaults) {
        defaultPatterns.forEach(p => {
            if (!mergedPatterns.includes(p) && !disabledPats.includes(p) && !defaultOff.includes(p)) {
                mergedPatterns.push(p);
            }
        });
    }

    const activePatterns = mergedPatterns.filter(p => !disabledPats.includes(p));
    return {
        disabledPats,
        mergedPatterns,
        activePatterns,
        acceptEnabled: activePatterns.includes('Accept'),
        safePatterns: activePatterns.filter(p => p !== 'Accept')
    };
}



// Cache HTML settings để không phải render lại mỗi lần mở
let _cachedSettingsHtml = null;
let _cachedSettingsKey = '';

function buildSettingsCacheKey(context, config, languageOverride) {
    const lang = languageOverride || config.get('language', 'vi');
    const patterns = JSON.stringify(context.globalState.get('disabledClickPatterns', []));
    return `${_autoAcceptEnabled}|${_httpScrollEnabled}|${lang}|${config.get('clickIntervalMs',1000)}|${config.get('scrollPauseMs',7000)}|${config.get('scrollIntervalMs',500)}|${patterns}|${_actualPort}|${isScriptInjected()}`;
}

async function renderSettingsPanel(panel, context, assets = {}, languageOverride) {
    const config = vscode.workspace.getConfiguration('ag-auto');
    const cacheKey = buildSettingsCacheKey(context, config, languageOverride);
    if (!_cachedSettingsHtml || _cachedSettingsKey !== cacheKey) {
        const configuredPatterns = config.get('clickPatterns', ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept', 'Approve', 'Always Approve', 'Approve Once', 'Allow Session']);
        const patternState = resolveClickPatternState(context, configuredPatterns, { mergeDefaults: true });
        _cachedSettingsHtml = buildSettingsHtmlV85({
            enabled: _autoAcceptEnabled,
            scrollEnabled: _httpScrollEnabled,
            scrollPauseMs: config.get('scrollPauseMs', 7000),
            scrollIntervalMs: config.get('scrollIntervalMs', 500),
            clickIntervalMs: config.get('clickIntervalMs', 1000),
            clickPatterns: patternState.mergedPatterns,
            disabledClickPatterns: patternState.disabledPats,
            clickLimits: context.globalState.get('clickLimits', {}),
            language: languageOverride || config.get('language', 'vi'),
            clickStats: _clickStats,
            totalClicks: _totalClicks,
            version: context.extension?.packageJSON?.version || '0.0.0',
            serverPort: _actualPort || 0,
            scriptInjected: isScriptInjected(),
            serverStartedAt: _serverStartedAt || Date.now()
        });
        _cachedSettingsKey = cacheKey;
    }
    panel.webview.html = _cachedSettingsHtml;
}


/**
 * Đọc config từ VS Code settings và tạo nội dung script
 */
function buildScriptContent(context) {
    const config = vscode.workspace.getConfiguration('ag-auto');
    const pauseMs = config.get('scrollPauseMs', 7000);
    const scrollMs = config.get('scrollIntervalMs', 500);
    const clickMs = config.get('clickIntervalMs', 1000);
    const allPatterns = config.get('clickPatterns', ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept all', 'Accept', 'Approve', 'Always Approve', 'Approve Once', 'Allow Session']);
    const patternState = resolveClickPatternState(context, allPatterns);
    const patterns = patternState.safePatterns;
    const enabled = context.globalState.get('startupEnabledPreference', true);

    // Read template script
    const templatePath = path.join(context.extensionPath, 'media', 'autoScript.js');
    let script = fs.readFileSync(templatePath, 'utf8');

    // Config path for live reload (use forward slashes for Electron)
    const wbPath = getWorkbenchPath();
    const configFilePath = wbPath ? path.join(path.dirname(wbPath), 'ag-auto-config.json').replace(/\\/g, '/') : '';
    // Replace placeholders with actual config values
    script = script.replace(/\/\*\{\{PAUSE_SCROLL_MS\}\}\*\/\d+/, pauseMs.toString());
    script = script.replace(/\/\*\{\{SCROLL_INTERVAL_MS\}\}\*\/\d+/, scrollMs.toString());
    script = script.replace(/\/\*\{\{CLICK_INTERVAL_MS\}\}\*\/\d+/, clickMs.toString());
    script = script.replace(
        /\/\*\{\{CLICK_PATTERNS\}\}\*\/\[.*?\]/,
        JSON.stringify(patterns)
    );
    script = script.replace(/\/\*\{\{ENABLED\}\}\*\/\w+/, enabled.toString());
    script = script.replace(/\/\*\{\{CONFIG_PATH\}\}\*\//, configFilePath);
    script = script.replace(/\/\*\{\{WORKBENCH_DIR\}\}\*\/""/, JSON.stringify(wbPath ? path.dirname(wbPath).replace(/\\/g, '/') : ''));

    return script;
}

/**
 * Ghi config JSON ra file để script inject reload realtime (không cần restart)
 */
function writeConfigJson(context) {
    try {
        const wbPath = getWorkbenchPath();
        if (!wbPath) return;
        const wbDir = path.dirname(wbPath);
        const config = vscode.workspace.getConfiguration('ag-auto');
        const allPatterns = config.get('clickPatterns', ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept', 'Approve', 'Always Approve', 'Approve Once', 'Allow Session']);
        const patternState = resolveClickPatternState(context, allPatterns);
        const enabled = _autoAcceptEnabled;
        const configData = JSON.stringify({
            enabled: enabled,
            scrollEnabled: _httpScrollEnabled,
            clickPatterns: patternState.safePatterns,
            acceptInChatOnly: patternState.acceptEnabled,
            pauseScrollMs: config.get('scrollPauseMs', 7000),
            scrollIntervalMs: config.get('scrollIntervalMs', 500),
            clickIntervalMs: config.get('clickIntervalMs', 1000),
            clickLimits: context.globalState.get('clickLimits', {})
        });
        const configPath = path.join(wbDir, 'ag-auto-config.json');
        writeFileElevated(configPath, configData);
        console.log('[AG Auto] Config JSON updated:', configData);
    } catch (e) {
        console.error('[AG Auto] Error writing config JSON:', e.message);
    }
}


function injectIntoWorkbenchHtml(html, injection) {
    if (/<\/body>/i.test(html)) {
        return html.replace(/<\/body>/i, injection + '\n</body>');
    }
    if (/<\/html>/i.test(html)) {
        return html.replace(/<\/html>/i, injection + '\n</html>');
    }
    return html + '\n' + injection + '\n';
}

function hasValidHtmlInjection(html) {
    return html.includes(TAG_START) &&
        html.includes(TAG_END) &&
        /<script[^>]+src=["'][^"']*ag-auto-script\.js(?:\?[^"']*)?["'][^>]*>/i.test(html);
}

/**
 * Inject script vào workbench — thử nhiều cách để tương thích mọi phiên bản
 */
function installScript(context) {
    console.log('[AG Auto] installScript() đang chạy...');
    const wbPath = getWorkbenchPath();
    if (!wbPath) {
        console.error('[AG Auto] KHÔNG TÌM THẤY workbench.html!');
        vscode.window.showErrorMessage('[AG Auto] Không tìm thấy workbench.html! Hãy kiểm tra cài đặt VS Code.');
        return false;
    }
    console.log('[AG Auto] Tìm thấy workbench.html tại:', wbPath);

    const wbDir = path.dirname(wbPath);
    const scriptContent = buildScriptContent(context);

    // ===== Step 1: CLEANUP old JS injection from workbench.js (don't add anything new) =====
    const JS_TAG_START = '/* AG-AUTO-CLICK-SCROLL-JS-START */';
    const JS_TAG_END = '/* AG-AUTO-CLICK-SCROLL-JS-END */';

    try {
        // Find JS files and remove old injected code
        const htmlContent = fs.readFileSync(wbPath, 'utf8');
        const scriptMatches = htmlContent.match(/src="([^"]*\.js)"/g) || [];
        const jsFiles = new Set();

        for (const match of scriptMatches) {
            const srcMatch = match.match(/src="([^"]*\.js)"/);
            if (srcMatch) {
                const jsName = path.basename(srcMatch[1].split('?')[0]);
                if (jsName === 'ag-auto-script.js') continue; // Skip our own script
                const sameDirPath = path.join(wbDir, jsName);
                if (fs.existsSync(sameDirPath)) jsFiles.add(sameDirPath);
                const parent1 = path.join(wbDir, '..', jsName);
                if (fs.existsSync(parent1)) jsFiles.add(path.resolve(parent1));
                const parent2 = path.join(wbDir, '..', '..', jsName);
                if (fs.existsSync(parent2)) jsFiles.add(path.resolve(parent2));
            }
        }

        // Fallback: also check workbench.desktop.main.js
        if (jsFiles.size === 0) {
            const fallbackNames = ['workbench.desktop.main.js', 'workbench.js'];
            for (const name of fallbackNames) {
                const found = findFileRecursive(path.join(wbDir, '..'), name, 3);
                if (found) { jsFiles.add(found); break; }
            }
        }

        for (const jsPath of jsFiles) {
            let jsContent = fs.readFileSync(jsPath, 'utf8');
            const jsRegex = new RegExp(`${escapeRegex(JS_TAG_START)}[\\s\\S]*?${escapeRegex(JS_TAG_END)}`, 'g');
            if (jsRegex.test(jsContent)) {
                jsContent = jsContent.replace(jsRegex, '');
                writeFileElevated(jsPath, jsContent);
                console.log('[AG Auto] 🧹 Cleaned old inject from', path.basename(jsPath));
            }
        }
    } catch (err) {
        console.error('[AG Auto] Lá»—i cleanup JS:', err.message);
    }

    // ===== Step 2: Write ag-auto-script.js + inject HTML <script> tag =====
    try {
        let html = fs.readFileSync(wbPath, 'utf8');
        const htmlRegex = new RegExp(`${escapeRegex(TAG_START)}[\\s\\S]*?${escapeRegex(TAG_END)}`, 'g');
        html = html.replace(htmlRegex, '');

        const ts = Date.now();

        // Write fresh script file
        const destPath = path.join(wbDir, 'ag-auto-script.js');
        writeFileElevated(destPath, scriptContent);

        // Add <script> tag to HTML. Prefer </body>, then </html>, then append.
        const injection = `\n${TAG_START}\n<script src="ag-auto-script.js?v=${ts}"></script>\n${TAG_END}`;
        html = injectIntoWorkbenchHtml(html, injection);

        if (!hasValidHtmlInjection(html)) {
            throw new Error('HTML injection marker/script verification failed');
        }

        writeFileElevated(wbPath, html);
        console.log('[AG Auto] ✅ HTML inject + fresh ag-auto-script.js (v=' + ts + ')');
    } catch (err) {
        console.error('[AG Auto] Lỗi inject vào HTML:', err.message);
        return false;
    }

    return true;
}

/**
 * Cập nhật checksums trong product.json sau khi inject/uninstall
 * để tránh lỗi "Your Antigravity installation appears to be corrupt"
 */
function updateProductChecksums() {
    try {
        // Tìm product.json qua nhiều cách
        let productJsonPath = null;

        // Cách 1: process.resourcesPath (nhanh nhất)
        if (process.resourcesPath) {
            const candidate = path.join(process.resourcesPath, 'app', 'product.json');
            if (fs.existsSync(candidate)) productJsonPath = candidate;
        }

        // Cách 2: Từ workbench path đi lên
        if (!productJsonPath) {
            const wbPath = getWorkbenchPath();
            if (!wbPath) return;
            let searchDir = path.dirname(wbPath);
            for (let i = 0; i < 8; i++) {
                const candidate = path.join(searchDir, 'product.json');
                if (fs.existsSync(candidate)) {
                    productJsonPath = candidate;
                    break;
                }
                searchDir = path.dirname(searchDir);
            }
        }

        if (!productJsonPath) {
            console.log('[AG Auto] product.json không tìm thấy, bỏ qua checksum update');
            return;
        }

        console.log('[AG Auto] Tìm thấy product.json:', productJsonPath);
        const productJson = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));

        if (!productJson.checksums) {
            console.log('[AG Auto] product.json không có trường checksums, bỏ qua');
            return;
        }
        // product.json ở resources/app/ nhưng files ở resources/app/out/
        const appRoot = path.dirname(productJsonPath);
        const outDir = path.join(appRoot, 'out');
        let updated = false;

        // Recalculate checksums cho tất cả files trong product.json
        for (const relativePath in productJson.checksums) {
            // relativePath dùng forward slashes (e.g. "vs/workbench/workbench.desktop.main.js")
            // Trên Windows cần convert thành native path separator
            const nativePath = relativePath.split('/').join(path.sep);
            // Thử tìm file ở out/ trước, nếu ko có thì thử appRoot trực tiếp
            let filePath = path.join(outDir, nativePath);
            if (!fs.existsSync(filePath)) filePath = path.join(appRoot, nativePath);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath);
                const hash = crypto.createHash('sha256').update(content).digest('base64').replace(/=+$/, '');
                const oldHash = productJson.checksums[relativePath];
                if (oldHash !== hash) {
                    productJson.checksums[relativePath] = hash;
                    updated = true;
                    console.log('[AG Auto] Checksum updated:', relativePath, '(old:', oldHash.substring(0, 10) + '...', 'new:', hash.substring(0, 10) + '...)');
                }
            }
        }

        if (updated) {
            writeFileElevated(productJsonPath, JSON.stringify(productJson, null, '\t'));
            console.log('[AG Auto] ✅ product.json checksums đã cập nhật!');
        } else {
            console.log('[AG Auto] Checksums đã đúng, không cần update');
        }
        return updated;
    } catch (e) {
        console.error('[AG Auto] Lá»—i update checksums:', e.message);
        return false;
    }
}

/**
 * Clear V8 bytecode code cache to force Electron to recompile JS from disk
 * Without this, Electron reuses cached bytecode and ignores file changes
 */
function clearV8CodeCache() {
    try {
        const appDataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const codeCacheDir = path.join(appDataDir, 'Antigravity', 'Code Cache', 'js');
        if (fs.existsSync(codeCacheDir)) {
            fs.rmSync(codeCacheDir, { recursive: true, force: true });
            console.log('[AG Auto] Cleared V8 code cache:', codeCacheDir);
        } else {
            console.log('[AG Auto] V8 code cache dir not found:', codeCacheDir);
        }
    } catch (e) {
        console.log('[AG Auto] Could not clear code cache:', e.message);
    }
}

/**
 * Gỡ script khỏi workbench.html
 */
function uninstallScript() {
    const wbPath = getWorkbenchPath();
    if (!wbPath) return false;

    const wbDir = path.dirname(wbPath);
    const JS_TAG_START = '/* AG-AUTO-CLICK-SCROLL-JS-START */';
    const JS_TAG_END = '/* AG-AUTO-CLICK-SCROLL-JS-END */';

    try {
        // Xoá từ workbench.html
        let html = fs.readFileSync(wbPath, 'utf8');
        const htmlRegex = new RegExp(`${escapeRegex(TAG_START)}[\\s\\S]*?${escapeRegex(TAG_END)}`, 'g');
        html = html.replace(htmlRegex, '');
        writeFileElevated(wbPath, html);

        // Xoá file script và file phụ do AG Auto tạo
        const scriptPath = path.join(wbDir, 'ag-auto-script.js');
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);

        const sidecarFiles = [
            'ag-auto-config.json',
            'ag-auto-window-bindings.json',
            'ag-auto-ports.json'
        ];
        for (const fileName of sidecarFiles) {
            const p = path.join(wbDir, fileName);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        for (const entry of fs.readdirSync(wbDir)) {
            if (/^ag-auto-port-\d+\.txt$/.test(entry)) {
                fs.unlinkSync(path.join(wbDir, entry));
            }
        }

        // Xoá từ workbench.desktop.main.js
        const mainJsCandidates = ['workbench.desktop.main.js', 'workbench.js'];
        for (const name of mainJsCandidates) {
            const p = path.join(wbDir, name);
            if (fs.existsSync(p)) {
                let js = fs.readFileSync(p, 'utf8');
                const jsRegex = new RegExp(`${escapeRegex(JS_TAG_START)}[\\s\\S]*?${escapeRegex(JS_TAG_END)}`, 'g');
                js = js.replace(jsRegex, '');
                writeFileElevated(p, js);
            }
        }

        return true;
    } catch (err) {
        vscode.window.showErrorMessage(`[AG Auto] Không thể gỡ bỏ cấu hình do thiếu quyền Administrator. Vui lòng mở lại VS Code dưới quyền Admin! Chi tiết: ${err.message}`);
        return false;
    }
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let _httpServer = null;
let _actualPort = 0;
let _settingsPanel = null;
const AG_HTTP_PORT_START = 48787;
const AG_HTTP_PORT_END = 48850;
let _settingsOpenRequestedThisSession = false;
let _lastSettingsOpenAt = 0;
const SETTINGS_OPEN_GUARD_MS = 5000;
const SETTINGS_PANEL_TITLE = 'Duckmanlam Auto VIP - Settings';
const SETTINGS_PANEL_VIEW_TYPE = 'agAutoSettingsManualOnly';
const LEGACY_SETTINGS_PANEL_VIEW_TYPES = ['agAutoSettings', 'agAutoSettingsManual', SETTINGS_PANEL_VIEW_TYPE];
const SUPPRESS_SETTINGS_RESTORE_KEY = 'agSuppressSettingsRestoreUntil';

function settingsPanelRecentlyOpened() {
    return _lastSettingsOpenAt > 0 && (Date.now() - _lastSettingsOpenAt) < SETTINGS_OPEN_GUARD_MS;
}

function suppressSettingsRestoreForNextStartup(context, ttlMs = 45000) {
    if (!context || !context.globalState) return Promise.resolve();
    return context.globalState.update(SUPPRESS_SETTINGS_RESTORE_KEY, Date.now() + Math.max(5000, ttlMs));
}



function isAgSettingsTab(tab) {
    if (!tab) return false;
    // Check by viewType (most reliable)
    const isAgSettingsView = tab.input && LEGACY_SETTINGS_PANEL_VIEW_TYPES.includes(tab.input.viewType);
    // Check by EXACT label match only — avoid matching the Extension detail tab
    const label = typeof tab.label === 'string' ? tab.label : '';
    const isAgSettingsLabel = label === SETTINGS_PANEL_TITLE;
    // Check restored webview viewType containing our prefix
    const isRestoredWebview = tab.input && tab.input.viewType && (
        typeof tab.input.viewType === 'string' && (
            tab.input.viewType.indexOf('agAuto') !== -1 ||
            tab.input.viewType.indexOf('ag-auto') !== -1
        )
    );
    return !!(isAgSettingsView || isAgSettingsLabel || isRestoredWebview);
}

/**
 * Mở Webview Settings Panel — chỉ mở khi user chủ động yêu cầu
 */
async function openSettingsPanel(context, options = {}) {
    _settingsOpenRequestedThisSession = true;
    _lastSettingsOpenAt = Date.now();

    if (_settingsPanel) {
        const existingPanel = _settingsPanel;
        if (typeof existingPanel.visible === 'boolean') {
            if (existingPanel.visible) {
                existingPanel.dispose();
                _settingsPanel = null;
                return;
            }
        } else {
            try {
                existingPanel.reveal(vscode.ViewColumn.One);
                return;
            } catch (e) {
                console.log('[AG Auto] Stale settings panel reference detected, recreating panel:', e.message);
                _settingsPanel = null;
            }
        }
    }

    const panel = vscode.window.createWebviewPanel(
        SETTINGS_PANEL_VIEW_TYPE,
        SETTINGS_PANEL_TITLE,
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
        }
    );
    _settingsPanel = panel;

    // Clear reference when panel is closed
    panel.onDidDispose(() => {
        if (_settingsPanel === panel) {
            _settingsPanel = null;
        }
        if (!settingsPanelRecentlyOpened()) {
            _settingsOpenRequestedThisSession = false;
        }
    });

    renderSettingsPanel(panel, context).catch(error => {
        console.error('[AG Auto] Failed to render settings panel:', error.message);
        panel.webview.html = buildSettingsHtmlV85({
            enabled: true, scrollEnabled: true, scrollPauseMs: 7000, scrollIntervalMs: 500,
            clickIntervalMs: 1000, clickPatterns: ['Allow','Always Allow','Run','Keep Waiting','Accept','Approve','Always Approve','Approve Once','Allow Session'],
            disabledClickPatterns: [], language: 'vi', clickStats: _clickStats, totalClicks: _totalClicks,
            version: context.extension?.packageJSON?.version || '0.0.0',
            serverPort: _actualPort || 0, scriptInjected: isScriptInjected(),
            serverStartedAt: _serverStartedAt || Date.now()
        });
    });

    // Nhận message từ Webview
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'changeLang') {
            const cfg = vscode.workspace.getConfiguration('ag-auto');
            await cfg.update('language', msg.lang, vscode.ConfigurationTarget.Global);
            await renderSettingsPanel(panel, context, {}, msg.lang);
            return;
        }
        if (msg.command === 'toggle') {
            _autoAcceptEnabled = msg.enabled;
            await context.globalState.update('startupEnabledPreference', _autoAcceptEnabled);
            writeConfigJson(context);
            if (_autoAcceptEnabled && (!_httpServer || _actualPort <= 0)) {
                console.log('[AG Auto] Toggle ON requested while HTTP server is not listening — starting IPC server now');
                startHttpServer();
            }
            updateStatusBarItem();
            console.log('[AG Auto] INSTANT toggle: ' + (_autoAcceptEnabled ? 'ON ✅' : 'OFF 🛑') + ' (window-local)');
            return;
        }
        if (msg.command === 'scrollToggle') {
            _httpScrollEnabled = msg.enabled;
            await context.globalState.update('scrollEnabledPreference', _httpScrollEnabled);
            writeConfigJson(context);
            updateStatusBarItem();
            console.log('[AG Auto] INSTANT scroll toggle: ' + (_httpScrollEnabled ? 'ON ✅' : 'OFF 🛑') + ' (persisted)');
            return;
        }
        if (msg.command === 'save') {
            console.log('[AG Auto] Nhận lệnh SAVE từ Webview, data:', JSON.stringify(msg.data));
            _autoAcceptEnabled = msg.data.enabled;
            _httpClickPatterns = msg.data.clickPatterns.filter(p => !msg.data.disabledClickPatterns.includes(p));
            _httpScrollConfig = {
                pauseScrollMs: msg.data.scrollPauseMs || 5000,
                scrollIntervalMs: msg.data.scrollIntervalMs || 500,
                clickIntervalMs: msg.data.clickIntervalMs || 2000
            };
            await context.globalState.update('disabledClickPatterns', msg.data.disabledClickPatterns);
            await context.globalState.update('clickLimits', msg.data.clickLimits || {});
            await context.globalState.update('startupEnabledPreference', _autoAcceptEnabled);
            await context.globalState.update('scrollEnabledPreference', _httpScrollEnabled);
            try {
                const cfg = vscode.workspace.getConfiguration('ag-auto');
                await cfg.update('clickPatterns', msg.data.clickPatterns, vscode.ConfigurationTarget.Global);
                await cfg.update('clickIntervalMs', msg.data.clickIntervalMs || 2000, vscode.ConfigurationTarget.Global);
                await cfg.update('scrollPauseMs', msg.data.scrollPauseMs || 5000, vscode.ConfigurationTarget.Global);
                await cfg.update('scrollIntervalMs', msg.data.scrollIntervalMs || 500, vscode.ConfigurationTarget.Global);
                await cfg.update('language', msg.data.language, vscode.ConfigurationTarget.Global);
            } catch (e) {
                console.log('[AG Auto] Language/config update failed, storing in globalState:', e.message);
                await context.globalState.update('language', msg.data.language);
                await context.globalState.update('clickPatterns', msg.data.clickPatterns);
            }
            console.log('[AG Auto] HTTP state updated — patterns:', _httpClickPatterns.length, 'scroll:', JSON.stringify(_httpScrollConfig), 'enabled:', _autoAcceptEnabled, '(window-local)');

            writeConfigJson(context);
            updateStatusBarItem();
            startCommandsLoop();

            const updatedLang = msg.data.language;
            let savedMsg = '$(check) [AG Auto] Saved!';
            if (updatedLang === 'en') savedMsg = '$(check) [AG Auto] Saved!';
            if (updatedLang === 'zh') savedMsg = '$(check) [AG Auto] Saved!';
            vscode.window.setStatusBarMessage(savedMsg, 3000);
            return;
        }
        if (msg.command === 'reload') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
            return;
        }
        if (msg.command === 'resetStats') {
            _clickStats = {};
            _totalClicks = 0;
            _resetStatsRequested = true;
            // Clear persisted stats
            context.globalState.update('clickStats', {});
            context.globalState.update('totalClicks', 0);
            panel.webview.postMessage({ command: 'statsUpdated', clickStats: {}, totalClicks: 0 });
            return;
        }
        if (msg.command === 'clearClickLog') {
            _clickLog = [];
            if (_extensionContext) _extensionContext.globalState.update('clickLog', []);
            panel.webview.postMessage({ command: 'clickLogUpdate', log: [] });
            return;
        }
        if (msg.command === 'getClickLog') {
            panel.webview.postMessage({ command: 'clickLogUpdate', log: _clickLog });
            return;
        }
        if (msg.command === 'getStats') {
            panel.webview.postMessage({ command: 'statsUpdated', clickStats: _clickStats, totalClicks: _totalClicks });
        }
    }, undefined, context.subscriptions);

    // Auto-refresh stats every 2s while panel is open
    const statsTimer = setInterval(() => {
        try {
            panel.webview.postMessage({ command: 'statsUpdated', clickStats: _clickStats, totalClicks: _totalClicks });
        } catch (e) { clearInterval(statsTimer); }
    }, 2000);
    panel.onDidDispose(() => clearInterval(statsTimer));
}

function registerUnexpectedSettingsTabGuard(context) {
    const scheduleCleanup = (delayMs) => {
        const timer = setTimeout(() => {
            closeUnexpectedSettingsTabs();
        }, delayMs);
        context.subscriptions.push({ dispose: () => clearTimeout(timer) });
    };

    [50, 250, 1000, 2500, 5000, 9000].forEach(scheduleCleanup);

    if (!vscode.window.tabGroups || typeof vscode.window.tabGroups.onDidChangeTabs !== 'function') return;

    let pendingCleanupTimer = null;
    const clearPendingCleanup = () => {
        if (pendingCleanupTimer) {
            clearTimeout(pendingCleanupTimer);
            pendingCleanupTimer = null;
        }
    };

    context.subscriptions.push({ dispose: clearPendingCleanup });
    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(() => {
            if (_settingsOpenRequestedThisSession) return;
            clearPendingCleanup();
            pendingCleanupTimer = setTimeout(() => {
                pendingCleanupTimer = null;
                closeUnexpectedSettingsTabs();
            }, 50);
        })
    );
}

// =============================================================
// STATUS BAR
// =============================================================
let statusBarItem;
let statusBarScroll;

function createStatusBarItem(context) {
    // Accept item (far right, higher priority = more left)
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10000);
    statusBarItem.command = 'ag-auto.openSettings';
    context.subscriptions.push(statusBarItem);

    // Scroll item (far right, next to Accept)
    statusBarScroll = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -10001);
    statusBarScroll.command = 'ag-auto.openSettings';
    context.subscriptions.push(statusBarScroll);

    updateStatusBarItem();
    statusBarItem.show();
    statusBarScroll.show();
}

function updateStatusBarItem() {
    if (!statusBarItem || !statusBarScroll) return;
    // Use in-memory vars (instant) instead of config (may lag)
    const acceptOn = _autoAcceptEnabled;
    const scrollOn = _httpScrollEnabled;
    const acceptDegraded = !!_runtimeHealth.acceptDegraded;
    const scrollDegraded = !!_runtimeHealth.scrollDegraded;
    const runtimeReason = _runtimeHealth.reason || 'runtime-desync';
    const runtimeDetail = _runtimeHealth.detail ? ('\nDetail: ' + _runtimeHealth.detail) : '';

    // Accept item
    if (acceptOn && !acceptDegraded) {
        statusBarItem.text = '$(check) Accept ON';
        statusBarItem.color = '#4EC9B0';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.tooltip = 'Auto Accept: ON\nClick to open Settings';
    } else if (acceptOn && acceptDegraded) {
        statusBarItem.text = '$(warning) Accept DEGRADED';
        statusBarItem.color = '#FFCC66';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarItem.tooltip = 'Auto Accept: DEGRADED\nConfigured state is ON, but the injected runtime reported a temporary failure (' + runtimeReason + ').\nReload Window or restart Antigravity if it does not recover automatically.' + runtimeDetail;
    } else {
        statusBarItem.text = '$(circle-slash) Accept OFF';
        statusBarItem.color = '#F44747';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        statusBarItem.tooltip = 'Auto Accept: OFF\nClick to open Settings';
    }

    // Scroll item
    if (scrollOn && !scrollDegraded) {
        statusBarScroll.text = '$(check) Scroll ON';
        statusBarScroll.color = '#4EC9B0';
        statusBarScroll.backgroundColor = undefined;
        statusBarScroll.tooltip = 'Auto Scroll: ON\nClick to open Settings';
    } else if (scrollOn && scrollDegraded) {
        statusBarScroll.text = '$(warning) Scroll DEGRADED';
        statusBarScroll.color = '#FFCC66';
        statusBarScroll.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarScroll.tooltip = 'Auto Scroll: DEGRADED\nConfigured state is ON, but the injected runtime reported a temporary failure (' + runtimeReason + ').\nReload Window or restart Antigravity if it does not recover automatically.' + runtimeDetail;
    } else {
        statusBarScroll.text = '$(circle-slash) Scroll OFF';
        statusBarScroll.color = '#F44747';
        statusBarScroll.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        statusBarScroll.tooltip = 'Auto Scroll: OFF\nClick to open Settings';
    }
}

async function closeUnexpectedSettingsTabs(options = {}) {
    if ((_settingsOpenRequestedThisSession || settingsPanelRecentlyOpened()) && !options.force) return;
    if (settingsPanelRecentlyOpened()) {
        console.log('[AG Auto] Skip restore suppression: settings were just opened intentionally');
        return;
    }
    let closedAny = false;

    if (_settingsPanel) {
        try {
            _settingsPanel.dispose();
            closedAny = true;
        } catch (e) {
            console.log('[AG Auto] Could not dispose stray settings panel:', e.message);
        } finally {
            _settingsPanel = null;
        }
    }



    const activeTab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup
        ? vscode.window.tabGroups.activeTabGroup.activeTab
        : null;
    if (isAgSettingsTab(activeTab)) {
        try {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            closedAny = true;
        } catch (e) {
            console.log('[AG Auto] Could not close active restored settings editor:', e.message);
        }
    }

    if (!vscode.window.tabGroups || typeof vscode.window.tabGroups.close !== 'function') {
        return;
    }

    try {
        const tabsToClose = [];
        for (const group of vscode.window.tabGroups.all || []) {
            for (const tab of group.tabs || []) {
                if (isAgSettingsTab(tab)) {
                    tabsToClose.push(tab);
                }
            }
        }

        if (tabsToClose.length > 0) {
            await vscode.window.tabGroups.close(tabsToClose, true);
            closedAny = true;
            console.log('[AG Auto] Closed restored settings tab(s):', tabsToClose.length);
        }
    } catch (e) {
        console.log('[AG Auto] Could not close restored settings tab:', e.message);
    }

    if (closedAny) {
        console.log('[AG Auto] Suppressed unexpected settings panel restore');
    }
}

// =============================================================
// HTTP MICRO-SERVER for IPC with injected workbench script
// The injected script polls http://127.0.0.1:48787/ag-status
// Extension Host controls _autoAcceptEnabled, server returns it
// =============================================================
const http = require('http');
let _autoAcceptEnabled = true;
let _httpScrollEnabled = true;
let _httpClickPatterns = [];
let _httpScrollConfig = { pauseScrollMs: 5000, scrollIntervalMs: 500, clickIntervalMs: 2000 };
let _clickStats = {};
let _clickLog = []; // In-memory click log (last 200)
let _totalClicks = 0;
let _resetStatsRequested = false;
let _extensionContext = null;
let _serverStartedAt = Date.now();
let _serverOwnerWindowKey = '';
let _lastOwnerPollAt = 0;
const OWNER_STALE_MS = 30000;
let _runtimeHealth = {
    acceptDegraded: false,
    scrollDegraded: false,
    reason: '',
    detail: '',
    source: '',
    updatedAt: 0
};
let _lastRendererRuntimeStateAt = 0;
let _rendererRepairTimer = null;
const RENDERER_HEARTBEAT_GRACE_MS = 22000;

function readRequestBody(req, res, maxBytes, onBody) {
    let body = '';
    let rejected = false;
    req.on('data', chunk => {
        if (rejected) return;
        body += chunk;
        if (body.length > maxBytes) {
            rejected = true;
            res.writeHead(413);
            res.end(JSON.stringify({ error: 'Payload too large' }));
            req.destroy();
        }
    });
    req.on('end', () => {
        if (!rejected) onBody(body);
    });
    req.on('error', (e) => {
        if (!rejected) {
            rejected = true;
            res.writeHead(400);
            res.end(JSON.stringify({ error: e.message }));
        }
    });
}

function setRuntimeHealth(next = {}) {
    const acceptDegraded = !!next.acceptDegraded;
    const scrollDegraded = !!next.scrollDegraded;
    const reason = next.reason ? String(next.reason) : '';
    const detail = next.detail ? String(next.detail) : '';
    const source = next.source ? String(next.source) : '';
    const changed = _runtimeHealth.acceptDegraded !== acceptDegraded ||
        _runtimeHealth.scrollDegraded !== scrollDegraded ||
        _runtimeHealth.reason !== reason ||
        _runtimeHealth.detail !== detail ||
        _runtimeHealth.source !== source;

    _runtimeHealth = {
        acceptDegraded,
        scrollDegraded,
        reason,
        detail,
        source,
        updatedAt: Date.now()
    };

    if (changed) {
        const label = (reason || 'healthy').toUpperCase();
        console.log('[AG Auto] Runtime health → ' + label + ' | acceptDegraded=' + acceptDegraded + ' | scrollDegraded=' + scrollDegraded + (detail ? ' | detail=' + detail : ''));
    }

    updateStatusBarItem();
}

function markRuntimeHealthy(source) {
    setRuntimeHealth({ acceptDegraded: false, scrollDegraded: false, reason: '', detail: '', source: source || 'extension' });
}

function markRendererHeartbeat() {
    _lastRendererRuntimeStateAt = Date.now();
}

function ensureRendererAliveAfterStartup(context) {
    if (_rendererRepairTimer) clearTimeout(_rendererRepairTimer);

    _rendererRepairTimer = setTimeout(() => {
        const now = Date.now();
        const lastSignal = Math.max(_lastRendererRuntimeStateAt || 0, _lastOwnerPollAt || 0);
        if (lastSignal > 0 && now - lastSignal < RENDERER_HEARTBEAT_GRACE_MS) return;

        // Safe mode: do not mark DEGRADED or reload from missing runtime-state alone.
        // The renderer can be alive before it has a bound HTTP port (for example it can
        // still dismiss the corrupt banner). A false degraded state breaks UX.
        console.log('[AG Auto] Renderer watchdog: no HTTP heartbeat yet; keeping runtime active and waiting for renderer port discovery.');
    }, RENDERER_HEARTBEAT_GRACE_MS);

    if (context && context.subscriptions) {
        context.subscriptions.push({ dispose: () => { if (_rendererRepairTimer) clearTimeout(_rendererRepairTimer); } });
    }
}


function startHttpServer() {
    if (_httpServer && _actualPort > 0) return;
    if (_httpServer && _actualPort <= 0) {
        console.log('[AG Auto] HTTP server exists without active port — resetting before restart');
        try { _httpServer.close(); } catch (_e) { }
        try { _httpServer.removeAllListeners(); } catch (_e) { }
        _httpServer = null;
    }
    // Initialize defaults only once for this window runtime
    if (_httpClickPatterns.length === 0) {
        const cfg = vscode.workspace.getConfiguration('ag-auto');
        const patternState = resolveClickPatternState(
            _extensionContext,
            cfg.get('clickPatterns', ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept', 'Approve', 'Always Approve', 'Approve Once', 'Allow Session']),
            { mergeDefaults: true }
        );
        _httpClickPatterns = patternState.activePatterns;
        _httpScrollEnabled = _extensionContext ? _extensionContext.globalState.get('scrollEnabledPreference', cfg.get('scrollEnabled', true)) : cfg.get('scrollEnabled', true);
        _httpScrollConfig = {
            pauseScrollMs: cfg.get('scrollPauseMs', 5000),
            scrollIntervalMs: cfg.get('scrollIntervalMs', 500),
            clickIntervalMs: cfg.get('clickIntervalMs', 2000)
        };
        _autoAcceptEnabled = _extensionContext ? _extensionContext.globalState.get('startupEnabledPreference', true) : true;
    }
    try {
        const url = require('url');
        _httpServer = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Content-Type', 'application/json');

            // Handle CORS preflight
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            const parsed = url.parse(req.url, true);
            const requestWindowKey = parsed.query && typeof parsed.query.windowKey === 'string' ? String(parsed.query.windowKey) : '';
            const requestStartedAt = parsed.query && parsed.query.startedAt ? Number(parsed.query.startedAt) : 0;

            if (parsed.pathname === '/ag-status') {
                if (requestWindowKey) {
                    // Stale owner detection: if current owner hasn't polled in 30s, release the claim
                    if (_serverOwnerWindowKey && _serverOwnerWindowKey !== requestWindowKey && _lastOwnerPollAt > 0) {
                        const ownerIdleMs = Date.now() - _lastOwnerPollAt;
                        if (ownerIdleMs > OWNER_STALE_MS) {
                            console.log('[AG Auto] Owner stale (' + Math.round(ownerIdleMs / 1000) + 's idle) — releasing claim from', _serverOwnerWindowKey);
                            _serverOwnerWindowKey = '';
                            _lastOwnerPollAt = 0;
                        }
                    }

                    if (!_serverOwnerWindowKey) {
                        const claimWindowMs = 15000;
                        const age = Date.now() - _serverStartedAt;
                        const startupDiff = requestStartedAt > 0 ? Math.abs(requestStartedAt - _serverStartedAt) : 0;
                        if (requestStartedAt > 0 && age > claimWindowMs && startupDiff > claimWindowMs) {
                            res.writeHead(200);
                            res.end(JSON.stringify({
                                enabled: false,
                                bindRejected: true,
                                rejectReason: 'startup-mismatch',
                                serverStartedAt: _serverStartedAt
                            }));
                            return;
                        }
                        _serverOwnerWindowKey = requestWindowKey;
                        _lastOwnerPollAt = Date.now();
                        console.log('[AG Auto] Server owner claimed by key:', _serverOwnerWindowKey);
                    } else if (_serverOwnerWindowKey !== requestWindowKey) {
                        res.writeHead(200);
                        res.end(JSON.stringify({
                            enabled: false,
                            bindRejected: true,
                            rejectReason: 'owner-mismatch',
                            ownerKey: _serverOwnerWindowKey,
                            serverStartedAt: _serverStartedAt
                        }));
                        return;
                    } else {
                        // Owner is polling — update heartbeat
                        _lastOwnerPollAt = Date.now();
                    }
                }
            }

            // Receive click stats DELTA from autoScript via query params
            if (parsed.query && parsed.query.stats) {
                try {
                    const incoming = JSON.parse(decodeURIComponent(parsed.query.stats));
                    // ADD deltas to persisted stats (not replace!)
                    for (const key in incoming) {
                        if (!_clickStats[key]) _clickStats[key] = 0;
                        _clickStats[key] += incoming[key];
                    }
                    // Recalculate total from all stats
                    let total = 0;
                    for (const key in _clickStats) { total += _clickStats[key]; }
                    _totalClicks = total;
                    // Persist to globalState
                    if (_extensionContext) {
                        _extensionContext.globalState.update('clickStats', _clickStats);
                        _extensionContext.globalState.update('totalClicks', _totalClicks);
                    }
                } catch (e) { /* ignore parse errors */ }
            }

            // Reset stats endpoint
            if (parsed.pathname === '/ag-reset-stats') {
                _clickStats = {};
                _totalClicks = 0;
                res.writeHead(200);
                res.end(JSON.stringify({ reset: true }));
                return;
            }

            // Click LOG endpoint (debug)
            if (parsed.pathname === '/api/click-log' && req.method === 'POST') {
                readRequestBody(req, res, 16384, (body) => {
                    try {
                        const data = JSON.parse(body);
                        console.log('[AG Auto] Click-log received:', data.pattern, data.button);
                        const timestamp = (function () { var d = new Date(); var pad = function (n) { return n < 10 ? '0' + n : n }; return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1); })();
                        const entry = { time: timestamp, pattern: data.pattern || 'click', button: (data.button || '').substring(0, 80) };
                        _clickLog.unshift(entry);
                        if (_clickLog.length > 200) _clickLog.pop();
                        // Persist to globalState
                        if (_extensionContext) {
                            _extensionContext.globalState.update('clickLog', _clickLog);
                        }
                        if (_settingsPanel) {
                            _settingsPanel.webview.postMessage({ command: 'clickLogUpdate', log: _clickLog });
                        }
                        res.writeHead(200);
                        res.end(JSON.stringify({ logged: true }));
                    } catch (e) {
                        res.writeHead(200);
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }

            // Runtime health endpoint from injected script
            if (parsed.pathname === '/api/runtime-state' && req.method === 'POST') {
                readRequestBody(req, res, 16384, (body) => {
                    try {
                        const data = JSON.parse(body || '{}');
                        markRendererHeartbeat();
                        setRuntimeHealth({
                            acceptDegraded: !!data.acceptDegraded,
                            scrollDegraded: !!data.scrollDegraded,
                            reason: data.reason || '',
                            detail: data.detail || '',
                            source: data.source || 'autoScript'
                        });
                        res.writeHead(200);
                        res.end(JSON.stringify({ ok: true, runtimeHealth: _runtimeHealth }));
                    } catch (e) {
                        res.writeHead(200);
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }

            res.writeHead(200);
            // Filter out 'Accept' from regular patterns — it needs special handling (chat-only)
            const safePatterns = _httpClickPatterns.filter(p => p !== 'Accept');
            const acceptEnabled = _httpClickPatterns.includes('Accept');
            const response = {
                enabled: _autoAcceptEnabled,
                scrollEnabled: _httpScrollEnabled,
                clickPatterns: safePatterns,
                acceptInChatOnly: acceptEnabled,
                pauseScrollMs: _httpScrollConfig.pauseScrollMs,
                scrollIntervalMs: _httpScrollConfig.scrollIntervalMs,
                clickIntervalMs: _httpScrollConfig.clickIntervalMs,
                clickStats: _clickStats,
                totalClicks: _totalClicks,
                clickLimits: _extensionContext ? _extensionContext.globalState.get('clickLimits', {}) : {},
                ownerKey: _serverOwnerWindowKey || null,
                serverStartedAt: _serverStartedAt,
                runtimeHealth: _runtimeHealth
            };
            if (_resetStatsRequested) {
                response.resetStats = true;
                _resetStatsRequested = false;
            }
            res.end(JSON.stringify(response));
        });
        // Dynamic port: try range 48787-48850 until one is available
        function tryListenPort(port) {
            if (port > AG_HTTP_PORT_END) {
                console.log('[AG Auto] No available port in range ' + AG_HTTP_PORT_START + '-' + AG_HTTP_PORT_END);
                return;
            }
            _httpServer.removeAllListeners('error');
            _httpServer.once('error', (e) => {
                if (e.code === 'EADDRINUSE') {
                    console.log('[AG Auto] Port ' + port + ' busy, trying ' + (port + 1) + '...');
                    tryListenPort(port + 1);
                } else {
                    console.log('[AG Auto] HTTP server error:', e.message);
                }
            });
            _httpServer.listen(port, '127.0.0.1', () => {
                _actualPort = port;
                console.log('[AG Auto] ✅ HTTP server started on port ' + port);
                // Write port file so autoScript can discover our port
                try {
                    const wbPath = getWorkbenchPath();
                    if (wbPath) {
                        const portFile = path.join(path.dirname(wbPath), 'ag-auto-port-' + process.pid + '.txt');
                        fs.writeFileSync(portFile, String(port), 'utf8');
                        // Also write a shared port-list file (all active ports)
                        const listFile = path.join(path.dirname(wbPath), 'ag-auto-ports.json');
                        let portList = [];
                        try { portList = JSON.parse(fs.readFileSync(listFile, 'utf8')); } catch (_e) { }
                        portList = portList.filter(function (e) { return e.pid !== process.pid; });
                        portList.push({ pid: process.pid, port: port, time: Date.now() });
                        fs.writeFileSync(listFile, JSON.stringify(portList), 'utf8');
                    }
                } catch (pe) {
                    console.log('[AG Auto] Could not write port file:', pe.message);
                }
            });
        }
        tryListenPort(AG_HTTP_PORT_START);
    } catch (e) {
        console.log('[AG Auto] HTTP server failed:', e.message);
    }
}

// Keep Commands API as bonus (silent accept in background)
// ONLY chat-safe commands — NEVER editor diff commands
let _autoAcceptInterval = null;
const CHAT_ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',        // Chat panel: accept agent step ✅
    'antigravity.prioritized.supercompleteAccept', // Autocomplete accept ✅
    'antigravity.terminalCommand.accept',        // Terminal command accept ✅
    'antigravity.acceptCompletion'               // Code completion accept ✅
    // REMOVED: 'antigravity.command.accept'                    — too generic, may affect editor
    // REMOVED: 'antigravity.prioritized.agentAcceptAllInFile'  — EDITOR accept!
    // REMOVED: 'antigravity.prioritized.agentAcceptFocusedHunk' — EDITOR accept!
];
CHAT_ACCEPT_COMMANDS.splice(0, CHAT_ACCEPT_COMMANDS.length, 'antigravity.agent.acceptAgentStep', 'antigravity.terminalCommand.accept');

function startCommandsLoop() {
    const clickMs = _httpScrollConfig.clickIntervalMs || 2000;

    if (_autoAcceptInterval) clearInterval(_autoAcceptInterval);

    _autoAcceptInterval = setInterval(() => {
        if (!_autoAcceptEnabled) return;

        // Run chat-safe commands when ANY accept-related pattern is enabled
        const wantsAccept = _httpClickPatterns.includes('Accept');
        if (!wantsAccept) return;

        Promise.allSettled(
            CHAT_ACCEPT_COMMANDS.map(cmd => vscode.commands.executeCommand(cmd))
        ).catch(() => { });
    }, clickMs);

    console.log('[AG Auto] Commands loop started (interval: ' + clickMs + 'ms, enabled: ' + _autoAcceptEnabled + ', chat commands: ' + CHAT_ACCEPT_COMMANDS.length + ')');
}

// =============================================================
// CHECK IF SCRIPT IS ACTUALLY INJECTED
// =============================================================
/**
 * Check if the inject markers actually exist in workbench.html
 * Returns false if Antigravity updated and overwrote the files
 */
function isScriptInjected() {
    try {
        const wbPath = getWorkbenchPath();
        if (!wbPath) return false;
        const wbDir = path.dirname(wbPath);
        const html = fs.readFileSync(wbPath, 'utf8');
        const scriptPath = path.join(wbDir, 'ag-auto-script.js');
        if (!hasValidHtmlInjection(html) || !fs.existsSync(scriptPath)) return false;
        const script = fs.readFileSync(scriptPath, 'utf8');
        return script.length > 1000 && script.includes('window._agAutoLoaded');
    } catch (e) {
        console.log('[AG Auto] Cannot check inject status:', e.message);
        return false;
    }
}

// =============================================================
// EXTENSION ACTIVATION
// =============================================================
function activate(context) {
    const _extVersion = context.extension?.packageJSON?.version || 'unknown';
    console.log('[AG Auto] Extension dang khoi dong (v' + _extVersion + ')...');
    _extensionContext = context;

    // Restore persisted click stats
    _clickStats = context.globalState.get('clickStats', {});
    _totalClicks = context.globalState.get('totalClicks', 0);
    // Restore persisted click log
    const storedLog = context.globalState.get('clickLog', []);
    if (storedLog && storedLog.length > 0) _clickLog = storedLog;
    // Restore persisted startup Accept preference
    _autoAcceptEnabled = context.globalState.get('startupEnabledPreference', true);
    // Restore persisted scroll preference
    _httpScrollEnabled = context.globalState.get('scrollEnabledPreference', true);



    // Background "Keep Waiting" dialog clicker (Win32 native dialog)
    if (process.platform === 'win32') {
        const { execFile } = require('child_process');
        const keepWaitingScript = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AgWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hwnd, EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr w, IntPtr l);
}
"@
$global:clicked = $false
[AgWin32]::EnumWindows({
    param($hWnd, $lp)
    if (-not [AgWin32]::IsWindowVisible($hWnd)) { return $true }
    if ($global:clicked) { return $false }
    [AgWin32]::EnumChildWindows($hWnd, {
        param($ch, $lp2)
        $cls = New-Object System.Text.StringBuilder 64
        [AgWin32]::GetClassName($ch, $cls, 64) | Out-Null
        if ($cls.ToString() -eq 'Button') {
            $txt = New-Object System.Text.StringBuilder 256
            [AgWin32]::GetWindowText($ch, $txt, 256) | Out-Null
            $t = $txt.ToString()
            if ($t -match 'Keep Waiting') {
                [AgWin32]::PostMessage($ch, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
                $global:clicked = $true
            }
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null
    if ($global:clicked) { return $false }
    return $true
}, [IntPtr]::Zero) | Out-Null
if ($global:clicked) { Write-Output 'CLICKED' }
`.trim();

        const keepWaitingInterval = setInterval(() => {
            if (!_autoAcceptEnabled) return;
            if (!_httpClickPatterns.includes('Keep Waiting')) return;

            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', keepWaitingScript], { timeout: 5000 }, (err, stdout) => {
                if (stdout && stdout.trim() === 'CLICKED') {
                    console.log('[AG Auto] 🎯 Native dialog: Keep Waiting clicked via Win32');
                    _totalClicks++;
                    if (!_clickStats['Keep Waiting']) _clickStats['Keep Waiting'] = 0;
                    _clickStats['Keep Waiting']++;
                    if (_extensionContext) {
                        _extensionContext.globalState.update('clickStats', _clickStats);
                        _extensionContext.globalState.update('totalClicks', _totalClicks);
                    }
                }
            });
        }, 3000);
        context.subscriptions.push({ dispose: () => clearInterval(keepWaitingInterval) });
        console.log('[AG Auto] Win32 Keep Waiting watcher started');
    }

    // extensionKind: ["ui"] ensures this always runs locally — safe to inject
    {

        // Check if script is ACTUALLY present in workbench files (not just a stored key)
        // This handles Antigravity updates that overwrite workbench files
        const needsInject = !isScriptInjected();

        // Detect extension upgrade / first install auto-inject cases
        const currentVersion = context.extension?.packageJSON?.version || '0';
        const lastInjectedVersion = context.globalState.get('ag-injected-version', '0');
        const attemptedInjectKeys = context.globalState.get('ag-auto-inject-attempted-keys', {});
        const versionChanged = currentVersion !== lastInjectedVersion;

        let autoInjectKey = '';
        if (versionChanged) {
            autoInjectKey = 'upgrade:' + currentVersion;
        } else if (needsInject) {
            autoInjectKey = 'missing-script';
        }

        const alreadyAttemptedThisKey = autoInjectKey ? !!attemptedInjectKeys[autoInjectKey] : false;
        const shouldInjectNow = !!autoInjectKey && !alreadyAttemptedThisKey;

        // ONLY inject once per reason key (first install / missing script / each upgraded version)
        if (shouldInjectNow) {
            try {
                attemptedInjectKeys[autoInjectKey] = { time: Date.now(), success: false };
                context.globalState.update('ag-auto-inject-attempted-keys', attemptedInjectKeys);
                console.log('[AG Auto] One-time auto inject scheduled for key: ' + autoInjectKey);

                const installOk = installScript(context);
                const injectedAfterInstall = installOk && isScriptInjected();

                if (injectedAfterInstall) {
                    attemptedInjectKeys[autoInjectKey] = { time: Date.now(), success: true };
                    context.globalState.update('ag-auto-inject-attempted-keys', attemptedInjectKeys);
                    context.globalState.update('ag-injected-version', currentVersion);

                    const reason = autoInjectKey === 'missing-script'
                        ? 'Script not found in workbench (one-time auto inject)'
                        : ('Version ' + lastInjectedVersion + ' → ' + currentVersion + ' (one-time auto inject)');
                    console.log('[AG Auto] ' + reason + ' — clearing V8 cache and reloading...');
                    clearV8CodeCache();

                    // Update checksums BEFORE reload to avoid double-reload
                    updateProductChecksums();
                    suppressSettingsRestoreForNextStartup(context);
                    closeUnexpectedSettingsTabs({ force: true }).catch(err => {
                        console.log('[AG Auto] Could not pre-close settings before reload:', err.message);
                    });

                    setTimeout(() => {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }, 1000);
                } else {
                    console.log('[AG Auto] Auto inject attempt did not complete successfully for key ' + autoInjectKey + ' — waiting for manual fallback');
                    vscode.window.showWarningMessage(
                        '[AG Auto] Extension đã tự thử inject script 1 lần cho bản này nhưng chưa thành công. Bạn có muốn chạy Auto Enable (Inject Script) thủ công không?',
                        'Chạy ngay'
                    ).then(choice => {
                        if (choice === 'Chạy ngay') {
                            vscode.commands.executeCommand('ag-auto.enable');
                        }
                    });
                }
            } catch (e) {
                console.error('[AG Auto] Inject error:', e.message);
                vscode.window.showWarningMessage(
                    '[AG Auto] Extension đã tự thử inject script 1 lần cho bản này nhưng gặp lỗi. Bạn có muốn chạy Auto Enable (Inject Script) thủ công không?',
                    'Chạy ngay'
                ).then(choice => {
                    if (choice === 'Chạy ngay') {
                        vscode.commands.executeCommand('ag-auto.enable');
                    }
                });
            }
        } else {
            console.log('[AG Auto] ✅ Auto inject already attempted for current state, skipping');

            // Only update autoScript.js file (for fetch+eval loader) without touching workbench files
            try {
                const wbPath = getWorkbenchPath();
                if (wbPath) {
                    const scriptContent = buildScriptContent(context);
                    const destPath = path.join(path.dirname(wbPath), 'ag-auto-script.js');
                    writeFileElevated(destPath, scriptContent);
                    console.log('[AG Auto] ✅ ag-auto-script.js updated (fetch+eval will load fresh)');
                }
            } catch (e) {
                console.error('[AG Auto] Error updating ag-auto-script.js:', e.message);
            }

            // Update checksums if needed (but DON'T reload — the loader handles fresh script)
            const checksumsUpdated = updateProductChecksums();
            if (checksumsUpdated) {
                console.log('[AG Auto] Checksums updated (no reload needed — fetch+eval handles it)');
            }
        }

        // SECOND RUN (after reload): workbench.js has our injected code running
        console.log('[AG Auto] ✅ Script ready, starting services...');
        markRuntimeHealthy('activate');

        // 1. HTTP server for IPC (injected script polls this for ON/OFF)
        startHttpServer();
        ensureRendererAliveAfterStartup(context);

        // 2. Commands API as bonus background accept
        startCommandsLoop();

        // 3. Write config JSON
        writeConfigJson(context);
    } // end of else (non-remote context)

    // ---- Always register commands & status bar (even during first inject/remote) ----
    createStatusBarItem(context);

    // Register serializers for ALL known viewTypes so VS Code calls us
    // instead of silently restoring a stale webview panel from session.
    // We immediately dispose any restored panel.
    for (const viewType of LEGACY_SETTINGS_PANEL_VIEW_TYPES) {
        try {
            vscode.window.registerWebviewPanelSerializer(viewType, {
                async deserializeWebviewPanel(panel, _state) {
                    console.log('[AG Auto] Intercepted restored webview (' + viewType + ') — disposing immediately');
                    panel.dispose();
                }
            });
        } catch (e) {
            // If already registered (e.g. duplicate activation), ignore
            console.log('[AG Auto] Serializer for ' + viewType + ' already registered or failed:', e.message);
        }
    }

    registerUnexpectedSettingsTabGuard(context);
    scheduleSoftPromo(context);

    // Kill any restored dashboard tabs from previous session ASAP
    consumePendingSettingsRestoreSuppression(context).then(shouldSuppress => {
        if (shouldSuppress) {
            console.log('[AG Auto] Suppress flag active — force-closing restored settings tabs');
            closeUnexpectedSettingsTabs({ force: true }).catch(e => {
                console.log('[AG Auto] Early restore suppression failed:', e.message);
            });
        }
    });

    // Fallback: also try closing restored tabs after a short delay
    const restoredSettingsTimer = setTimeout(() => {
        closeUnexpectedSettingsTabs();
    }, 2000);
    context.subscriptions.push({ dispose: () => clearTimeout(restoredSettingsTimer) });

    // Lắng nghe khi settings thay đổi -> cập nhật status bar icon
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ag-auto')) {
                updateStatusBarItem();
            }
        })
    );

    // Command: Enable
    context.subscriptions.push(
        vscode.commands.registerCommand('ag-auto.enable', async () => {
            const success = installScript(context);
            if (success) {
                clearV8CodeCache();
                updateProductChecksums();
                await context.globalState.update('ag-injected-version', context.extension?.packageJSON?.version || '0');
                updateStatusBarItem();
                vscode.window.setStatusBarMessage('[AG Auto] Script injected. Reloading Antigravity...', 3000);
                setTimeout(() => {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }, 800);
            } else {
                vscode.window.showErrorMessage('[AG Auto] Inject script thất bại. Hãy thử mở Antigravity bằng quyền Administrator rồi chạy lại.');
            }
        })
    );

    // Command: Disable
    context.subscriptions.push(
        vscode.commands.registerCommand('ag-auto.disable', async () => {
            const success = uninstallScript();
            if (success) {
                clearV8CodeCache();
                updateProductChecksums();
                updateStatusBarItem();
                const choice = await vscode.window.showInformationMessage(
                    '[AG Auto] Script removed! Reload VS Code to complete.',
                    'Reload Now'
                );
                if (choice === 'Reload Now') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            } else {
                vscode.window.showErrorMessage('[AG Auto] workbench.html not found!');
            }
        })
    );

    // Command: Open Settings
    context.subscriptions.push(
        vscode.commands.registerCommand('ag-auto.openSettings', async () => {
            // Mở bottom panel trước, sau đó reveal tab settings
            await vscode.commands.executeCommand('duckmanlam-auto-vip.settingsPanel.focus');
        })
    );

    // Đăng ký WebviewViewProvider cho Bottom Panel
    const settingsViewProvider = {
        resolveWebviewView(webviewView) {
            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
            };

            // Render HTML
            const renderView = async () => {
                const config = vscode.workspace.getConfiguration('ag-auto');
                const configuredPatterns = config.get('clickPatterns', ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept', 'Approve', 'Always Approve', 'Approve Once', 'Allow Session']);
                const patternState = resolveClickPatternState(context, configuredPatterns, { mergeDefaults: true });
                webviewView.webview.html = buildSettingsHtmlV85({
                    enabled: _autoAcceptEnabled,
                    scrollEnabled: _httpScrollEnabled,
                    scrollPauseMs: config.get('scrollPauseMs', 7000),
                    scrollIntervalMs: config.get('scrollIntervalMs', 500),
                    clickIntervalMs: config.get('clickIntervalMs', 1000),
                    clickPatterns: patternState.mergedPatterns,
                    disabledClickPatterns: patternState.disabledPats,
                    clickLimits: context.globalState.get('clickLimits', {}),
                    language: config.get('language', 'vi'),
                    clickStats: _clickStats,
                    totalClicks: _totalClicks,
                    version: context.extension?.packageJSON?.version || '0.0.0',
                    serverPort: _actualPort || 0,
                    scriptInjected: isScriptInjected(),
                    serverStartedAt: _serverStartedAt || Date.now()
                });
            };

            renderView();

            // Xử lý message từ webview (giống settings panel cũ)
            webviewView.webview.onDidReceiveMessage(async (msg) => {
                if (msg.command === 'changeLang') {
                    const cfg = vscode.workspace.getConfiguration('ag-auto');
                    await cfg.update('language', msg.lang, vscode.ConfigurationTarget.Global);
                    renderView();
                    return;
                }
                if (msg.command === 'toggle') {
                    _autoAcceptEnabled = msg.enabled;
                    await context.globalState.update('startupEnabledPreference', _autoAcceptEnabled);
                    writeConfigJson(context);
                    updateStatusBarItem();
                    return;
                }
                if (msg.command === 'scrollToggle') {
                    _httpScrollEnabled = msg.enabled;
                    await context.globalState.update('scrollEnabledPreference', _httpScrollEnabled);
                    writeConfigJson(context);
                    updateStatusBarItem();
                    return;
                }
                if (msg.command === 'save') {
                    _autoAcceptEnabled = msg.data.enabled;
                    _httpClickPatterns = msg.data.clickPatterns.filter(p => !msg.data.disabledClickPatterns.includes(p));
                    _httpScrollConfig = {
                        pauseScrollMs: msg.data.scrollPauseMs || 5000,
                        scrollIntervalMs: msg.data.scrollIntervalMs || 500,
                        clickIntervalMs: msg.data.clickIntervalMs || 2000
                    };
                    await context.globalState.update('disabledClickPatterns', msg.data.disabledClickPatterns);
                    await context.globalState.update('clickLimits', msg.data.clickLimits || {});
                    await context.globalState.update('startupEnabledPreference', _autoAcceptEnabled);
                    try {
                        const cfg = vscode.workspace.getConfiguration('ag-auto');
                        await cfg.update('clickPatterns', msg.data.clickPatterns, vscode.ConfigurationTarget.Global);
                        await cfg.update('clickIntervalMs', msg.data.clickIntervalMs || 2000, vscode.ConfigurationTarget.Global);
                        await cfg.update('scrollPauseMs', msg.data.scrollPauseMs || 5000, vscode.ConfigurationTarget.Global);
                        await cfg.update('scrollIntervalMs', msg.data.scrollIntervalMs || 500, vscode.ConfigurationTarget.Global);
                        await cfg.update('language', msg.data.language, vscode.ConfigurationTarget.Global);
                    } catch (e) {
                        await context.globalState.update('language', msg.data.language);
                    }
                    _cachedSettingsHtml = null;
                    writeConfigJson(context);
                    updateStatusBarItem();
                    startCommandsLoop();
                    vscode.window.setStatusBarMessage('$(check) [AG Auto] Saved!', 3000);
                    return;
                }
                if (msg.command === 'reload') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                    return;
                }
                if (msg.command === 'getStats') {
                    webviewView.webview.postMessage({ command: 'statsUpdated', clickStats: _clickStats, totalClicks: _totalClicks });
                    return;
                }
                if (msg.command === 'getClickLog') {
                    webviewView.webview.postMessage({ command: 'clickLogUpdate', log: _clickLog });
                    return;
                }
            });

            // Refresh stats khi view hiện ra
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    webviewView.webview.postMessage({ command: 'statsUpdated', clickStats: _clickStats, totalClicks: _totalClicks });
                    webviewView.webview.postMessage({ command: 'clickLogUpdate', log: _clickLog });
                }
            });
        }
    };

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('duckmanlam-auto-vip.settingsPanel', settingsViewProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );
}

function deactivate() {
    if (statusBarItem) {
        statusBarItem.dispose();
    }
    if (statusBarScroll) {
        statusBarScroll.dispose();
    }
    if (_settingsPanel) {
        _settingsPanel.dispose();
        _settingsPanel = null;
    }
    if (_autoAcceptInterval) {
        clearInterval(_autoAcceptInterval);
        _autoAcceptInterval = null;
    }
    if (_httpServer) {
        try { _httpServer.close(); } catch (_e) { }
        _httpServer = null;
    }
    // Cleanup port file
    try {
        const wbPath = getWorkbenchPath();
        if (wbPath) {
            const portFile = path.join(path.dirname(wbPath), 'ag-auto-port-' + process.pid + '.txt');
            if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
            // Remove our entry from ports list
            const listFile = path.join(path.dirname(wbPath), 'ag-auto-ports.json');
            try {
                let portList = JSON.parse(fs.readFileSync(listFile, 'utf8'));
                portList = portList.filter(e => e.pid !== process.pid);
                fs.writeFileSync(listFile, JSON.stringify(portList), 'utf8');
            } catch (_e) { }
        }
    } catch (_e) { }
}

module.exports = { activate, deactivate };
