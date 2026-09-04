document.addEventListener('DOMContentLoaded', () => {
    // --- Session token -----------------------------------------------------
    // The management API can spawn processes, so every call is authenticated. The
    // token arrives in the dashboard URL (printed to stderr at boot) and is kept in
    // sessionStorage so a refresh without the query string still works.
    const urlToken = new URLSearchParams(window.location.search).get('token');
    if (urlToken) {
        sessionStorage.setItem('justbetter-token', urlToken);
        history.replaceState(null, '', window.location.pathname);
    }
    const TOKEN = sessionStorage.getItem('justbetter-token') || '';

    function api(path, options = {}) {
        return fetch(path, {
            ...options,
            headers: {
                ...(options.headers || {}),
                'X-JustBetter-Token': TOKEN
            }
        });
    }

    function showAuthError() {
        const banner = document.getElementById('auth-banner');
        if (banner) banner.hidden = false;
    }

    // --- Small DOM helpers -------------------------------------------------
    // Everything below builds nodes and assigns textContent. Tool names and
    // descriptions come from upstream MCP servers, so interpolating them into
    // innerHTML would let an upstream server script this page.

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function badge(className, text) {
        return el('span', `badge ${className}`.trim(), text);
    }

    // --- Data Fetching & Rendering -----------------------------------------

    let allTools = [];

    async function loadServers() {
        const res = await api('/api/servers');
        if (res.status === 401) return showAuthError();
        const servers = await res.json();
        const tbody = document.querySelector('#servers-table tbody');
        tbody.replaceChildren();

        servers.forEach(server => {
            const tr = document.createElement('tr');

            const nameCell = document.createElement('td');
            nameCell.appendChild(el('span', `status-dot ${server.status || 'unknown'}`));
            nameCell.appendChild(el('strong', null, server.name));
            tr.appendChild(nameCell);

            const cmdCell = document.createElement('td');
            const code = el('code', null, `${server.command} ${(server.args || []).join(' ')}`);
            code.style.background = 'var(--hover-bg)';
            code.style.padding = '2px 4px';
            cmdCell.appendChild(code);
            tr.appendChild(cmdCell);

            const actionCell = document.createElement('td');
            const removeBtn = el('button', 'outline danger', 'Remove');
            removeBtn.dataset.action = 'delete-server';
            removeBtn.dataset.server = server.name;
            actionCell.appendChild(removeBtn);
            tr.appendChild(actionCell);

            tbody.appendChild(tr);
        });
    }

    function renderTools(filter = '') {
        const tbody = document.querySelector('#tools-table tbody');
        tbody.replaceChildren();

        const needle = filter.trim().toLowerCase();
        const visible = needle
            ? allTools.filter(t =>
                t.tool_name.toLowerCase().includes(needle) ||
                (t.description || '').toLowerCase().includes(needle) ||
                t.server_name.toLowerCase().includes(needle))
            : allTools;

        visible.forEach(tool => {
            const tr = document.createElement('tr');

            const nameCell = document.createElement('td');
            nameCell.appendChild(el('strong', null, tool.tool_name));
            tr.appendChild(nameCell);

            tr.appendChild(el('td', null, tool.server_name));

            const statusCell = document.createElement('td');
            if (tool.isPinned) statusCell.appendChild(badge('pinned', 'Pinned'));
            if (tool.isDestructive) statusCell.appendChild(badge('danger', 'Destructive'));
            if (tool.is_quarantined) statusCell.appendChild(badge('quarantined', 'Quarantined'));
            if (!statusCell.childElementCount) statusCell.appendChild(badge('', 'Active'));
            tr.appendChild(statusCell);

            const actionCell = document.createElement('td');
            const pinBtn = el('button', 'outline', tool.isPinned ? 'Unpin' : 'Pin');
            pinBtn.dataset.action = 'toggle-pin';
            pinBtn.dataset.tool = tool.tool_name;
            pinBtn.dataset.pinned = String(!tool.isPinned);
            actionCell.appendChild(pinBtn);

            if (tool.is_quarantined) {
                const approveBtn = el('button', 'outline', 'Approve Schema');
                approveBtn.dataset.action = 'approve';
                approveBtn.dataset.tool = tool.tool_name;
                approveBtn.dataset.server = tool.server_name;
                actionCell.appendChild(approveBtn);
            }
            tr.appendChild(actionCell);

            tbody.appendChild(tr);
        });
    }

    async function loadTools() {
        const res = await api('/api/tools');
        if (res.status === 401) return showAuthError();
        allTools = await res.json();
        renderTools(document.getElementById('tool-search')?.value || '');
    }

    // --- Actions -----------------------------------------------------------

    async function deleteServer(name, btn) {
        if (!confirm(`Remove server ${name}?`)) return;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Removing...';
        }
        await api(`/api/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
        loadServers();
        loadTools();
    }

    async function togglePin(name, pinned) {
        const res = await api(`/api/tools/${encodeURIComponent(name)}/pin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned })
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(data.error || 'Could not change the pinned state.');
        }
        loadTools();
    }

    async function approveQuarantine(name, server) {
        if (!confirm(
            `Approve the current schema for "${name}"?\n\n` +
            `This tool was quarantined because its schema changed. Approving accepts the ` +
            `schema the server is advertising right now and makes the tool callable again.`
        )) return;

        // No fingerprint is sent: the gateway re-hashes the schema it holds. A value
        // typed here would be an approval of nothing in particular.
        const res = await api(`/api/tools/${encodeURIComponent(name)}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ server })
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(data.error || 'Could not approve the tool.');
        }
        loadTools();
    }

    // Delegated handlers: no markup carries an interpolated tool or server name.
    document.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-action]');
        if (!btn) return;

        if (btn.dataset.action === 'delete-server') deleteServer(btn.dataset.server, btn);
        if (btn.dataset.action === 'toggle-pin') togglePin(btn.dataset.tool, btn.dataset.pinned === 'true');
        if (btn.dataset.action === 'approve') approveQuarantine(btn.dataset.tool, btn.dataset.server);
    });

    // --- Navigation Tabs ---------------------------------------------------
    const navBtns = document.querySelectorAll('.nav-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            navBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
        });
    });

    const searchInput = document.getElementById('tool-search');
    if (searchInput) {
        searchInput.addEventListener('input', () => renderTools(searchInput.value));
    }

    const addBtn = document.getElementById('add-server-btn');
    addBtn.addEventListener('click', async () => {
        const name = document.getElementById('new-server-name').value.trim();
        const cmdStr = document.getElementById('new-server-cmd').value.trim();
        if (!name || !cmdStr) return alert("Fill in both fields");

        const parts = cmdStr.split(/\s+/);
        const command = parts[0];
        const args = parts.slice(1);

        addBtn.disabled = true;
        addBtn.textContent = 'Connecting & Indexing...';

        try {
            const res = await api('/api/servers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, command, args })
            });

            const data = await res.json();
            if (!res.ok) {
                alert(data.error || "Error adding server.");
                return;
            }

            document.getElementById('new-server-name').value = '';
            document.getElementById('new-server-cmd').value = '';
        } catch (e) {
            alert("Network error while adding server.");
        } finally {
            addBtn.disabled = false;
            addBtn.textContent = 'Add Server';
            loadServers();
            loadTools(); // Reload tools to show newly indexed tools
        }
    });

    // --- WebSockets for Live Trace -----------------------------------------

    function setupWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/?token=${encodeURIComponent(TOKEN)}`);

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type !== 'discovery_trace') return;

            const feed = document.getElementById('trace-feed');
            const item = el('div', 'trace-item');

            const promptLine = el('div', 'trace-prompt');
            if (data.isFallback) {
                promptLine.appendChild(el('span', 'trace-fallback', '⚠️ request_tools Fallback'));
                promptLine.appendChild(document.createTextNode(' '));
            }
            promptLine.appendChild(document.createTextNode(`"${data.prompt}"`));
            item.appendChild(promptLine);

            const injected = (data.matchedTools || [])
                .map(t => `${t.name} (${Number(t.score).toFixed(2)})`)
                .join(', ') || 'None';
            const injectedLine = el('div', 'trace-meta');
            injectedLine.appendChild(el('strong', null, 'Matched: '));
            injectedLine.appendChild(document.createTextNode(injected));
            item.appendChild(injectedLine);

            if (typeof data.tokensSaved === 'number') {
                const savedLine = el('div', 'trace-meta');
                savedLine.appendChild(el('strong', null, 'Est. tokens saved vs inject-all: '));
                savedLine.appendChild(document.createTextNode(`~${data.tokensSaved.toLocaleString()}`));
                item.appendChild(savedLine);
            }

            feed.prepend(item);

            // Keep only last 20 items
            if (feed.children.length > 20) {
                feed.removeChild(feed.lastChild);
            }
        };

        ws.onclose = () => {
            console.log('WebSocket disconnected. Reconnecting in 3s...');
            setTimeout(setupWebSocket, 3000);
        };
    }

    // Initialize
    if (!TOKEN) {
        showAuthError();
    } else {
        loadServers();
        loadTools();
        setupWebSocket();
    }
});
