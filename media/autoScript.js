(function () {
    if (window._agAutoLoaded) return;
    window._agAutoLoaded = true;

    if (window._agToolIntervals) {
        window._agToolIntervals.forEach(clearInterval);
        window.removeEventListener('scroll', window._agScrollListener, true);
    }
    window._agToolIntervals = [];

    (function suppressCorruptBanner() {
        function dismissCorrupt() {
            var banners = document.querySelectorAll('.notifications-toasts .notification-toast, .notification-list-item');
            banners.forEach(function (banner) {
                var text = banner.textContent || '';
                if (text.indexOf('corrupt') === -1 && text.indexOf('reinstall') === -1) return;

                var closeBtn = banner.querySelector('.codicon-notifications-clear, .codicon-close, .action-label[aria-label*="Close"], .action-label[aria-label*="clear"], .clear-notification-action');
                if (closeBtn) {
                    closeBtn.click();
                    console.log('[AG Auto] Dismissed corrupt notification');
                } else {
                    banner.style.display = 'none';
                    console.log('[AG Auto] Hid corrupt notification');
                }
            });
        }

        dismissCorrupt();

        var attempts = 0;
        var timer = setInterval(function () {
            dismissCorrupt();
            if (++attempts > 30) clearInterval(timer);
        }, 1000);

        try {
            var observer = new MutationObserver(function () { dismissCorrupt(); });
            observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
            setTimeout(function () { observer.disconnect(); }, 30000);
        } catch (e) { }
    })();

    var PAUSE_SCROLL_MS = /*{{PAUSE_SCROLL_MS}}*/7000;
    var CLICK_INTERVAL_MS = /*{{CLICK_INTERVAL_MS}}*/1000;
    var SCROLL_INTERVAL_MS = /*{{SCROLL_INTERVAL_MS}}*/500;
    var CLICK_PATTERNS = /*{{CLICK_PATTERNS}}*/["Allow", "Always Allow", "Allow in Workspace", "Run", "Keep Waiting", "Accept all", "Approve", "Always Approve", "Approve Once", "Allow Session", "Yes", "Yes, and always allow", "Yes, allow this time"];
    var CLICK_LIMITS = {}; // { pattern: maxClicks } — 0 or missing = unlimited
    var _agPatternClickCounts = {}; // { pattern: currentCount }

    window._agAcceptChatOnly = false;
    window._agAutoEnabled = false; // Default OFF — only server can turn ON
    window._agScrollEnabled = false; // Default OFF — requires server confirmation
    var _agExpectedEnabled = false;
    var _agServerEverConnected = false; // Track if we ever reached the server

    var AG_HTTP_PORT_START = 48787;
    var AG_HTTP_PORT_END = 48850;
    var AG_HTTP_PORT = 0;
    var _agPollCount = 0;
    var _agPollErrors = 0;
    var _agPortScanning = false;
    var _agBindRejectRetries = 0;
    var _agSessionStats = {};
    var _agSessionTotal = 0;
    var _agLastContentChange = 0;
    var _agContentActiveUntil = 0;
    var _agManualPauseUntil = 0;
    var _agAutoScrollGuardUntil = 0;
    var _agScrollObserver = null;
    var _agObservedChatPanel = null;
    var _agObserverWatchdog = 0;
    var _agAutoScrollInterval = 0;
    var _agAutoScrollKickTimer = 0;
    var _agLastJumpButtonClickAt = 0;
    var isAutoScrolling = false;
    var WORKBENCH_DIR = /*{{WORKBENCH_DIR}}*/"";
    var _agWindowBindingKey = '';
    var _agWindowStartedAt = Date.now();
    var _agFs = null;
    var _agPath = null;
    var _agBindingsFile = '';
    var _agPortsListFile = '';
    var _agBoundPortProvisionalUntil = 0;

    try {
        var _agReq = (typeof require === 'function' && require) || (window && typeof window.require === 'function' && window.require);
        if (_agReq) {
            _agFs = _agReq('fs');
            _agPath = _agReq('path');
            if (WORKBENCH_DIR && _agPath) {
                var _agWorkbenchResolvedDir = WORKBENCH_DIR.replace(/\//g, _agPath.sep);
                _agBindingsFile = _agPath.join(_agWorkbenchResolvedDir, 'ag-auto-window-bindings.json');
                _agPortsListFile = _agPath.join(_agWorkbenchResolvedDir, 'ag-auto-ports.json');
            }
        }
    } catch (_agFsErr) { }

    try {
        _agWindowBindingKey = sessionStorage.getItem('agAutoWindowBindingKey') || '';
        if (!_agWindowBindingKey) {
            _agWindowBindingKey = 'win_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
            sessionStorage.setItem('agAutoWindowBindingKey', _agWindowBindingKey);
        }
    } catch (_agStorageErr) {
        _agWindowBindingKey = 'win_fallback';
    }

    function _agReadBindings() {
        if (!_agFs || !_agBindingsFile) return {};
        try {
            var raw = _agFs.readFileSync(_agBindingsFile, 'utf8');
            var parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_e) {
            return {};
        }
    }

    function _agReadPortsList() {
        if (!_agFs || !_agPortsListFile) return [];
        try {
            var raw = _agFs.readFileSync(_agPortsListFile, 'utf8');
            var parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_e) {
            return [];
        }
    }

    function _agGetPortMeta(port) {
        var list = _agReadPortsList();
        for (var i = 0; i < list.length; i++) {
            if (Number(list[i].port) === Number(port)) return list[i];
        }
        return null;
    }

    function _agScoreCandidate(port, cfg) {
        var score = 0;
        if (cfg && cfg.enabled) score += 5000;
        var meta = _agGetPortMeta(port);
        if (meta && Number(meta.time) > 0) {
            var diff = Math.abs(Number(meta.time) - _agWindowStartedAt);
            score += Math.max(0, 3000 - Math.min(diff, 3000));
            if (Number(meta.time) >= _agWindowStartedAt - 1500) score += 1200;
        }
        score += Number(port) / 1000;
        return score;
    }

    function _agWriteBindings(bindings) {
        if (!_agFs || !_agBindingsFile) return;
        try {
            _agFs.writeFileSync(_agBindingsFile, JSON.stringify(bindings), 'utf8');
        } catch (_e) { }
    }

    function _agGetBoundPort() {
        var bindings = _agReadBindings();
        var entry = bindings[_agWindowBindingKey];
        return entry && Number(entry.port) > 0 ? Number(entry.port) : 0;
    }

    function _agSetBoundPort(port, provisionalMs) {
        if (!port) return;
        var bindings = _agReadBindings();
        bindings[_agWindowBindingKey] = { port: Number(port), time: Date.now() };
        _agWriteBindings(bindings);
        _agBoundPortProvisionalUntil = provisionalMs ? (Date.now() + provisionalMs) : 0;
    }

    function _agClampMs(value, fallback, minValue, maxValue) {
        var num = Number(value);
        if (!isFinite(num)) num = Number(fallback);
        if (!isFinite(num)) num = minValue;
        return Math.max(minValue, Math.min(maxValue, Math.round(num)));
    }

    function _agScrollPauseWindowMs() {
        return _agClampMs(PAUSE_SCROLL_MS, 7000, 1000, 60000);
    }

    function _agScrollTickMs() {
        return _agClampMs(SCROLL_INTERVAL_MS, 500, 100, 5000);
    }

    function _agContentActivityWindowMs() {
        return Math.max(2500, Math.min(8000, Math.round(_agScrollPauseWindowMs() * 0.6)));
    }

    function _agNormalizeNode(node) {
        if (!node) return null;
        if (node === window) return document.documentElement;
        if (node.nodeType === 3) return node.parentElement;
        return node.nodeType === 1 ? node : null;
    }

    function _agGetChatPanel() {
        return document.querySelector('.antigravity-agent-side-panel');
    }

    function _agIsInsideChatPanel(node) {
        var el = _agNormalizeNode(node);
        return !!(el && el.closest && el.closest('.antigravity-agent-side-panel'));
    }

    function _agIsInputArea(node) {
        var el = _agNormalizeNode(node);
        return !!(el && (
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'INPUT' ||
            el.isContentEditable ||
            (el.closest && (
                el.closest('textarea') ||
                el.closest('[contenteditable="true"]') ||
                el.closest('[contenteditable="plaintext-only"]') ||
                el.closest('.chat-input') ||
                el.closest('.interactive-input-part') ||
                el.closest('.interactive-input') ||
                el.closest('.monaco-inputbox') ||
                el.closest('.input-editor')
            ))
        ));
    }

    function _agKickAutoScrollSoon(delayMs) {
        if (_agAutoScrollKickTimer) return;
        _agAutoScrollKickTimer = setTimeout(function () {
            _agAutoScrollKickTimer = 0;
            _agRunAutoScrollTick();
        }, delayMs || 40);
    }

    function _agMarkContentActivity() {
        var now = Date.now();
        _agLastContentChange = now;
        _agContentActiveUntil = now + _agContentActivityWindowMs();
        _agKickAutoScrollSoon(40);
    }

    function _agDiscoverPort(callback) {
        if (_agPortScanning) return;
        _agPortScanning = true;

        var candidates = [];
        var pending = 0;
        var totalBatches = 0;

        function finalizeScan() {
            _agPortScanning = false;
            if (candidates.length === 0) {
                console.log('[AG Auto] Port scan: no server found in range ' + AG_HTTP_PORT_START + '-' + AG_HTTP_PORT_END);
                return;
            }
            candidates.sort(function (a, b) {
                return _agScoreCandidate(b.port, b.cfg) - _agScoreCandidate(a.port, a.cfg);
            });
            var best = candidates[0];
            AG_HTTP_PORT = best.port;
            var meta = _agGetPortMeta(best.port);
            var provisionalMs = 0;
            var startupAge = Date.now() - _agWindowStartedAt;
            if (startupAge < 15000) {
                provisionalMs = Math.max(4000, 15000 - startupAge);
            } else if (meta && Number(meta.time) > 0) {
                var startupDiff = Math.abs(Number(meta.time) - _agWindowStartedAt);
                if (startupDiff > 2500 && startupAge < 22000) provisionalMs = 6000;
            }
            _agSetBoundPort(best.port, provisionalMs);
            console.log('[AG Auto] Discovered server on port ' + best.port + ' (enabled=' + best.cfg.enabled + ', candidates=' + candidates.length + ', key=' + _agWindowBindingKey + ', provisionalMs=' + provisionalMs + ')');
            if (callback) callback(best.port, best.cfg);
        }

        function tryBatch(fromPort) {
            if (fromPort > AG_HTTP_PORT_END) {
                // All batches done — pick best candidate
                finalizeScan();
                return;
            }

            var batchEnd = Math.min(fromPort + 7, AG_HTTP_PORT_END);
            var batchPending = 0;
            totalBatches++;

            for (var port = fromPort; port <= batchEnd; port++) {
                (function (scanPort) {
                    batchPending++;
                    pending++;
                    var xhr = new XMLHttpRequest();
                    xhr.open('GET', 'http://127.0.0.1:' + scanPort + '/ag-status?t=' + Date.now() + '&windowKey=' + encodeURIComponent(_agWindowBindingKey) + '&startedAt=' + _agWindowStartedAt, true);
                    xhr.timeout = 800;
                    xhr.onload = function () {
                        if (xhr.status === 200) {
                            try {
                                var cfg = JSON.parse(xhr.responseText);
                                if (cfg && cfg.bindRejected) {
                                    // This server belongs to another window key
                                } else if (typeof cfg.enabled === 'boolean') {
                                    candidates.push({ port: scanPort, cfg: cfg });
                                }
                            } catch (e) { }
                        }
                        batchPending--;
                        pending--;
                        if (batchPending <= 0) tryBatch(batchEnd + 1);
                    };
                    xhr.onerror = function () {
                        batchPending--;
                        pending--;
                        if (batchPending <= 0) tryBatch(batchEnd + 1);
                    };
                    xhr.ontimeout = function () {
                        batchPending--;
                        pending--;
                        if (batchPending <= 0) tryBatch(batchEnd + 1);
                    };
                    xhr.send();
                })(port);
            }
        }

        var boundPort = _agGetBoundPort();
        if (boundPort > 0 && !(_agBoundPortProvisionalUntil && Date.now() < _agBoundPortProvisionalUntil)) {
            var boundXhr = new XMLHttpRequest();
            boundXhr.open('GET', 'http://127.0.0.1:' + boundPort + '/ag-status?t=' + Date.now() + '&windowKey=' + encodeURIComponent(_agWindowBindingKey) + '&startedAt=' + _agWindowStartedAt, true);
            boundXhr.timeout = 800;
            boundXhr.onload = function () {
                if (boundXhr.status === 200) {
                    try {
                        var boundCfg = JSON.parse(boundXhr.responseText);
                        if (boundCfg && boundCfg.bindRejected) {
                            AG_HTTP_PORT = 0;
                            tryBatch(AG_HTTP_PORT_START);
                            return;
                        }
                        if (typeof boundCfg.enabled === 'boolean') {
                            AG_HTTP_PORT = boundPort;
                            console.log('[AG Auto] Reused bound port ' + boundPort + ' for key ' + _agWindowBindingKey + (Date.now() < _agBoundPortProvisionalUntil ? ' (provisional)' : ''));
                            _agPortScanning = false;
                            if (callback) callback(boundPort, boundCfg);
                            return;
                        }
                    } catch (_e) { }
                }
                tryBatch(AG_HTTP_PORT_START);
            };
            boundXhr.onerror = function () { tryBatch(AG_HTTP_PORT_START); };
            boundXhr.ontimeout = function () { tryBatch(AG_HTTP_PORT_START); };
            boundXhr.send();
            return;
        }

        tryBatch(AG_HTTP_PORT_START);
    }

    function _agReportRuntimeState(payload) {
        if (!AG_HTTP_PORT) return;
        try {
            var stateXhr = new XMLHttpRequest();
            stateXhr.open('POST', 'http://127.0.0.1:' + AG_HTTP_PORT + '/api/runtime-state', true);
            stateXhr.setRequestHeader('Content-Type', 'application/json');
            stateXhr.timeout = 1200;
            stateXhr.send(JSON.stringify({
                acceptDegraded: !!(payload && payload.acceptDegraded),
                scrollDegraded: !!(payload && payload.scrollDegraded),
                reason: payload && payload.reason ? String(payload.reason) : '',
                detail: payload && payload.detail ? String(payload.detail) : '',
                source: 'autoScript',
                windowKey: _agWindowBindingKey,
                startedAt: _agWindowStartedAt,
                sentAt: Date.now()
            }));
        } catch (_e) { }
    }

    function _agApplyConfig(cfg) {
        _agReportRuntimeState({
            acceptDegraded: false,
            scrollDegraded: false,
            reason: '',
            detail: ''
        });
        if (typeof cfg.enabled === 'boolean') {
            if (window._agAutoEnabled !== cfg.enabled) {
                console.log('[AG Auto] ' + (cfg.enabled ? 'ON' : 'OFF') + ' (live toggle via HTTP)');
            }
            window._agAutoEnabled = cfg.enabled;
        }

        if (typeof cfg.scrollEnabled === 'boolean') window._agScrollEnabled = cfg.scrollEnabled;

        if (cfg.clickPatterns && Array.isArray(cfg.clickPatterns)) {
            CLICK_PATTERNS = cfg.clickPatterns.filter(function (pattern) { return pattern !== 'Accept'; });
        }

        if (typeof cfg.acceptInChatOnly === 'boolean') window._agAcceptChatOnly = cfg.acceptInChatOnly;

        if (cfg.clickLimits && typeof cfg.clickLimits === 'object') {
            var hasLimits = Object.keys(cfg.clickLimits).length > 0;
            if (hasLimits && JSON.stringify(CLICK_LIMITS) !== JSON.stringify(cfg.clickLimits)) {
                console.log('[AG Auto] Click limits updated:', JSON.stringify(cfg.clickLimits));
            }
            CLICK_LIMITS = cfg.clickLimits;
        }

        if (typeof cfg.pauseScrollMs === 'number') {
            PAUSE_SCROLL_MS = _agClampMs(cfg.pauseScrollMs, PAUSE_SCROLL_MS, 1000, 60000);
        }

        if (typeof cfg.scrollIntervalMs === 'number') {
            var nextScrollInterval = _agClampMs(cfg.scrollIntervalMs, SCROLL_INTERVAL_MS, 100, 5000);
            if (nextScrollInterval !== SCROLL_INTERVAL_MS) {
                SCROLL_INTERVAL_MS = nextScrollInterval;
                _agRestartAutoScrollLoop();
            }
        }

        if (typeof cfg.clickIntervalMs === 'number') {
            var nextClickInterval = _agClampMs(cfg.clickIntervalMs, CLICK_INTERVAL_MS, 100, 120000);
            if (nextClickInterval !== CLICK_INTERVAL_MS) {
                CLICK_INTERVAL_MS = nextClickInterval;
                _agRestartClickLoop();
            }
        }

        if (cfg.clickStats) window._agClickStats = cfg.clickStats;
        if (typeof cfg.totalClicks === 'number') window._agTotalClicks = cfg.totalClicks;

        if (cfg.resetStats) {
            window._agClickStats = {};
            window._agTotalClicks = 0;
            _agSessionStats = {};
            _agSessionTotal = 0;
            console.log('[AG Auto] Stats reset by user');
        }
    }

    function _agHasMeaningfulMutation(mutation) {
        var node = _agNormalizeNode(mutation.target);
        if (!node || !_agIsInsideChatPanel(node) || _agIsInputArea(node)) return false;

        if (mutation.type === 'characterData') return true;

        if (mutation.type === 'childList') {
            return mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0;
        }

        if (mutation.type === 'attributes') {
            return ['class', 'style', 'aria-expanded', 'aria-busy', 'open', 'data-state'].indexOf(mutation.attributeName || '') !== -1;
        }

        return false;
    }

    function _agEnsureScrollObserver() {
        var chatPanel = _agGetChatPanel();
        if (!chatPanel) return false;

        if (_agObservedChatPanel === chatPanel && _agScrollObserver) return true;

        if (_agScrollObserver) {
            try { _agScrollObserver.disconnect(); } catch (e) { }
        }

        _agObservedChatPanel = chatPanel;
        _agScrollObserver = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                if (_agHasMeaningfulMutation(mutations[i])) {
                    _agMarkContentActivity();
                    return;
                }
            }
        });

        _agScrollObserver.observe(chatPanel, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'aria-expanded', 'aria-busy', 'open', 'data-state']
        });

        _agMarkContentActivity();
        console.log('[AG Auto] Smart scroll observer attached/refreshed');
        return true;
    }

    function _agElementDepth(el) {
        var depth = 0;
        while (el && el.parentElement) {
            depth++;
            el = el.parentElement;
        }
        return depth;
    }

    function _agCollectScrollTargets(chatPanel) {
        var nodes = [chatPanel].concat(Array.from(chatPanel.querySelectorAll('*')));
        return nodes.filter(function (el) {
            if (!el || el.nodeType !== 1) return false;
            if (!el.closest || !el.closest('.antigravity-agent-side-panel')) return false;
            if (el.closest('.monaco-editor') || el.closest('.part.editor')) return false;
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return false;

            var style = window.getComputedStyle(el);
            var overflowY = style.overflowY;
            var hasScrollbar = el.scrollHeight > (el.clientHeight + 4);
            if (!hasScrollbar) return false;

            return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
        }).sort(function (a, b) {
            return _agElementDepth(b) - _agElementDepth(a);
        });
    }

    function _agScrollElementToBottom(el) {
        var maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        var gap = maxScrollTop - el.scrollTop;
        if (gap <= 2) return false;

        try {
            el.scrollTo({ top: maxScrollTop, behavior: 'auto' });
        } catch (e) {
            el.scrollTop = maxScrollTop;
        }

        return true;
    }

    function _agGetLargestScrollGap(scrollables) {
        var maxGap = 0;
        scrollables.forEach(function (el) {
            var gap = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
            if (gap > maxGap) maxGap = gap;
        });
        return maxGap;
    }

    function _agFindJumpToBottomButton(chatPanel) {
        if (!chatPanel) return null;

        var panelRect = chatPanel.getBoundingClientRect();
        if (!panelRect || panelRect.width <= 0 || panelRect.height <= 0) return null;

        var candidates = Array.from(chatPanel.querySelectorAll('button, [role="button"]'));
        var best = null;
        var bestScore = -Infinity;

        candidates.forEach(function (btn) {
            if (!btn || btn.offsetParent === null) return;
            if (_agIsInputArea(btn)) return;
            if (btn.closest && (btn.closest('.monaco-editor') || btn.closest('.part.editor'))) return;

            var rect = btn.getBoundingClientRect();
            if (!rect || rect.width < 16 || rect.height < 16 || rect.width > 72 || rect.height > 72) return;

            var gapRight = panelRect.right - rect.right;
            var gapBottom = panelRect.bottom - rect.bottom;
            if (gapRight < -4 || gapBottom < -4) return;
            if (gapRight > 120 || gapBottom > 160) return;

            var rawText = ((btn.innerText || btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('title') || '')).trim();
            var text = rawText.replace(/\s+/g, ' ').trim();
            var lower = text.toLowerCase();
            var hasSvg = !!btn.querySelector('svg, path, [data-icon], .codicon');

            var isDownSemantic = lower === '↓' ||
                lower === '▼' ||
                lower === '⌄' ||
                /scroll|bottom|latest|new|down|jump/.test(lower);

            var isIconOnly = text.length === 0 && hasSvg;
            if (!isDownSemantic && !isIconOnly) return;

            var horizontalBias = Math.max(0, 160 - gapRight);
            var verticalBias = Math.max(0, 180 - gapBottom);
            var iconBonus = isIconOnly ? 35 : 0;
            var semanticBonus = isDownSemantic ? 55 : 0;
            var score = horizontalBias + verticalBias + iconBonus + semanticBonus;

            if (score > bestScore) {
                bestScore = score;
                best = btn;
            }
        });

        return best;
    }

    function _agClickJumpToBottomButton(btn) {
        if (!btn) return false;

        var now = Date.now();
        if (now - _agLastJumpButtonClickAt < 700) return false;

        _agLastJumpButtonClickAt = now;
        _agAutoScrollGuardUntil = now + 250;

        try {
            btn.click();
            console.log('[AG Auto] Jump-to-bottom button clicked');
        } catch (e) {
            return false;
        }

        _agContentActiveUntil = Math.max(_agContentActiveUntil, now + 1500);
        _agKickAutoScrollSoon(120);
        return true;
    }

    function _agRunAutoScrollTick() {
        _agEnsureScrollObserver();

        if (!window._agAutoEnabled) return false;
        if (!window._agScrollEnabled) return false;

        var now = Date.now();
        if (now < _agManualPauseUntil) return false;
        if (_agLastContentChange === 0 || now > _agContentActiveUntil) return false;

        var chatPanel = _agObservedChatPanel || _agGetChatPanel();
        if (!chatPanel) return false;

        var scrollables = _agCollectScrollTargets(chatPanel);
        if (scrollables.length === 0) return false;

        var scrolledAny = false;
        var largestGap = _agGetLargestScrollGap(scrollables);
        _agAutoScrollGuardUntil = now + 150;
        isAutoScrolling = true;

        try {
            if (largestGap > 48) {
                var jumpBtn = _agFindJumpToBottomButton(chatPanel);
                if (_agClickJumpToBottomButton(jumpBtn)) scrolledAny = true;
            }

            scrollables.forEach(function (el) {
                if (_agScrollElementToBottom(el)) scrolledAny = true;
            });
        } finally {
            setTimeout(function () { isAutoScrolling = false; }, 100);
        }

        return scrolledAny;
    }

    function _agStartAutoScrollLoop() {
        if (_agAutoScrollInterval) clearInterval(_agAutoScrollInterval);

        var tickMs = _agScrollTickMs();
        _agAutoScrollInterval = setInterval(function () {
            _agRunAutoScrollTick();
        }, tickMs);

        window._agToolIntervals.push(_agAutoScrollInterval);
        console.log('[AG Auto] Smart auto-scroll loop started (' + tickMs + 'ms)');
    }

    function _agRestartAutoScrollLoop() {
        _agStartAutoScrollLoop();
    }

    // Delay first port discovery to give extension time to start its server
    setTimeout(function () {
        _agDiscoverPort(function (port, cfg) {
            _agServerEverConnected = true;
            _agApplyConfig(cfg);
            _agPollErrors = 0;
            console.log('[AG Auto] Server connected — enabled=' + window._agAutoEnabled);
        });
    }, 3000);

    var _agConfigReload = setInterval(function () {
        _agPollCount++;

        if (AG_HTTP_PORT === 0) {
            var reboundPort = _agGetBoundPort();
            if (reboundPort > 0) {
                AG_HTTP_PORT = reboundPort;
            } else if (!_agServerEverConnected && _agPollCount % 5 === 0) {
                _agDiscoverPort(function (port, cfg) {
                    _agServerEverConnected = true;
                    _agApplyConfig(cfg);
                    _agPollErrors = 0;
                    console.log('[AG Auto] Initial server connected — enabled=' + window._agAutoEnabled);
                });
            }
            return;
        }

        if (_agBoundPortProvisionalUntil && Date.now() < _agBoundPortProvisionalUntil && _agPollCount % 2 === 0) {
            var _agOldPort = AG_HTTP_PORT;
            _agDiscoverPort(function (port, cfg) {
                _agServerEverConnected = true;
                _agApplyConfig(cfg);
                _agPollErrors = 0;
                console.log('[AG Auto] Provisional binding re-check settled on port ' + port + ' — enabled=' + window._agAutoEnabled);
            });
            if (AG_HTTP_PORT === 0) AG_HTTP_PORT = _agOldPort;
            return;
        }

        if (_agPollErrors > 8) {
            _agPollErrors = 0;
            // Server lost — disable auto-click until same server reconnects
            if (_agServerEverConnected) {
                window._agAutoEnabled = false;
                window._agScrollEnabled = false;
                _agReportRuntimeState({
                    acceptDegraded: true,
                    scrollDegraded: true,
                    reason: 'server-lost',
                    detail: 'HTTP poll failed repeatedly; runtime paused until reconnect.'
                });
                console.log('[AG Auto] Server lost — auto-click/scroll DISABLED until reconnect on same/bound port');
            }
            AG_HTTP_PORT = 0;
            // Immediately attempt re-discovery
            _agDiscoverPort(function (port, cfg) {
                _agServerEverConnected = true;
                _agApplyConfig(cfg);
                _agPollErrors = 0;
                console.log('[AG Auto] Server re-discovered on port ' + port + ' after loss');
            });
            // Backup retry: if immediate re-discover fails, try again after 8s
            setTimeout(function () {
                if (AG_HTTP_PORT === 0) {
                    console.log('[AG Auto] Backup retry: re-discovering after server loss...');
                    _agDiscoverPort(function (port, cfg) {
                        _agServerEverConnected = true;
                        _agApplyConfig(cfg);
                        _agPollErrors = 0;
                        console.log('[AG Auto] Backup re-discovered on port ' + port);
                    });
                }
            }, 8000);
            return;
        }

        try {
            var xhr = new XMLHttpRequest();
            var statsParam = '';
            var _agPendingStats = null;
            var _agPendingTotal = 0;

            if (_agSessionTotal > 0) {
                _agPendingStats = JSON.parse(JSON.stringify(_agSessionStats));
                _agPendingTotal = _agSessionTotal;
                statsParam = '&total=' + _agSessionTotal + '&stats=' + encodeURIComponent(JSON.stringify(_agSessionStats));
                _agSessionStats = {};
                _agSessionTotal = 0;
            }

            xhr.open('GET', 'http://127.0.0.1:' + AG_HTTP_PORT + '/ag-status?t=' + Date.now() + statsParam + '&windowKey=' + encodeURIComponent(_agWindowBindingKey) + '&startedAt=' + _agWindowStartedAt, true);
            xhr.timeout = 1500;
            xhr.onload = function () {
                if (xhr.status === 200) {
                    try {
                        var cfg = JSON.parse(xhr.responseText);
                    } catch (parseErr) {
                        // Malformed JSON (truncated response, server restart mid-write, etc.)
                        // Treat as a soft error — don't reset _agPollErrors, roll back pending stats
                        _agPollErrors++;
                        if (_agPendingStats) { for (var rk in _agPendingStats) { if (!_agSessionStats[rk]) _agSessionStats[rk] = 0; _agSessionStats[rk] += _agPendingStats[rk]; } _agSessionTotal += _agPendingTotal; }
                        console.log('[AG Auto] Poll JSON parse error (port ' + AG_HTTP_PORT + '): ' + (parseErr.message || parseErr));
                        return;
                    }
                    _agPollErrors = 0;
                    _agServerEverConnected = true;
                    if (cfg && cfg.bindRejected) {
                        _agBindRejectRetries++;
                        var retryDelaySec = Math.min(_agBindRejectRetries * 5, 30);
                        console.log('[AG Auto] Bind rejected by port ' + AG_HTTP_PORT + ' (' + (cfg.rejectReason || 'unknown') + ') — retry #' + _agBindRejectRetries + ' in ' + retryDelaySec + 's');
                        _agReportRuntimeState({
                            acceptDegraded: true,
                            scrollDegraded: true,
                            reason: 'bind-rejected',
                            detail: String(cfg.rejectReason || 'unknown') + ' (retry #' + _agBindRejectRetries + ' in ' + retryDelaySec + 's)'
                        });
                        AG_HTTP_PORT = 0;
                        window._agAutoEnabled = false;
                        window._agScrollEnabled = false;
                        // Auto-recover: retry discovery after delay
                        setTimeout(function () {
                            _agDiscoverPort(function (port, newCfg) {
                                _agServerEverConnected = true;
                                _agApplyConfig(newCfg);
                                _agPollErrors = 0;
                                _agBindRejectRetries = 0;
                                console.log('[AG Auto] Recovered after bind rejection on port ' + port);
                            });
                        }, retryDelaySec * 1000);
                        return;
                    }
                    _agApplyConfig(cfg);
                    if (_agPollCount <= 2) {
                        console.log('[AG Auto] HTTP poll #' + _agPollCount + ' OK on port ' + AG_HTTP_PORT + ', enabled=' + window._agAutoEnabled + ', patterns=' + CLICK_PATTERNS.length);
                    }
                    // Stay bound to this port for this window runtime
                    // Do not scan to other ports after initial connect
                }
            };
            xhr.onerror = function () {
                _agPollErrors++;
                if (_agPendingStats) { for (var k in _agPendingStats) { if (!_agSessionStats[k]) _agSessionStats[k] = 0; _agSessionStats[k] += _agPendingStats[k]; } _agSessionTotal += _agPendingTotal; }
            };
            xhr.ontimeout = function () {
                _agPollErrors++;
                if (_agPendingStats) { for (var k in _agPendingStats) { if (!_agSessionStats[k]) _agSessionStats[k] = 0; _agSessionStats[k] += _agPendingStats[k]; } _agSessionTotal += _agPendingTotal; }
            };
            xhr.send();
        } catch (e) {
            _agPollErrors++;
            if (_agPollCount <= 3) console.log('[AG Auto] HTTP poll #' + _agPollCount + ' error:', e.message);
        }
    }, 2000);
    window._agToolIntervals.push(_agConfigReload);

    var REJECT_WORDS = ['Reject', 'Deny', 'Cancel', 'Dismiss', 'Don\'t Allow', 'Decline', 'Discard', 'Discard Changes', 'No'];
    var EDITOR_SKIP_WORDS = ['Accept Changes', 'Accept All', 'Accept Incoming', 'Accept Current', 'Accept Both', 'Accept Combination'];
    var _clicked = new Map();
    var _clickedGcTimer = setInterval(function () {
        var now = Date.now();
        var expired = [];
        _clicked.forEach(function (ts, el) { if (now - ts > 30000) expired.push(el); });
        expired.forEach(function (el) { _clicked.delete(el); });
    }, 15000);
    window._agToolIntervals.push(_clickedGcTimer);

    function _agNormalizeButtonText(rawText) {
        // Strip keyboard shortcut suffixes like "RunAlt+Enter", "AllowCtrl+Shift+A"
        // Common patterns: Alt+X, Ctrl+X, Shift+X, ⌘+X, and combinations
        return rawText.replace(/(?:Alt|Ctrl|Shift|Cmd|⌘|⌥|⇧)\+.*/i, '').replace(/\s+/g, ' ').trim();
    }

    function _agIsInsideAgentPanel(el) {
        if (!el || !el.closest) return false;
        return !!(el.closest('.antigravity-agent-side-panel') ||
            el.closest('[class*="agent"]') ||
            el.closest('[class*="chat-widget"]') ||
            el.closest('[class*="interactive-session"]') ||
            el.closest('.chat-input-toolbars') ||
            el.closest('[class*="tool-confirmation"]') ||
            el.closest('[class*="confirmation-widget"]') ||
            el.closest('[class*="terminal-command"]') ||
            el.closest('[class*="tool-invocation"]') ||
            el.closest('[class*="tool-call"]') ||
            el.closest('[class*="approval"]') ||
            el.closest('[class*="permission"]') ||
            el.closest('[class*="confirm"]') ||
            el.closest('[class*="chat-panel"]') ||
            el.closest('[class*="chat-response"]') ||
            el.closest('[class*="chat-message"]') ||
            el.closest('[class*="step-widget"]'));
    }

    function _agIsInsidePermissionCard(el) {
        var parent = el && el.parentElement;
        for (var level = 0; level < 10; level++) {
            if (!parent) break;
            var txt = (parent.innerText || parent.textContent || '').replace(/\s+/g, ' ').trim();
            if (/Agent\s+needs\s+permission\s+to\s+execute\s+JavaScript\s+on/i.test(txt)) return true;
            if (/Always\s+run/i.test(txt) && /\bDeny\b/i.test(txt) && /\bAllow\b/i.test(txt)) return true;
            parent = parent.parentElement;
        }
        return false;
    }

    function _agHasDenySibling(btn, maxLevels) {
        // Search up to N levels for a sibling reject/deny button
        var parent = btn.parentElement;
        for (var level = 0; level < (maxLevels || 8); level++) {
            if (!parent) break;

            var siblingBtns = parent.querySelectorAll('button, a.action-label, [role="button"], .monaco-button, span.bg-ide-button-background, [class*="secondary"], [class*="cancel"], [class*="deny"], [class*="reject"]');
            for (var i = 0; i < siblingBtns.length; i++) {
                var sibling = siblingBtns[i];
                if (sibling === btn) continue;

                var siblingRaw = (sibling.innerText || sibling.textContent || sibling.getAttribute && (sibling.getAttribute('aria-label') || sibling.getAttribute('title')) || '').trim();
                var siblingText = _agNormalizeButtonText(siblingRaw);
                for (var j = 0; j < REJECT_WORDS.length; j++) {
                    if (siblingText === REJECT_WORDS[j] || siblingText.indexOf(REJECT_WORDS[j]) === 0 ||
                        siblingRaw === REJECT_WORDS[j] || siblingRaw.indexOf(REJECT_WORDS[j]) === 0) {
                        return true;
                    }
                }
            }

            parent = parent.parentElement;
        }
        return false;
    }

    function isApprovalButton(btn) {
        // Fast path: if button is inside the agent/chat panel, it's safe to click
        if (_agIsInsideAgentPanel(btn) || _agIsInsidePermissionCard(btn)) {
            return true;
        }

        // Key fix: if this button has a Deny/Reject sibling nearby, it's an approval button
        // regardless of where it is in the DOM (editor area, side panel, etc.)
        if (_agHasDenySibling(btn, 8)) {
            return true;
        }

        return false;
    }

    if (!window._agClickStats) window._agClickStats = {};
    if (!window._agTotalClicks) window._agTotalClicks = 0;

    var _agAutoClickInterval = 0;
    var _agLastChoiceClickedTime = 0;

    function _agHandleMultipleChoicePermissions() {
        if (Date.now() - _agLastChoiceClickedTime < 2000) {
            return false;
        }

        // STRATEGY: Find a visible Submit button — that's the most reliable signal
        // that a permission dialog is open. Then find the best positive option near it.
        var allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
        var submitBtn = null;
        for (var j = 0; j < allBtns.length; j++) {
            var btnTxt = (allBtns[j].innerText || allBtns[j].textContent || '').trim();
            if (/^Submit/i.test(btnTxt) && allBtns[j].offsetParent !== null) {
                submitBtn = allBtns[j];
                break;
            }
        }
        if (!submitBtn) return false;

        // Walk up from Submit button to find the dialog container
        var dialogContainer = submitBtn;
        for (var up = 0; up < 8; up++) {
            if (dialogContainer.parentElement) dialogContainer = dialogContainer.parentElement;
        }

        // Priority order: prefer "always allow" before "allow this time"
        var positivePatterns = [
            /Yes,\s+and\s+always\s+allow/i,
            /Yes,\s+always\s+allow/i,
            /Always\s+allow/i,
            /Yes,\s+allow\s+this\s+time/i,
            /Yes,\s+allow/i,
            /Allow\s+this\s+time/i,
            /Allow\s+once/i,
            /Yes,\s+approve/i,
            /Approve/i,
            /Yes/i
        ];

        // Search for options inside the dialog container
        var candidates = Array.from(dialogContainer.querySelectorAll('*'));
        var foundOption = null;
        var matchedPatternIndex = 999;

        for (var i = 0; i < candidates.length; i++) {
            var cel = candidates[i];
            if (cel === submitBtn) continue;
            if (cel.children.length > 4) continue;
            var ctxt = (cel.innerText || cel.textContent || '').trim();
            if (!ctxt || ctxt.length < 2 || ctxt.length > 80) continue;
            for (var p = 0; p < positivePatterns.length; p++) {
                if (p >= matchedPatternIndex) break;
                if (positivePatterns[p].test(ctxt)) {
                    foundOption = cel;
                    matchedPatternIndex = p;
                    break;
                }
            }
        }

        if (!foundOption) {
            // Fallback: just click Submit directly (option 1 may already be pre-selected)
            console.log('[AG Auto] Submit found but no option — clicking Submit directly');
            _agLastChoiceClickedTime = Date.now();
            submitBtn.click();
            return true;
        }

        var optText = (foundOption.innerText || foundOption.textContent || '').trim();
        console.log('[AG Auto] Permission dialog — selecting:', optText);
        _agLastChoiceClickedTime = Date.now();

        // Click the option to select it
        foundOption.click();
        try {
            foundOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            foundOption.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        } catch (e) {}

        // Click Submit after 300ms
        setTimeout(function () {
            // Re-find Submit in case DOM changed
            var btns2 = Array.from(document.querySelectorAll('button, [role="button"]'));
            var sub2 = null;
            for (var k = 0; k < btns2.length; k++) {
                var t2 = (btns2[k].innerText || btns2[k].textContent || '').trim();
                if (/^Submit/i.test(t2) && btns2[k].offsetParent !== null) {
                    sub2 = btns2[k];
                    break;
                }
            }
            var finalSubmit = sub2 || submitBtn;
            console.log('[AG Auto] Clicking Submit after option select');
            finalSubmit.click();
            try {
                var logXhr = new XMLHttpRequest();
                logXhr.open('POST', 'http://127.0.0.1:' + AG_HTTP_PORT + '/api/click-log', true);
                logXhr.setRequestHeader('Content-Type', 'application/json');
                logXhr.timeout = 3000;
                logXhr.send(JSON.stringify({
                    button: optText.substring(0, 80) + ' → Submit',
                    pattern: 'Permission Dialog'
                }));
            } catch (e) {}
        }, 300);

        return true;
    }

    function _agStartClickLoop() {
        if (_agAutoClickInterval) clearInterval(_agAutoClickInterval);

        var tickMs = _agClampMs(CLICK_INTERVAL_MS, 1000, 100, 120000);
        _agAutoClickInterval = setInterval(function () {
        if (!window._agAutoEnabled) return;

        if (_agHandleMultipleChoicePermissions()) {
            return;
        }

        var clickables = Array.from(document.querySelectorAll('button, a.action-label, [role="button"], .monaco-button, span.bg-ide-button-background, [class*="ide-button"]'));
        document.querySelectorAll('span.cursor-pointer').forEach(function (span) { clickables.push(span); });

        var targetBtn = null;
        var matchedPattern = '';

        for (var i = 0; i < clickables.length; i++) {
            var btn = clickables[i];
            if (btn.offsetParent === null) continue;
            if (_clicked.has(btn) && (Date.now() - _clicked.get(btn)) < 30000) continue;

            var rawText = (btn.innerText || btn.textContent || btn.getAttribute && (btn.getAttribute('aria-label') || btn.getAttribute('title')) || '').trim();
            if (!rawText || rawText.length > 120) continue;
            // Never click VS Code navigation/activity controls such as "Run and Debug".
            // They can expose aria-label/title text that starts with "Run" and would
            // otherwise be mistaken for the chat approval Run button.
            if (/^Run\s+and\s+Debug\b/i.test(rawText)) continue;
            if (btn.closest && (
                btn.closest('.activitybar') ||
                btn.closest('.part.activitybar') ||
                btn.closest('[id*="workbench.parts.activitybar"]') ||
                btn.closest('.composite-bar') ||
                btn.closest('.pane-composite-part') ||
                btn.closest('[aria-label="Activity Bar"]')
            )) continue;
            // Normalize: strip keyboard shortcut suffixes (e.g., "RunAlt+Enter" → "Run")
            var text = _agNormalizeButtonText(rawText);
            if (!text) continue;

            // Check if text matches any configured pattern
            var matchesPattern = false;
            for (var p = 0; p < CLICK_PATTERNS.length; p++) {
                var pattern = CLICK_PATTERNS[p];
                if (text === pattern || text.indexOf(pattern) === 0 || rawText === pattern || rawText.indexOf(pattern) === 0) {
                    matchesPattern = true;
                    matchedPattern = pattern;
                    break;
                }
            }
            if (!matchesPattern) continue;

            // Check click limit for this pattern
            var limit = CLICK_LIMITS[matchedPattern];
            if (limit && limit > 0) {
                var currentCount = _agPatternClickCounts[matchedPattern] || 0;
                console.log('[AG Auto] Limit check: ' + matchedPattern + ' count=' + currentCount + '/' + limit);
                if (currentCount >= limit) {
                    console.log('[AG Auto] BLOCKED by limit: ' + matchedPattern);
                    continue; // Skip — limit reached for this pattern
                }
            }

            // PRIORITY CHECK: If this is an Allow/Deny pair, click it immediately
            // regardless of editor ancestor — this is the key fix for Allow buttons
            // that appear inside editor-like containers
            if (_agHasDenySibling(btn, 8)) {
                targetBtn = btn;
                console.log('[AG Auto] Priority match: ' + matchedPattern + ' with Deny sibling');
                break;
            }

            var skipEditor = false;
            for (var se = 0; se < EDITOR_SKIP_WORDS.length; se++) {
                if (text.indexOf(EDITOR_SKIP_WORDS[se]) === 0 || rawText.indexOf(EDITOR_SKIP_WORDS[se]) === 0) {
                    skipEditor = true;
                    break;
                }
            }
            if (skipEditor) continue;

            if (btn.closest && (
                btn.closest('.monaco-diff-editor') ||
                btn.closest('.merge-editor-view') ||
                btn.closest('.inline-merge-region') ||
                btn.closest('.merged-editor') ||
                btn.closest('.view-zones') ||
                btn.closest('.view-lines') ||
                btn.closest('.statusbar') ||
                btn.closest('.part.statusbar') ||
                btn.closest('[id*="workbench.parts.statusbar"]')
            )) continue;

            // Relaxed editor check: only skip if inside editor AND not an approval context
            if (btn.closest && btn.closest('[id*="workbench.parts.editor"]')) {
                if (!isApprovalButton(btn)) continue;
            }

            if (btn.classList && (btn.classList.contains('diff-hunk-button') || btn.classList.contains('accept') || btn.classList.contains('revert'))) {
                var editorAncestor = btn.closest && btn.closest('[class*="editor"], [id*="editor"]');
                if (editorAncestor && !_agHasDenySibling(btn, 4)) continue;
            }

            if (btn.tagName === 'SPAN' && btn.classList.contains('cursor-pointer')) {
                targetBtn = btn;
                break;
            }

            if (isApprovalButton(btn)) {
                targetBtn = btn;
                break;
            }
        }

        if (!targetBtn && window._agAcceptChatOnly) {
            // Check Accept limit before scanning
            var acceptLimit = CLICK_LIMITS['Accept'];
            var acceptCount = _agPatternClickCounts['Accept'] || 0;
            var acceptBlocked = acceptLimit && acceptLimit > 0 && acceptCount >= acceptLimit;
            if (!acceptBlocked) {
                for (var ai = 0; ai < clickables.length; ai++) {
                    var acceptBtn = clickables[ai];
                    if (acceptBtn.offsetParent === null) continue;
                    if (_clicked.has(acceptBtn) && (Date.now() - _clicked.get(acceptBtn)) < 30000) continue;

                    var acceptText = (acceptBtn.innerText || acceptBtn.textContent || '').trim();
                    if (acceptText.indexOf('Accept') !== 0) continue;
                    if (/^Accept\s+(all|changes|incoming|current|both|combination|on|off)/i.test(acceptText)) continue;

                    if (acceptBtn.closest && (
                        acceptBtn.closest('.editor-scrollable') ||
                        acceptBtn.closest('.monaco-diff-editor') ||
                        acceptBtn.closest('.view-zones') ||
                        acceptBtn.closest('.merge-editor-view')
                    )) {
                        if (!_agHasDenySibling(acceptBtn, 4)) {
                            console.log('[AG Auto] Blocked Accept inside editor (no deny sibling): [' + acceptText.substring(0, 20) + ']');
                            continue;
                        }
                    }

                    if (acceptBtn.classList && (acceptBtn.classList.contains('diff-hunk-button') || acceptBtn.classList.contains('revert'))) {
                        console.log('[AG Auto] Blocked Accept diff-hunk: [' + acceptText.substring(0, 20) + ']');
                        continue;
                    }

                    targetBtn = acceptBtn;
                    matchedPattern = 'Accept';
                    console.log('[AG Auto] Accept clicked in chat: [' + acceptText.substring(0, 25) + ']');
                    break;
                }
            }
        }

        if (targetBtn) {
            var rawClickedText = (targetBtn.innerText || targetBtn.textContent || '').trim();
            if (matchedPattern === 'Allow' && /^Allow\s+in\s+Workspace/i.test(rawClickedText)) {
                matchedPattern = 'Allow in Workspace';
            }
            if (matchedPattern !== 'Continue') {
                try {
                    var logXhr = new XMLHttpRequest();
                    logXhr.open('POST', 'http://127.0.0.1:' + AG_HTTP_PORT + '/api/click-log', true);
                    logXhr.setRequestHeader('Content-Type', 'application/json');
                    logXhr.timeout = 3000;
                    logXhr.send(JSON.stringify({
                        button: rawClickedText.substring(0, 100),
                        pattern: matchedPattern
                    }));
                } catch (e) { }
            }

            // (duplicate canonicalize removed — already handled above)

            console.log('[AG Auto] Click: [' + targetBtn.innerText.trim() + ']');
            _clicked.set(targetBtn, Date.now());
            targetBtn.click();

            _agSessionTotal++;
            if (!_agSessionStats[matchedPattern]) _agSessionStats[matchedPattern] = 0;
            _agSessionStats[matchedPattern]++;

            // Track click count for limits
            if (!_agPatternClickCounts[matchedPattern]) _agPatternClickCounts[matchedPattern] = 0;
            _agPatternClickCounts[matchedPattern]++;
            var patLimit = CLICK_LIMITS[matchedPattern];
            if (patLimit && patLimit > 0 && _agPatternClickCounts[matchedPattern] >= patLimit) {
                console.log('[AG Auto] Limit reached for ' + matchedPattern + ': ' + _agPatternClickCounts[matchedPattern] + '/' + patLimit);
            }

            window._agTotalClicks++;
            if (!window._agClickStats[matchedPattern]) window._agClickStats[matchedPattern] = 0;
            window._agClickStats[matchedPattern]++;
        }
    }, tickMs);
        window._agToolIntervals.push(_agAutoClickInterval);
        console.log('[AG Auto] Click loop started (' + tickMs + 'ms)');
    }

    function _agRestartClickLoop() {
        console.log('[AG Auto] Click interval changed to ' + CLICK_INTERVAL_MS + 'ms — restarting click loop');
        _agStartClickLoop();
    }

    _agStartClickLoop();

    function _agStartScrollObserver() {
        _agEnsureScrollObserver();
        if (_agObserverWatchdog) return;

        _agObserverWatchdog = setInterval(function () {
            _agEnsureScrollObserver();
        }, 1500);

        window._agToolIntervals.push(_agObserverWatchdog);
    }

    _agStartScrollObserver();

    window._agScrollListener = function (e) {
        if (!e.isTrusted) return;
        if (isAutoScrolling && Date.now() < _agAutoScrollGuardUntil) return;
        if (!_agIsInsideChatPanel(e.target)) return;

        _agManualPauseUntil = Date.now() + _agScrollPauseWindowMs();
    };
    window.addEventListener('scroll', window._agScrollListener, true);

    _agStartAutoScrollLoop();
    console.log('[AG Auto] smart scroll ready | Patterns:', JSON.stringify(CLICK_PATTERNS));
})();
