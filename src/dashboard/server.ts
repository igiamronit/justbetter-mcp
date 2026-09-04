import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { loadConfig, saveConfig, CORE_PINNED_TOOLS, UpstreamServerSchema, DashboardSchema } from '../config.js';
import type { Config } from '../config.js';
import { getAllTools, clearQuarantine } from '../catalog.js';
import { connectSingleUpstream, removeUpstream, serverStatuses } from '../upstream.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let wss: WebSocketServer;
let connectedClients = new Set<WebSocket>();

/**
 * Session token for the management API. POST /api/servers spawns a child process from
 * caller-supplied {command, args, env}, so an unauthenticated endpoint on a wildcard
 * bind is remote code execution. The token is printed to stderr at boot and carried in
 * the dashboard URL; the socket is loopback-only unless explicitly reconfigured.
 */
const DASHBOARD_TOKEN = process.env.JUSTBETTER_DASHBOARD_TOKEN || randomBytes(24).toString('hex');

function tokensMatch(provided: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(DASHBOARD_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function broadcastEvent(event: any) {
  if (!wss) return;
  const data = JSON.stringify(event);
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

export function startDashboard(configPath: string, bootConfig?: Config) {
  const app = express();
  const server = createServer(app);

  const dashboardConfig = bootConfig?.dashboard ?? DashboardSchema.parse({});
  const port = dashboardConfig.port;
  const host = dashboardConfig.host || '127.0.0.1';

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // --- Management API auth ---------------------------------------------------
  app.use('/api', (req, res, next) => {
    const provided = (req.get('x-justbetter-token') || (req.query.token as string) || '').trim();
    if (!provided || !tokensMatch(provided)) {
      return res.status(401).json({ error: 'Unauthorized: missing or invalid dashboard token.' });
    }

    // Defence in depth against a browser page that somehow learned the token: a
    // cross-site request carries an Origin the dashboard did not serve.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.get('origin');
      if (origin) {
        const allowed = [`http://${host}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`];
        if (!allowed.includes(origin)) {
          return res.status(403).json({ error: `Forbidden: cross-origin request from ${origin}.` });
        }
      }
    }

    next();
  });

  // REST API Endpoints

  app.get('/api/servers', (req, res) => {
    const config = loadConfig(configPath);
    // Merge the real-time status from the Upstream Manager
    const enrichedServers = config.upstreamServers.map(s => ({
      ...s,
      status: serverStatuses[s.name] || 'unknown'
    }));
    res.json(enrichedServers);
  });

  app.post('/api/servers', async (req, res) => {
    // Validate before anything is persisted or spawned.
    const parsed = UpstreamServerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: `Invalid server definition: ${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}` });
    }
    const serverEntry = parsed.data;

    const config = loadConfig(configPath);

    // Prevent duplicate server names
    if (config.upstreamServers.some(s => s.name === serverEntry.name)) {
      return res.status(400).json({ error: `A server with the name '${serverEntry.name}' already exists.` });
    }

    config.upstreamServers.push(serverEntry);
    saveConfig(configPath, config);

    // Hot-reload: dynamically connect and index without restarting!
    await connectSingleUpstream(serverEntry);

    res.json({ success: true, status: serverStatuses[serverEntry.name] });
  });

  app.delete('/api/servers/:name', async (req, res) => {
    const name = req.params.name;
    const config = loadConfig(configPath);
    config.upstreamServers = config.upstreamServers.filter(s => s.name !== name);
    saveConfig(configPath, config);

    // Hot-reload: gracefully kill the child process immediately!
    await removeUpstream(name);

    res.json({ success: true });
  });

  app.get('/api/tools', (req, res) => {
    const config = loadConfig(configPath);
    const tools = getAllTools();

    // Filter out tools from disconnected servers
    const activeTools = tools.filter(t => serverStatuses[t.server_name] === 'connected');

    // Map in the pinned/destructive statuses from config
    const enhancedTools = activeTools.map((t: any) => ({
      ...t,
      isPinned: config.pinnedTools.includes(t.tool_name),
      isDestructive: config.destructiveTools.includes(t.tool_name)
    }));

    res.json(enhancedTools);
  });

  app.post('/api/tools/:name/pin', (req, res) => {
    const toolName = req.params.name;
    const { pinned } = req.body;
    const config = loadConfig(configPath);

    const isPinned = config.pinnedTools.includes(toolName);
    if (pinned && !isPinned) {
      config.pinnedTools.push(toolName);
    } else if (!pinned && isPinned) {
      if (CORE_PINNED_TOOLS.includes(toolName)) {
        return res.status(400).json({ success: false, error: "Cannot unpin core agentic tools." });
      }
      config.pinnedTools = config.pinnedTools.filter(t => t !== toolName);
    }

    saveConfig(configPath, config);
    res.json({ success: true, pinnedTools: config.pinnedTools });
  });

  app.post('/api/tools/:name/approve', (req, res) => {
    const toolName = req.params.name;
    // The fingerprint is recomputed server-side from the schema we actually hold. A
    // client-supplied hash would let anyone clear a quarantine by inventing a string,
    // which is the one thing the quarantine mechanism exists to prevent.
    const serverName = typeof req.body?.server === 'string' ? req.body.server : undefined;

    const result = clearQuarantine(toolName, serverName);
    if (!result.approved) {
      return res.status(404).json({ error: `Tool '${toolName}' is not in the catalog.` });
    }

    console.error(`[Dashboard] Quarantine approved for '${toolName}'${serverName ? ` (${serverName})` : ''} → ${result.fingerprint}`);
    res.json({ success: true, fingerprint: result.fingerprint });
  });

  // Start WebSocket Server
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    // The event stream carries prompts and tool traces; gate it like the REST API.
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const provided = (url.searchParams.get('token') || '').trim();
    if (!provided || !tokensMatch(provided)) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    connectedClients.add(ws);
    ws.on('close', () => {
      connectedClients.delete(ws);
    });
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[Dashboard] ⚠️  Port ${port} is already in use, so THIS instance has no dashboard.`);
      console.error(`[Dashboard]    Set dashboard.port, or dashboard.enabled=false, to silence this.`);
    } else {
      console.error(`\n[Dashboard] Error: ${err.message}`);
    }
  });

  server.listen(port, host, () => {
    console.error(`\n[Dashboard] Local management UI: http://${host}:${port}/?token=${DASHBOARD_TOKEN}`);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.error(`[Dashboard] ⚠️  Bound to ${host}, not loopback. The management API can spawn processes; keep it on loopback.`);
    }
  });

  return server;
}
