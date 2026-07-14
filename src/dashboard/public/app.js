document.addEventListener('DOMContentLoaded', () => {
    // --- Navigation Tabs ---
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

    // --- Data Fetching & Rendering ---
    
    async function loadServers() {
        const res = await fetch('/api/servers');
        const servers = await res.json();
        const tbody = document.querySelector('#servers-table tbody');
        tbody.innerHTML = '';
        
        servers.forEach(server => {
            const tr = document.createElement('tr');
            
            let statusText = 'Unknown';
            if (server.status === 'connected') statusText = 'Connected';
            if (server.status === 'failed') statusText = 'Failed';
            
            tr.innerHTML = `
                <td>
                    <span class="status-dot ${server.status}"></span>
                    <strong>${server.name}</strong>
                </td>
                <td><code style="background:var(--hover-bg);padding:2px 4px;">${server.command} ${server.args.join(' ')}</code></td>
                <td>
                    <button class="outline danger" onclick="deleteServer('${server.name}')" id="del-btn-${server.name}">Remove</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    async function loadTools() {
        const res = await fetch('/api/tools');
        const tools = await res.json();
        const tbody = document.querySelector('#tools-table tbody');
        tbody.innerHTML = '';
        
        tools.forEach(tool => {
            const tr = document.createElement('tr');
            
            let statusHtml = '';
            if (tool.isPinned) statusHtml += '<span class="badge pinned">Pinned</span> ';
            if (tool.isDestructive) statusHtml += '<span class="badge danger">Destructive</span> ';
            if (tool.is_quarantined) statusHtml += '<span class="badge quarantined">Quarantined</span> ';
            if (!statusHtml) statusHtml = '<span class="badge">Active</span>';

            tr.innerHTML = `
                <td><strong>${tool.tool_name}</strong></td>
                <td>${tool.server_name}</td>
                <td>${statusHtml}</td>
                <td>
                    <button class="outline" onclick="togglePin('${tool.tool_name}', ${!tool.isPinned})">
                        ${tool.isPinned ? 'Unpin' : 'Pin'}
                    </button>
                    ${tool.is_quarantined ? `<button class="outline" onclick="approveQuarantine('${tool.tool_name}')">Approve Schema</button>` : ''}
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    // --- Actions ---

    window.deleteServer = async (name) => {
        if (!confirm(`Remove server ${name}?`)) return;
        const btn = document.getElementById(`del-btn-${name}`);
        if (btn) {
            btn.disabled = true;
            btn.innerText = 'Removing...';
        }
        await fetch(`/api/servers/${name}`, { method: 'DELETE' });
        loadServers();
        loadTools();
    };

    window.togglePin = async (name, pinned) => {
        await fetch(`/api/tools/${name}/pin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned })
        });
        loadTools();
    };

    window.approveQuarantine = async (name) => {
        const fingerprint = prompt("Enter the new SHA-256 fingerprint from the server logs to approve this tool:");
        if (!fingerprint) return;
        
        await fetch(`/api/tools/${name}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fingerprint })
        });
        loadTools();
    };

    const addBtn = document.getElementById('add-server-btn');
    addBtn.addEventListener('click', async () => {
        const name = document.getElementById('new-server-name').value;
        const cmdStr = document.getElementById('new-server-cmd').value;
        if (!name || !cmdStr) return alert("Fill in both fields");

        const parts = cmdStr.split(' ');
        const command = parts[0];
        const args = parts.slice(1);

        addBtn.disabled = true;
        addBtn.innerText = 'Connecting & Indexing...';

        try {
            const res = await fetch('/api/servers', {
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
            addBtn.innerText = 'Add Server';
            loadServers();
            loadTools(); // Reload tools to show newly indexed tools
        }
    });

    // --- WebSockets for Live Trace ---
    
    function setupWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}`);
        
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'discovery_trace') {
                const feed = document.getElementById('trace-feed');
                const item = document.createElement('div');
                item.className = 'trace-item';
                
                const fallbackHtml = data.isFallback ? '<span class="trace-fallback">⚠️ request_tools Fallback</span> ' : '';
                
                item.innerHTML = `
                    <div class="trace-prompt">${fallbackHtml}"${data.prompt}"</div>
                    <div class="trace-meta">
                        <strong>Injected:</strong> ${data.matchedTools.map(t => `${t.name} (${t.score.toFixed(2)})`).join(', ') || 'None'}
                    </div>
                    <div class="trace-meta">
                        <strong>Tokens Saved:</strong> ~${data.tokensSaved.toLocaleString()}
                    </div>
                `;
                
                feed.prepend(item);
                
                // Keep only last 20 items
                if (feed.children.length > 20) {
                    feed.removeChild(feed.lastChild);
                }
            }
        };

        ws.onclose = () => {
            console.log('WebSocket disconnected. Reconnecting in 3s...');
            setTimeout(setupWebSocket, 3000);
        };
    }

    // Initialize
    loadServers();
    loadTools();
    setupWebSocket();
});
