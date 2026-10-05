(function() {
    'use strict';

    /* ================================================================
     * Sov 前端 — 已接入 sov-serverside 后端（Docker :8443）
     * ----------------------------------------------------------------
     * 后端：GitHub BKYJX/sov-serverside（Go，单进程单群组，文件存储）
     * 认证：请求头 X-User-Id + X-Password（明文比对 bcrypt，生产应置于 HTTPS 后）
     * 消息：POST /chat/send  +  GET /chat/messages?date=YYYY-MM-DD&since=<unix秒>
     * 消息行格式：timestamp|senderId|ciphertext|encryptedKeysJson
     *   - ciphertext 为 Opaque 字符串，服务器不解码；
     *   - 当前客户端约定 ciphertext = base64(JSON({v:1, content:文本}))，
     *     属于传输占位。真正 E2EE（公钥加密 + encryptedKeys 密钥分发）待后续实现。
     * 轮询：每 3 秒增量拉取 since=最后一条时间戳，行级 id 去重。
     * ================================================================ */
        const CONFIG = {
        channel: {
            name: 'general',
            tag: '动态测试',
        },
        api: {
            // 自动跟随页面来源 host：页面在 10.66.1.98:80，后端同机 8443
            get baseUrl() { return location.protocol + '//' + location.hostname; },
            endpoints: {
                health: '/health',
                list: '/chat/messages',
                send: '/chat/send',
                members: '/members/list',
                // 管理接口（管理员/版主）
                setRole: '/admin/set-role',
                adminGive: '/admin/give',
                adminRoles: '/admin/roles',
                adminCmd: '/admin/cmd',
                // 审批（管理员/版主）
                approve: '/members/approve',
                reject: '/members/reject',
                pending: '/members/pending',
                // 账号与登录
                register: '/auth/register',
                login: '/auth/login',
                logout: '/auth/logout',
                me: '/auth/me',
            }
        },
        pollInterval: 3000, // 轮询间隔（ms）
        // 登录态在 localStorage 中的键名：只保存会话令牌与展示信息，永不保存密码
        sessionKey: 'sov-session',
    };

    // 当前登录态（由 /auth/register、/auth/login、/auth/me 填充）
    const session = {
        token: '',
        userId: '',
        displayName: '',
        avatar: '?',
        isAdmin: false,
        isMod: false,
        isMember: false,
        expiresAt: 0,
        group: null,
    };

    /* ===== 元素引用 ===== */
    const messageArea  = document.getElementById('messageArea');
    const emptyState   = document.getElementById('emptyState');
    const msgInput     = document.getElementById('msgInput');   // textarea
    const sendBtn      = document.getElementById('sendBtn');
    const memberList   = document.getElementById('memberList');
        const memberCount  = document.getElementById('memberCount');
    const channelItems = document.querySelectorAll('.sidebar-item[data-channel]');

    /* ===== 登录 / 注册 元素引用 ===== */
    const authOverlay    = document.getElementById('authOverlay');
    const authForm       = document.getElementById('authForm');
    const authTabs       = document.querySelectorAll('.auth-tab');
    const authUserId     = document.getElementById('authUserId');
    const authPassword   = document.getElementById('authPassword');
    const authConfirm    = document.getElementById('authConfirm');
    const authDisplayName= document.getElementById('authDisplayName');
    const authDisplayRow = document.getElementById('authDisplayRow');
    const authConfirmRow = document.getElementById('authConfirmRow');
    const authError      = document.getElementById('authError');
    const authNote       = document.getElementById('authNote');
    const authSubmit     = document.getElementById('authSubmit');
    const authGroupInfo  = document.getElementById('authGroupInfo');
    const authHint       = document.getElementById('authHint');
    const userChip       = document.getElementById('userChip');
    const userChipName   = document.getElementById('userChipName');
    const userChipAvatar = document.getElementById('userChipAvatar');
    const logoutBtn      = document.getElementById('logoutBtn');
    const toastBox       = document.getElementById('toast');

    /* ===== 数据 ===== */
    let messages = [];
    const receivedIds = new Set();  // 已显示消息的行 id（去重）
    const pendingSent = [];         // 本地已乐观渲染、待后端确认的消息 { localId, senderId, ciphertext }
        const members = new Map();      // userId -> { avatar, role, displayName, status }
    let lastPollTs = 0;             // 轮询增量起点（Unix 秒）
    let authMode = 'login';         // 登录卡片模式：login | register
    let pollTimer = null;           // 轮询定时器句柄
    let groupInfo = null;           // /health 返回的群组概况（群名 / 人数 / 是否公开）

    /* ===== 工具函数 ===== */

    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, function(ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    // 行内 Markdown（输入须已转义）。行内代码与链接先占位，避免被加粗/斜体/@提及二次处理
    function renderInlineMarkdown(line) {
        const stash = [];
        const keep = function(html) {
            stash.push(html);
            return '\u0000' + (stash.length - 1) + '\u0000';
        };
        let s = line.replace(/`([^`\n]+)`/g, function(_, code) {
            return keep('<code>' + code + '</code>');
        });
        s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, function(all, label, url) {
            // 仅放行 http/https/mailto/相对链接，其余按原样显示（防 javascript: XSS）
            if (!/^(https?:\/\/|mailto:|\/|#)/i.test(url)) return all;
            return keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
        });
        // 行内数学 $...$：占位保护，先于加粗/斜体；KaTeX 渲染，未加载/抛错时回退原文
        s = s.replace(/\$([^$\s](?:[^$\n]*[^$\s])?)\$(?!\$)/g, function(_, tex) {
            return keep(renderMath(tex, false));
        });
        s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '<em>$1</em>');
        // @提及仅高亮真实存在的成员或 所有人，否则按普通文本渲染
        s = s.replace(/@([\w\u4e00-\u9fa5_-]+)/g, function(all, name) {
            if (name === '所有人' || members.has(name)) return '<span class="mention">@' + name + '</span>';
            return all;
        });
        return s.replace(/\u0000(\d+)\u0000/g, function(_, i) { return stash[+i]; });
    }

    // 数学公式：KaTeX 离线渲染（无 CDN）；katex 未加载或抛错时回退为原样占位。
    // 入参 latex 来自已转义的文本，回退时直接使用，避免二次转义。
    function renderMath(latex, displayMode) {
        var inner;
        try {
            if (typeof katex === 'undefined') throw new Error('katex 未加载');
            inner = katex.renderToString(latex, { throwOnError: false, displayMode: displayMode });
        } catch (e) {
            inner = latex;
        }
        return displayMode
            ? '<div class="math-block">' + inner + '</div>'
            : '<span class="math-inline">' + inner + '</span>';
    }

    // 渲染消息文本：先转义（防 XSS），再按行解析块级 Markdown（``` 代码块、- / 1. 列表），
    // 行内语法（**粗体**、*斜体*、`代码`、[链接](url)、@提及）见 renderInlineMarkdown。
    // 换行依赖 .msg-text 的 white-space: pre-wrap，块级元素前后不输出多余换行。
    function renderContent(text) {
        const lines = escapeHtml(text).split('\n');
        const ulRe = /^\s*-\s+/;
        const olRe = /^\s*\d+\.\s+/;
        const fenceRe = /^\s*```/;
        const hRe = /^(#{1,5})\s+(.+)$/;             // 标题：# + 空格（#tag 不算标题）
        const mathOpenRe = /^\s*\$\$\s*$/;           // 多行公式定界：整行 $$
        const mathSingleRe = /^\s*\$\$(.+)\$\$\s*$/; // 单行公式：整行 $$...$$
        let html = '';
        let run = []; // 普通行缓冲，用 \n 连接
        const flushRun = function() {
            if (run.length) { html += run.join('\n'); run = []; }
        };
        let i = 0;
        while (i < lines.length) {
            if (fenceRe.test(lines[i])) {
                flushRun();
                const buf = [];
                i++;
                while (i < lines.length && !fenceRe.test(lines[i])) { buf.push(lines[i]); i++; }
                i++; // 跳过收尾 ```（无则到文本末尾）
                html += '<pre><code>' + buf.join('\n') + '</code></pre>';
            } else if (mathOpenRe.test(lines[i])) {
                // 多行块公式：$$ ... $$，KaTeX 渲染，未加载/抛错时回退原文
                flushRun();
                const buf = [];
                i++;
                while (i < lines.length && !mathOpenRe.test(lines[i])) { buf.push(lines[i]); i++; }
                i++; // 跳过收尾 $$（无则到文本末尾）
                html += renderMath(buf.join('\n'), true);
            } else if (mathSingleRe.test(lines[i])) {
                // 单行块公式：$$...$$
                flushRun();
                html += renderMath(lines[i].replace(mathSingleRe, '$1'), true);
                i++;
            } else if (hRe.test(lines[i])) {
                // 标题 # ~ #####，内容仍走行内渲染（粗体/斜体/代码/链接/@提及）
                flushRun();
                const h = lines[i].match(hRe);
                html += '<h' + h[1].length + '>' + renderInlineMarkdown(h[2]) + '</h' + h[1].length + '>';
                i++;
            } else if (ulRe.test(lines[i]) || olRe.test(lines[i])) {
                flushRun();
                const ordered = olRe.test(lines[i]);
                const itemRe = ordered ? olRe : ulRe;
                const items = [];
                while (i < lines.length && itemRe.test(lines[i])) {
                    items.push('<li>' + renderInlineMarkdown(lines[i].replace(itemRe, '')) + '</li>');
                    i++;
                }
                html += ordered ? '<ol>' + items.join('') + '</ol>' : '<ul>' + items.join('') + '</ul>';
            } else {
                run.push(renderInlineMarkdown(lines[i]));
                i++;
            }
        }
        flushRun();
        return html;
    }

    function formatTime(date) {
        const h = date.getHours();
        const m = date.getMinutes();
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        const mm = String(m).padStart(2, '0');
        return (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear() +
               ' ' + h12 + ':' + mm + ' ' + ampm;
    }

    function formatDate(date) {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const diffDays = Math.round((today - msgDay) / 86400000);
        if (diffDays === 0) return '今天';
        if (diffDays === 1) return '昨天';
        return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + date.getFullYear();
    }

    function isSameDay(a, b) {
        return a && b &&
            a.getFullYear() === b.getFullYear() &&
            a.getMonth() === b.getMonth() &&
            a.getDate() === b.getDate();
    }

        function formatDateKey(date) {
        return date.getFullYear() + '-' +
               String(date.getMonth() + 1).padStart(2, '0') + '-' +
               String(date.getDate()).padStart(2, '0');
    }

    /* ===== 登录态本地存储（只存令牌与展示信息） ===== */

    function saveSession() {
        try {
            localStorage.setItem(CONFIG.sessionKey, JSON.stringify({
                token: session.token,
                userId: session.userId,
                displayName: session.displayName,
                expiresAt: session.expiresAt || 0,
            }));
        } catch (e) {}
    }

    function readStoredSession() {
        try {
            const raw = localStorage.getItem(CONFIG.sessionKey);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            return (obj && obj.token) ? obj : null;
        } catch (e) {
            return null;
        }
    }

    function clearStoredSession() {
        try { localStorage.removeItem(CONFIG.sessionKey); } catch (e) {}
    }

    // 用后端返回的身份数据填充本地登录态
    function applyIdentity(data) {
        if (data.token) session.token = data.token;
        if (data.user) {
            session.userId = data.user.userId || session.userId;
            session.displayName = data.user.displayName || data.user.userId || session.userId;
        }
        session.isAdmin = !!data.isAdmin;
        session.isMod = !!data.isMod;
        session.isMember = !!data.isMember;
        session.group = data.group || session.group;
        session.expiresAt = data.expiresAt || 0;
    }

    /* ===== 轻提示（替代只写 console 的失败反馈） ===== */

    let toastTimer = null;
    function toast(message, kind) {
        if (!toastBox) return;
        toastBox.textContent = message;
        toastBox.className = 'toast show' + (kind ? ' toast-' + kind : '');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function() { toastBox.className = 'toast'; }, 4200);
    }

    /* ===== 后端通信 ===== */

        // 统一的接口调用封装：自动附带会话令牌，统一解析 JSON 与错误。
    // options.authEndpoint=true 表示"这个请求本身就是在登录/注册"，其 401 由调用方展示。
    async function apiFetch(path, options) {
        const opts = options || {};
        const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        if (session.token) {
            headers['Authorization'] = 'Bearer ' + session.token;
        } else if (opts.credentials) {
            // 兼容后端旧的无状态鉴权方式（当前前端默认走会话令牌）
            headers['X-User-Id'] = opts.credentials.userId;
            headers['X-Password'] = opts.credentials.password;
        }

        let res;
        try {
            res = await fetch(CONFIG.api.baseUrl + path, Object.assign({}, opts, { headers: headers }));
        } catch (e) {
            const err = new Error('无法连接后端服务（' + CONFIG.api.baseUrl + '），请确认 sov-serverside 已启动');
            err.network = true;
            throw err;
        }

        let data = {};
        const text = await res.text();
        if (text) {
            try { data = JSON.parse(text); } catch (e) { data = {}; }
        }
        if (res.status === 401) {
            // 会话失效：清理登录态并回到登录界面
            if (session.token && !opts.authEndpoint) handleSessionExpired();
            throw new Error(data.error || '登录状态已失效，请重新登录');
        }
        if (!res.ok || data.success === false) {
            throw new Error(data.error || ('HTTP ' + res.status));
        }
        return data;
    }

    // 明文打包为 ciphertext（传输占位；真 E2EE 待实现）
    function encodePayload(text) {
        const json = JSON.stringify({ v: 1, content: text });
        return btoa(unescape(encodeURIComponent(json)));
    }

    function decodePayload(ciphertext) {
        try {
            const json = decodeURIComponent(escape(atob(ciphertext)));
            const obj = JSON.parse(json);
            return (obj && obj.v === 1) ? (obj.content || '') : null;
        } catch (e) {
            return null;
        }
    }

    // 解析后端消息行：timestamp|senderId|ciphertext|encryptedKeysJson
    function parseMessageLine(line) {
        const idx1 = line.indexOf('|');
        if (idx1 <= 0) return null;
        const ts = parseInt(line.slice(0, idx1), 10);
        if (isNaN(ts)) return null;
        const rest = line.slice(idx1 + 1);
        const idx2 = rest.indexOf('|');
        if (idx2 <= 0) return null;
        const rest2 = rest.slice(idx2 + 1);
        // ciphertext 为第三个 | 之前的部分（尾部的 encryptedKeysJson 当前前端不使用，忽略）
        const idx3 = rest2.indexOf('|');
        const ciphertext = idx3 === -1 ? rest2 : rest2.slice(0, idx3);
        return {
            ts: ts,
            senderId: rest.slice(0, idx2),
            ciphertext: ciphertext,
        };
    }

    // 行消息的唯一 id（同秒同人同内容视为同一条）
    function lineId(parsed) {
        return parsed.ts + '-' + parsed.senderId + '-' + parsed.ciphertext.slice(0, 32);
    }

    // 处理一条后端消息行：去重 → 跳过本地已发送 → 接收渲染
    function ingestLine(line) {
        const parsed = parseMessageLine(line);
        if (!parsed) return;
        const id = lineId(parsed);
        if (receivedIds.has(id)) return;

        // 本地刚发送成功的消息（乐观渲染过）：跳过并移除缓存
        const dupIdx = pendingSent.findIndex(function(p) {
            return p.senderId === parsed.senderId && p.ciphertext === parsed.ciphertext;
        });
        if (dupIdx !== -1) {
            pendingSent.splice(dupIdx, 1);
            receivedIds.add(id);
            if (parsed.ts > lastPollTs) lastPollTs = parsed.ts;
            return;
        }

        const content = decodePayload(parsed.ciphertext);
        if (content == null) return; // 无法解析的密文跳过（如其他客户端 E2EE 消息）

                const msg = receiveMessage({
            id: id,
            username: parsed.senderId,
            displayName: displayNameOf(parsed.senderId),
            avatar: parsed.senderId.charAt(0).toUpperCase(),
            content: content,
            timestamp: new Date(parsed.ts * 1000),
        });
        if (msg && parsed.ts > lastPollTs) lastPollTs = parsed.ts;
    }

    // 拉取历史 + 增量轮询共用的请求
    async function fetchMessages(since) {
        const path = CONFIG.api.endpoints.list + '?date=' + formatDateKey(new Date()) +
                     (since > 0 ? '&since=' + since : '');
        const data = await apiFetch(path);
        (data.messages || []).forEach(ingestLine);
    }

    /* ===== 渲染 ===== */

    function isContinued(prev, cur) {
        return !!(prev && prev.username === cur.username);
    }

    function messageTemplate(m, opts) {
        const continued = opts && opts.continued;
        const roleHtml = (!continued && m.role)
            ? '<span class="role-badge">' + escapeHtml(m.role) + '</span>'
            : '';
        const headerHtml = continued ? '' :
            '<div class="msg-header">' +
                                '<span class="msg-username">' + escapeHtml(m.displayName || m.username) + roleHtml + '</span>' +
                '<span class="msg-timestamp">' + escapeHtml(m.timestampText || '') + '</span>' +
            '</div>';
        return '' +
            '<div class="message-item">' +
                '<div class="msg-avatar" style="background: var(--msg-avatar-bg);">' + escapeHtml(m.avatar || '?') + '</div>' +
                '<div class="msg-content">' +
                    headerHtml +
                    '<div class="msg-text">' + renderContent(m.content) + '</div>' +
                    '<div class="msg-actions">' +
                        '<span class="action-reply" title="回复"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></span>' +
                        '<span class="action-edit" title="编辑"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></span>' +
                    '</div>' +
                '</div>' +
            '</div>';
    }

    function dateSeparatorTemplate(date) {
        return '<div class="highlight-date">' +
            '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' +
            formatDate(date) +
            '</div>';
    }

    // 根据 messages 数据统一更新每条消息的分组 class
    function applyGroupClasses() {
        const items = messageArea.querySelectorAll('.message-item');
        items.forEach(function(el, i) {
            const m = messages[i];
            const prev = messages[i - 1];
            const next = messages[i + 1];
            el.classList.toggle('msg-continued', !!(prev && prev.username === m.username));
            el.classList.toggle('msg-group-end', !!(next && next.username !== m.username));
        });
    }

    // 全量渲染（带日期分隔条）
    function renderMessages() {
        messageArea.innerHTML = '';
        if (messages.length === 0) {
            messageArea.appendChild(emptyState);
            return;
        }
        let html = '';
        let lastDate = null;
        messages.forEach(function(m, i) {
            if (!lastDate || !isSameDay(lastDate, m.timestamp)) {
                html += dateSeparatorTemplate(m.timestamp);
                lastDate = m.timestamp;
            }
            html += messageTemplate(m, { continued: isContinued(messages[i - 1], m) });
        });
        messageArea.innerHTML = html;
        applyGroupClasses();
        scrollToBottom();
    }

    // 追加单条（自动判断日期分隔与分组）
    function appendMessage(m) {
        if (emptyState.parentNode === messageArea) {
            emptyState.parentNode.removeChild(emptyState);
        }
        const prev = messages[messages.length - 1];
        if (!prev || !isSameDay(prev.timestamp, m.timestamp)) {
            messageArea.insertAdjacentHTML('beforeend', dateSeparatorTemplate(m.timestamp));
        }
        messages.push(m);
        messageArea.insertAdjacentHTML('beforeend', messageTemplate(m, { continued: isContinued(prev, m) }));
        applyGroupClasses();
        scrollToBottom();
    }

    function scrollToBottom() {
        messageArea.scrollTop = messageArea.scrollHeight;
    }

    function makeMessage(partial) {
        let ts;
        if (partial.timestamp instanceof Date) {
            ts = partial.timestamp;
        } else if (partial.timestamp != null) {
            const parsed = new Date(partial.timestamp);
            ts = isNaN(parsed.getTime()) ? new Date() : parsed;
        } else {
            ts = new Date();
        }
                return {
            id: partial.id != null ? partial.id : Date.now(),
            username: partial.username || '?',
            displayName: partial.displayName || '',
            role: partial.role || '',
            avatar: partial.avatar || '?',
            content: partial.content || '',
            timestamp: ts,
            timestampText: partial.timestampText || formatTime(ts),
        };
    }

    /* ===== 成员管理 ===== */

        // 取某 userId 的展示名：优先accounts.txt 关联出的 displayName，其次 userId 本身
    function displayNameOf(userId) {
        const m = members.get(userId);
        return (m && m.displayName) || userId;
    }

    // 成员列表到位后，回填历史消息的展示名
    function applyMemberDisplayNames() {
        let changed = false;
        messages.forEach(function(m) {
            const dn = displayNameOf(m.username);
            if (dn && m.displayName !== dn) { m.displayName = dn; changed = true; }
        });
        return changed;
    }

    function ensureMember(msg) {
        const existing = members.get(msg.username);
        if (existing) {
            // 显示名稍后再拿到时，就地更新侧栏里的名字
            if (msg.displayName && existing.displayName !== msg.displayName) {
                existing.displayName = msg.displayName;
                const el = memberList.querySelector('.member-item[data-username="' + CSS.escape(msg.username) + '"] .member-name');
                if (el) el.textContent = msg.displayName;
            }
            return;
        }
        members.set(msg.username, {
            avatar: msg.avatar,
            role: msg.role,
            displayName: msg.displayName || msg.username,
            status: 'online',
        });
        const item = document.createElement('div');
        item.className = 'member-item';
        item.dataset.username = msg.username;
        item.innerHTML =
            '<span class="avatar">' + escapeHtml(msg.avatar || '?') + '</span>' +
            '<span class="member-name">' + escapeHtml(msg.displayName || msg.username) + '</span>' +
            (msg.role ? '<span class="role-tag">' + escapeHtml(msg.role) + '</span>' : '') +
            '<span class="status-dot status-online"></span>';
        memberList.appendChild(item);
        updateOnlineCount();
    }

    function updateOnlineCount() {
        const count = memberList.children.length;
        memberCount.textContent = count;
        document.getElementById('onlineCount').textContent = count;
        document.getElementById('channelTag').textContent = count + ' Online';
    }

        // 从后端拉取成员列表（members.txt；服务端已关联 accounts.txt 的显示名）
    async function loadMembers() {
        try {
            const data = await apiFetch(CONFIG.api.endpoints.members);
            (data.members || []).forEach(function(m) {
                if (!m || !m.userId) return;
                if (m.userId === session.userId) {
                    if (m.displayName) updateSelfDisplay(m.displayName);
                    return;
                }
                ensureMember({
                    username: m.userId,
                    displayName: m.displayName || m.userId,
                    avatar: m.userId.charAt(0).toUpperCase(),
                    role: '',
                });
            });
            // 显示名可能晚于消息到达：回填后重渲染一次
            if (applyMemberDisplayNames() && messages.length) renderMessages();
        } catch (e) {
            console.error('拉取成员列表失败', e);
        }
    }

    /* ===== @cmd 管理命令模式 ===== */

    // 解析命令参数：按空白切分，支持双引号包裹含空格的参数（如 @cmd give "bob" mod）
    function parseCommandArgs(rest) {
        const args = [];
        const re = /"([^"]*)"|(\S+)/g;
        let m;
        while ((m = re.exec(rest)) !== null) {
            args.push(m[1] !== undefined ? m[1] : m[2]);
        }
        return args;
    }

    // 解析 @cmd 输入：'@cmd <command> <args...>'；非命令输入返回 null
    function parseCommandInput(text) {
        if (text.indexOf('@cmd ') !== 0) return null;
        const rest = text.slice(5).trim();
        if (!rest) return null;
        const parts = parseCommandArgs(rest);
        return { command: parts[0], args: parts.slice(1) };
    }

    // 追加一条系统提示消息：仅本地渲染，不入聊天记录，刷新页面即消失
    function appendSystemMessage(text) {
        messageArea.insertAdjacentHTML('beforeend',
            '<div class="msg-system">' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>');
        scrollToBottom();
    }

    // 发送 @cmd 命令到后端，并把结果以系统消息形式显示
    async function runAdminCommand(command, args) {
        // give 是不可逆操作：需原生 confirm() 二次确认，确认后追加 --confirm 参数
        if (command === 'give' && !args.includes('--confirm')) {
            const proceed = confirm('Transfer root admin to ' + (args[0] || '') +
                '? You will be demoted to mod. This cannot be undone.');
            if (!proceed) return;
            args = args.concat('--confirm');
        }
        const echo = '@cmd ' + command + (args.length ? ' ' + args.join(' ') : '');
        try {
            const data = await apiFetch(CONFIG.api.endpoints.adminCmd, {
                method: 'POST',
                body: JSON.stringify({ command: command, args: args }),
            });
            appendSystemMessage(echo + '\n' + (data.output || 'OK'));
        } catch (e) {
            appendSystemMessage(echo + '\nError: ' + e.message);
        }
    }

    /* ===== 发送消息 ===== */

    // textarea 自适应高度
    function autoResize() {
        msgInput.style.height = 'auto';
        msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    }

    // 发送失败回滚：从本地列表移除该条并重渲染
    function rollbackMessage(id) {
        const idx = messages.findIndex(function(m) { return m.id === id; });
        if (idx !== -1) {
            messages.splice(idx, 1);
            renderMessages();
        }
    }

        async function sendMessage() {
        if (!session.userId || !session.isMember) {
            toast('你还没有加入本群组，暂时无法发言', 'error');
            return;
        }
        const text = msgInput.value.trim();
        // 无论是否为空都清空输入框
        msgInput.value = '';
        closeMentionPopup();
        autoResize();
        if (!text) return;

        // @cmd 管理命令模式：仅本地处理，不作为聊天消息发送
        const cmd = parseCommandInput(text);
        if (cmd) {
            msgInput.focus();
            runAdminCommand(cmd.command, cmd.args);
            return;
        }

        const msg = makeMessage({
            username: session.userId,
            displayName: session.displayName || session.userId,
            role: session.isAdmin ? 'Admin' : (session.isMod ? 'Mod' : ''),
            avatar: session.avatar,
            content: text,
        });
        const ciphertext = encodePayload(text);

        // 乐观渲染
        receivedIds.add(msg.id);
        appendMessage(msg);
        msgInput.focus();

        // 发送到后端
        try {
                        await apiFetch(CONFIG.api.endpoints.send, {
                method: 'POST',
                body: JSON.stringify({
                    senderId: session.userId,
                    ciphertext: ciphertext,
                    encryptedKeys: {},
                }),
            });
            // 记录待确认消息：轮询拉回同一条时跳过（本地已显示）
            pendingSent.push({ localId: msg.id, senderId: session.userId, ciphertext: ciphertext });
        } catch (e) {
            rollbackMessage(msg.id);
            console.error('发送失败', e);
            toast('消息发送失败：' + e.message, 'error');
        }
    }

    /* ===== 接收他人消息（后端轮询 / 外部推送共用入口） ===== */
    function receiveMessage(raw) {
        if (!raw || raw.content == null) return null;
        const msg = makeMessage(raw);
        if (receivedIds.has(msg.id)) return null;
        receivedIds.add(msg.id);
        ensureMember(msg);
        appendMessage(msg);
        return msg;
    }

    window.ChatAPI = {
        receiveMessage: receiveMessage,
    };

    /* ===== 拉取历史消息（后端） ===== */
    async function loadMessages() {
        try {
            await fetchMessages(0); // 拉当天全部历史
            await loadMembers();
        } catch (e) {
            console.error('拉取历史消息失败', e);
        }
    }

        /* ===== 频道切换 ===== */
    function switchChannel(name) {
        channelItems.forEach(function(item) { item.classList.remove('active'); });
        var target = document.querySelector('.sidebar-item[data-channel="' + CSS.escape(name) + '"]');
        if (target) target.classList.add('active');
        CONFIG.channel.name = name;
        document.getElementById('channelName').textContent = name;
        // 清空当前频道的消息与轮询进度
        stopPolling();
        resetChatState();
        if (name === 'general' && session.token && session.isMember) {
            // general 频道对接后端群组
            startPolling();
            loadMessages();
        }
        // TODO 后端暂为单群组设计；开发/语音频道为本地隔离频道，后续如需多频道可扩展
    }

    /* ===== 主题切换 ===== */
    const themeAuto  = document.getElementById('themeAuto');
    const themeLight = document.getElementById('themeLight');
    const themeDark  = document.getElementById('themeDark');
    const allBtns = [themeAuto, themeLight, themeDark];

    function setActiveBtn(activeBtn) {
        allBtns.forEach(btn => btn.classList.remove('active'));
        if (activeBtn) activeBtn.classList.add('active');
    }

    function setTheme(mode) {
        const root = document.documentElement;
        root.removeAttribute('data-theme');
        if (mode === 'light') {
            root.setAttribute('data-theme', 'light');
            setActiveBtn(themeLight);
        } else if (mode === 'dark') {
            root.setAttribute('data-theme', 'dark');
            setActiveBtn(themeDark);
        } else {
            root.removeAttribute('data-theme');
            setActiveBtn(themeAuto);
        }
        try {
            localStorage.setItem('mr-chat-theme', mode);
        } catch(e) {}
    }

    function loadTheme() {
        let saved = 'auto';
        try {
            const stored = localStorage.getItem('mr-chat-theme');
            if (stored === 'light' || stored === 'dark' || stored === 'auto') {
                saved = stored;
            }
        } catch(e) {}
        setTheme(saved);
    }

        /* ===== 登录门禁 ===== */

    // locked=true 锁住聊天界面并显示登录浮层；false 反
    function setLocked(locked) {
        document.body.setAttribute('data-auth', locked ? 'locked' : 'ready');
        authOverlay.hidden = !locked;
        userChip.hidden = locked;
    }

    // 更新顶栏与侧栏里的"我自己"
    function updateSelfDisplay(name) {
        if (name) session.displayName = name;
        const shown = session.displayName || session.userId || '';
        session.avatar = (shown.charAt(0) || '?').toUpperCase();
        document.getElementById('selfMemberAvatar').textContent = session.avatar;
        document.getElementById('selfMemberName').textContent = shown || 'You';
        userChipName.textContent = shown + (session.isAdmin ? ' · Admin' : (session.isMod ? ' · Mod' : ''));
        userChipAvatar.textContent = session.avatar;
    }

    /* ===== 登录 / 注册表单 ===== */

    function hideAuthMessages() {
        authError.hidden = true; authError.textContent = '';
        authNote.hidden = true;  authNote.textContent = '';
    }

    function showAuthError(text) {
        authNote.hidden = true; authNote.textContent = '';
        authError.hidden = !text;
        authError.textContent = text || '';
    }

    function showAuthNote(text) {
        authError.hidden = true; authError.textContent = '';
        authNote.hidden = !text;
        authNote.textContent = text || '';
    }

    function setAuthMode(mode) {
        authMode = (mode === 'register') ? 'register' : 'login';
        const isRegister = authMode === 'register';
        authTabs.forEach(function(tab) {
            tab.classList.toggle('active', tab.dataset.authTab === authMode);
        });
        authDisplayRow.hidden = !isRegister;
        authConfirmRow.hidden = !isRegister;
        authPassword.autocomplete = isRegister ? 'new-password' : 'current-password';
        authSubmit.textContent = isRegister ? '注册并加入' : '登录';
        authSubmit.disabled = false;
        hideAuthMessages();
    }

    // 与后端 storage 层保持一致的前置校验，减少无效请求
    const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

    function validateAuthInput(isRegister) {
        const userId = authUserId.value.trim();
        const password = authPassword.value;
        if (!userId) return '请输入用户名';
        if (!USER_ID_RE.test(userId)) return '用户名只能包含字母、数字、下划线和连字符，长度 1-64';
        if (password.length < 6) return '密码至少 6 位';
        if (isRegister && password !== authConfirm.value) return '两次输入的密码不一致';
        if (isRegister && authDisplayName.value.trim().length > 32) return '显示名最多 32 个字符';
        return '';
    }

    async function submitAuth(event) {
        if (event) event.preventDefault();
        const isRegister = authMode === 'register';
        const problem = validateAuthInput(isRegister);
        if (problem) { showAuthError(problem); return; }

        authSubmit.disabled = true;
        authSubmit.textContent = isRegister ? '注册中…' : '登录中…';
        hideAuthMessages();

        const payload = { userId: authUserId.value.trim(), password: authPassword.value };
        if (isRegister) payload.displayName = authDisplayName.value.trim();

        try {
            const data = await apiFetch(
                isRegister ? CONFIG.api.endpoints.register : CONFIG.api.endpoints.login,
                { method: 'POST', body: JSON.stringify(payload), authEndpoint: true }
            );
            authPassword.value = '';
            authConfirm.value = '';
            applyIdentity(data);
            saveSession();
            setLocked(false);
            updateSelfDisplay();
            enterChat();

            if (data.pending || !session.isMember) {
                toast('账号已创建，正在等待管理员审批', 'info');
            } else {
                toast(isRegister ? '注册成功，已加入群组' : '登录成功', 'success');
                msgInput.focus();
            }
        } catch (e) {
            showAuthError(e.message || '请求失败');
            authSubmit.disabled = false;
            authSubmit.textContent = isRegister ? '注册并加入' : '登录';
        }
    }

    /* ===== 会话生命周期 ===== */

    function handleSessionExpired() {
        clearStoredSession();
        session.token = '';
        session.isMember = false;
        stopPolling();
        resetChatState();
        setLocked(true);
        setAuthMode('login');
        showAuthError('登录状态已失效，请重新登录');
    }

    async function logout() {
        if (session.token) {
            try {
                await apiFetch(CONFIG.api.endpoints.logout, { method: 'POST', authEndpoint: true });
            } catch (e) {
                console.warn('登出请求失败（本地登录态仍会清理）', e);
            }
        }
        clearStoredSession();
        session.token = '';
        session.userId = '';
        session.displayName = '';
        session.avatar = '?';
        session.isAdmin = false;
        session.isMod = false;
        session.isMember = false;
        stopPolling();
        resetChatState();
        setLocked(true);
        setAuthMode('login');
        msgInput.value = '';
        autoResize();
        authPassword.value = '';
        authConfirm.value = '';
        authUserId.focus();
        toast('已退出登录', 'info');
    }

    // 匿名探测后端：把群名 / 人数 / 入群规则显示在登录卡片上；后端不可达时明确提示
    async function probeGroup() {
        try {
            const info = await apiFetch(CONFIG.api.endpoints.health, { authEndpoint: true });
            groupInfo = info;
            const rules = info.public ? '公开频道 · 注册即可加入' : '私有群组 · 注册后需管理员审批';
            authGroupInfo.textContent = '群组「' + (info.name || 'Untitled Group') + '」 · ' +
                (info.memberCount || 0) + ' 名成员 · ' + rules;
            authHint.textContent = info.public
                ? '公开频道允许自助注册，注册成功后即可发言。'
                : '本群组为私有群组，注册后需管理员审批才能发言。';
        } catch (e) {
            groupInfo = null;
            authGroupInfo.textContent = '后端未连接';
            authHint.textContent = '';
            showAuthError(e.message || '无法连接后端服务');
        }
    }

    /* ===== 侧栏「待审批」面板（admin / mod 专用） ===== */

    // 按当前登录身份显隐待审批面板，并拉取列表
    async function refreshPendingPanel() {
        const section = document.getElementById('pendingSection');
        if (!section) return;
        if (!session.isAdmin && !session.isMod) { section.hidden = true; return; }
        section.hidden = false;
        // 公开频道没有待审批流程：直接提示，不打接口
        if (!groupInfo) {
            try { groupInfo = await apiFetch(CONFIG.api.endpoints.health, { authEndpoint: true }); }
            catch (e) { /* 后端状态未知：按私有处理，交给接口结果 */ }
        }
        if (groupInfo && groupInfo.public) {
            document.getElementById('pendingCount').textContent = '0';
            document.getElementById('pendingList').textContent = 'Pending list unavailable for public servers';
            return;
        }
        apiFetch(CONFIG.api.endpoints.pending).then(function(data) {
            renderPendingList(data.pending || []);
        }).catch(function(e) {
            document.getElementById('pendingList').textContent = 'Failed to load pending list: ' + e.message;
        });
    }

    // 渲染待审批列表，每项带 Approve / Reject 按钮（点击处理见 bindEvents 的事件委托）
    function renderPendingList(list) {
        const listBox = document.getElementById('pendingList');
        document.getElementById('pendingCount').textContent = String(list.length);
        listBox.innerHTML = '';
        if (!list.length) {
            listBox.innerHTML = '<div class="pending-empty">No pending requests</div>';
            return;
        }
        list.forEach(function(p) {
            if (!p || !p.userId) return;
            const row = document.createElement('div');
            row.className = 'pending-item';
            row.dataset.userId = p.userId;
            const name = document.createElement('span');
            name.className = 'pending-name';
            name.textContent = p.userId;
            const date = document.createElement('span');
            date.className = 'pending-date';
            date.textContent = p.requestDate || '';
            const actions = document.createElement('span');
            actions.className = 'pending-actions';
            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.className = 'pending-btn pending-approve';
            okBtn.textContent = 'Approve';
            const noBtn = document.createElement('button');
            noBtn.type = 'button';
            noBtn.className = 'pending-btn pending-reject';
            noBtn.textContent = 'Reject';
            actions.appendChild(okBtn);
            actions.appendChild(noBtn);
            row.appendChild(name);
            row.appendChild(date);
            row.appendChild(actions);
            listBox.appendChild(row);
        });
    }

    // 处理 Approve / Reject 点击：调接口后刷新列表
    async function handlePendingAction(btn, approve) {
        const row = btn.closest('.pending-item');
        const userId = row && row.dataset.userId;
        if (!userId) return;
        try {
            await apiFetch(approve ? CONFIG.api.endpoints.approve : CONFIG.api.endpoints.reject, {
                method: 'POST',
                body: JSON.stringify({ userId: userId }),
            });
            toast((approve ? '已批准 ' : '已拒绝 ') + userId, 'success');
        } catch (e) {
            toast('操作失败：' + e.message, 'error');
        }
        refreshPendingPanel();
    }

    /* ===== 聊天流程 ===== */

    function resetChatState() {
        messages = [];
        receivedIds.clear();
        pendingSent.length = 0;
        lastPollTs = 0;
        members.clear();
        renderMessages();
    }

    // 登录成功后进入聊天：写入自己的身份、拉取历史与成员
    function enterChat() {
        members.clear();
        memberList.querySelectorAll('.member-item:not(#selfMemberItem)').forEach(function(el) { el.remove(); });
        members.set(session.userId, {
            avatar: session.avatar,
            role: session.isAdmin ? 'Admin' : (session.isMod ? 'Mod' : ''),
            displayName: session.displayName || session.userId,
            status: 'online',
        });
        updateOnlineCount();
        refreshPendingPanel();

        if (!session.isMember) {
            // 未入群（私有群组待审批）：不拉消息也不轮询，服务端会返回 403
            showPendingBanner();
            return;
        }
        startPolling();
        loadMessages();
    }

    function showPendingBanner() {
        messageArea.innerHTML = '';
        const banner = document.createElement('div');
        banner.className = 'empty-state';
        banner.textContent = '账号已创建，正在等待管理员审批，通过后即可发言。';
        messageArea.appendChild(banner);
    }

    function startPolling() {
        stopPolling();
        if (!session.isMember) return;
        pollTimer = setInterval(function() {
            if (!session.token || !session.isMember) return;
            if (CONFIG.channel.name !== 'general') return; // 仅 general 频道对接后端
            fetchMessages(lastPollTs).catch(function() {
                // 轮询失败静默（网络抖动 / 后端重启），下一轮自动重试
            });
        }, CONFIG.pollInterval);
    }

    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    /* ===== @提及弹出层 ===== */

    let mentionState = null;   // 打开时：{ start: '@'的位置, query: '@后已输入文本', items, active }
    let mentionPopupEl = null;

    // 从光标处向前找 @token：@ 须在文本开头或空白之后（排除邮箱 a@b、URL /@user），后跟 0..n 个合法字符
    function getMentionContext() {
        const caret = msgInput.selectionStart;
        const m = msgInput.value.slice(0, caret).match(/(^|\s)@([\w\u4e00-\u9fa5_-]*)$/);
        if (!m) return null;
        return { start: caret - m[2].length - 1, query: m[2] };
    }

    // 候选列表：所有人 → 自己 → 其他成员；按 userId/displayName 包含匹配，忽略大小写
    function filterMentionItems(query) {
        const needle = query.toLowerCase();
        const items = [{ userId: '所有人', displayName: '所有人' }];
        if (session.userId) {
            items.push({ userId: session.userId, displayName: session.displayName || session.userId });
        }
        members.forEach(function(info, userId) {
            if (userId === session.userId) return;
            items.push({ userId: userId, displayName: info.displayName || userId });
        });
        if (!needle) return items;
        return items.filter(function(it) {
            return it.userId.toLowerCase().indexOf(needle) !== -1 ||
                   it.displayName.toLowerCase().indexOf(needle) !== -1;
        });
    }

    function ensureMentionPopupEl() {
        if (mentionPopupEl) return mentionPopupEl;
        mentionPopupEl = document.createElement('div');
        mentionPopupEl.className = 'mention-popup';
        document.querySelector('.chat-footer').appendChild(mentionPopupEl);
        return mentionPopupEl;
    }

    // 用 textContent 构建行，避免把成员名当 HTML 插入
    function renderMentionPopup() {
        const el = ensureMentionPopupEl();
        el.innerHTML = '';
        mentionState.items.forEach(function(item, i) {
            const row = document.createElement('div');
            row.className = 'mention-item' + (i === mentionState.active ? ' mention-active' : '');
            const avatar = document.createElement('span');
            avatar.className = 'mention-avatar';
            avatar.textContent = item.userId.charAt(0).toUpperCase();
            const name = document.createElement('span');
            name.className = 'mention-name';
            name.textContent = item.displayName;
            const uid = document.createElement('span');
            uid.className = 'mention-uid';
            uid.textContent = item.userId;
            row.appendChild(avatar);
            row.appendChild(name);
            row.appendChild(uid);
            row.addEventListener('mousedown', function(e) {
                e.preventDefault(); // 点击选择时不让 textarea 失焦
                pickMention(item);
            });
            el.appendChild(row);
        });
        el.classList.add('open');
        const act = el.children[mentionState.active];
        if (act) act.scrollIntoView({ block: 'nearest' });
    }

    function updateMentionPopup() {
        // @cmd 命令模式：输入以 "@cmd " 开头时不弹 @提及候选
        if (msgInput.value.indexOf('@cmd ') === 0) { closeMentionPopup(); return; }
        const ctx = getMentionContext();
        if (!ctx) { closeMentionPopup(); return; }
        const items = filterMentionItems(ctx.query);
        if (!items.length) { closeMentionPopup(); return; }
        mentionState = { start: ctx.start, query: ctx.query, items: items, active: 0 };
        renderMentionPopup();
    }

    function closeMentionPopup() {
        mentionState = null;
        if (mentionPopupEl) mentionPopupEl.classList.remove('open');
    }

    function moveMentionActive(delta) {
        const n = mentionState.items.length;
        mentionState.active = (mentionState.active + delta + n) % n;
        renderMentionPopup();
    }

    function pickMentionActive() {
        const item = mentionState && mentionState.items[mentionState.active];
        if (item) pickMention(item);
    }

    // 选中：把 @+已输入文本 替换为 @userId+空格，光标落在空格后
    function pickMention(item) {
        const st = mentionState;
        closeMentionPopup();
        if (!st) return;
        const head = msgInput.value.slice(0, st.start);
        const tail = msgInput.value.slice(st.start + 1 + st.query.length);
        const insert = '@' + item.userId + ' ';
        msgInput.value = head + insert + tail;
        const caret = head.length + insert.length;
        msgInput.setSelectionRange(caret, caret);
        autoResize();
        msgInput.focus();
    }

    /* ===== 事件绑定 ===== */

    function bindEvents() {
        // 发送按钮
        sendBtn.addEventListener('click', sendMessage);

        // textarea：Enter 发送，Shift+Enter 换行；弹出层打开时方向键/Enter/Esc 优先操作候选
        msgInput.addEventListener('keydown', function(e) {
            if (mentionState) {
                if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionActive(1); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); moveMentionActive(-1); return; }
                if (e.key === 'Enter') { e.preventDefault(); pickMentionActive(); return; }
                if (e.key === 'Escape') { e.preventDefault(); closeMentionPopup(); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        // textarea 自适应高度
        msgInput.addEventListener('input', autoResize);
        // @提及弹出层：随输入更新候选（无匹配自动关闭，再匹配自动重开）
        msgInput.addEventListener('input', updateMentionPopup);

        // 点击弹层与输入框之外的区域时关闭弹层
        document.addEventListener('click', function(e) {
            if (mentionState && mentionPopupEl && !mentionPopupEl.contains(e.target) && e.target !== msgInput) {
                closeMentionPopup();
            }
        });

        // 消息操作图标事件委托
        messageArea.addEventListener('click', function(e) {
            var reply = e.target.closest('.action-reply');
            if (reply) { msgInput.focus(); return; }
            var edit = e.target.closest('.action-edit');
            if (edit) { msgInput.focus(); }
        });

        // 待审批面板：Approve / Reject 事件委托
        const pendingListBox = document.getElementById('pendingList');
        if (pendingListBox) {
            pendingListBox.addEventListener('click', function(e) {
                const btn = e.target.closest('.pending-btn');
                if (!btn) return;
                handlePendingAction(btn, btn.classList.contains('pending-approve'));
            });
        }

        // 频道切换
        channelItems.forEach(function(item) {
            item.addEventListener('click', function() {
                switchChannel(this.dataset.channel);
            });
        });

        // 主题
        themeAuto.addEventListener('click', function() { setTheme('auto'); });
        themeLight.addEventListener('click', function() { setTheme('light'); });
        themeDark.addEventListener('click', function() { setTheme('dark'); });

        // 登录 / 注册 / 登出
        authForm.addEventListener('submit', submitAuth);
        authTabs.forEach(function(tab) {
            tab.addEventListener('click', function() { setAuthMode(this.dataset.authTab); });
        });
        logoutBtn.addEventListener('click', logout);
    }

    /* ===== 初始化 ===== */

    async function boot() {
        document.getElementById('channelName').textContent = CONFIG.channel.name;
        document.getElementById('channelTag').textContent = CONFIG.channel.tag;

        bindEvents();
        loadTheme();
        autoResize();
        setAuthMode('login');
        setLocked(true);

        // 先用本地缓存的令牌尝试恢复登录态（刷新页面不用重新输密码）
        const stored = readStoredSession();
        if (stored) {
            session.token = stored.token;
            session.userId = stored.userId || '';
            session.displayName = stored.displayName || stored.userId || '';
            try {
                const data = await apiFetch(CONFIG.api.endpoints.me, { authEndpoint: true });
                applyIdentity(data);
                saveSession();
                setLocked(false);
                updateSelfDisplay();
                enterChat();
                msgInput.focus();
                return;
            } catch (e) {
                // 令牌失效或后端不可达：清理本地登录态，停在登录界面
                console.warn('恢复登录态失败', e);
                clearStoredSession();
                session.token = '';
            }
        }

        setLocked(true);
        probeGroup();
        authUserId.focus();
    }

    boot();
})();
