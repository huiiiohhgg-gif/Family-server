const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const cors = require('cors');
const { v4: uuid } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const devices = new Map();   
const photos = [];           

app.get('/api/devices', (req, res) => {
  const list = [...devices.values()].map(({ ws, ...d }) => d);
  res.json(list);
});

app.get('/api/photos', (req, res) => {
  const { deviceId } = req.query;
  res.json(deviceId ? photos.filter(p => p.deviceId === deviceId) : photos);
});

app.post('/api/command', (req, res) => {
  const { deviceId, action } = req.body; 
  const dev = devices.get(deviceId);
  if (!dev || !dev.ws) return res.status(404).json({ error: 'device offline' });

  dev.ws.send(JSON.stringify({ type: 'command', action }));
  res.json({ ok: true, message: 'Command sent' });
});

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, `${uuid()}.jpg`)
});
const upload = multer({ storage });

app.post('/api/upload/:deviceId', upload.single('photo'), (req, res) => {
  const { deviceId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'no file' });

  const photo = {
    id: uuid(),
    deviceId,
    url: `/uploads/${req.file.filename}`,
    timestamp: Date.now()
  };
  photos.push(photo);
  broadcastToDashboards({ type: 'photo', photo });
  res.json(photo);
});

wss.on('connection', (ws) => {
  let deviceId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'register') {
      deviceId = msg.deviceId;
      devices.set(deviceId, {
        id: deviceId,
        name: msg.name || 'Unknown',
        model: msg.model || 'Android',
        status: 'online',
        battery: msg.battery || 100,
        lastSeen: Date.now(),
        location: msg.location || { lat: 0, lng: 0, address: 'Unknown' },
        ws
      });
      broadcastToDashboards({ type: 'devices', devices: [...devices.values()].map(({ ws, ...d }) => d) });
      return;
    }

    if (msg.type === 'location' && deviceId) {
      const dev = devices.get(deviceId);
      if (dev) {
        dev.lastSeen = Date.now();
        dev.battery = msg.battery || dev.battery;
        dev.location = msg.location;
        broadcastToDashboards({ type: 'devices', devices: [...devices.values()].map(({ ws, ...d }) => d) });
      }
    }
  });

  ws.on('close', () => {
    if (deviceId && devices.has(deviceId)) {
      const dev = devices.get(deviceId);
      dev.status = 'offline';
      dev.ws = null;
      broadcastToDashboards({ type: 'devices', devices: [...devices.values()].map(({ ws, ...d }) => d) });
    }
  });
});

function broadcastToDashboards(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(msg); 
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Forge lit on port ${PORT}`));
