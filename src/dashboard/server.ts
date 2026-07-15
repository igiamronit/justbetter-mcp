import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, saveConfig } from '../config.js';
import type { Config } from '../config.js';
import { getAllTools, clearQuarantine } from '../catalog.js';
import { connectSingleUpstream, removeUpstream, serverStatuses } from '../upstream.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let wss: WebSocketServer;
let connectedClients = new Set<WebSocket>();

export function broadcastEvent(event: any) {
  if (!wss) return;
  const data = JSON.stringify(event);
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

export function startDashboard(configPath: string) {
  const app = express();
  const server = createServer(app);
  
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

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
    const config = loadConfig(configPath);
    
    // Prevent duplicate server names
    if (config.upstreamServers.some(s => s.name === req.body.name)) {
      return res.status(400).json({ error: `A server with the name '${req.body.name}' already exists.` });
    }
    
    config.upstreamServers.push(req.body);
    saveConfig(configPath, config);
    
    // Hot-reload: dynamically connect and index without restarting!
    await connectSingleUpstream(req.body);
    
    res.json({ success: true, status: serverStatuses[req.body.name] });
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
      config.pinnedTools = config.pinnedTools.filter(t => t !== toolName);
    }
    
    saveConfig(configPath, config);
    res.json({ success: true, pinnedTools: config.pinnedTools });
  });

  app.post('/api/tools/:name/approve', (req, res) => {
    const toolName = req.params.name;
    const { fingerprint } = req.body; // Provided by frontend or re-hashed
    if (!fingerprint) {
      return res.status(400).json({ error: "Missing fingerprint" });
    }
    
    clearQuarantine(toolName, fingerprint);
    res.json({ success: true });
  });

  // Start WebSocket Server
  wss = new WebSocketServer({ server });
  
  wss.on('connection', (ws) => {
    connectedClients.add(ws);
    ws.on('close', () => {
      connectedClients.delete(ws);
    });
  });

  const port = process.env.DASHBOARD_PORT ? parseInt(process.env.DASHBOARD_PORT, 10) : 4040;
  
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[Dashboard] Port ${port} is already in use. Assuming Dashboard is already running in another instance.`);
    } else {
      console.error(`\n[Dashboard] Error: ${err.message}`);
    }
  });

  server.listen(port, () => {
    console.error(`\n[Dashboard] Local management UI running on http://localhost:${port}`);
  });

  return server;
}
