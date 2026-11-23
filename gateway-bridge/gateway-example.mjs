/**
 * MayraLab / Kettler MES — Standalone Local Factory PC Sensor Gateway Example
 * Runs OUTSIDE the browser applet on a factory LAN PC (Node.js 18+, zero dependencies to test).
 *
 * Features:
 *  - Polls PLC / Modbus / OPC-UA / Serial hardware on a fixed interval (with demo fallback)
 *  - Persists timestamped readings to a circular disk buffer (readings-buffer.jsonl)
 *    so readings captured while browser tabs are closed can be back-filled later
 *  - Serves CORS-enabled REST JSON:
 *      GET /health
 *      GET /api/readings?line=...
 *      GET /api/readings/history?since=<ISO>&line=...
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GATEWAY_PORT || 4100);
const POLL_MS = Number(process.env.GATEWAY_POLL_MS || 2000);
const BUFFER_FILE = path.join(__dirname, 'readings-buffer.jsonl');
const MAX_BUFFER_ITEMS = 10000;

/** @type {Array<Record<string, unknown>>} */
let ringBuffer = [];

// Load persisted history from disk on startup for uninterrupted back-fill
if (fs.existsSync(BUFFER_FILE)) {
  try {
    const rawLines = fs.readFileSync(BUFFER_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    ringBuffer = rawLines
      .slice(-MAX_BUFFER_ITEMS)
      .map((line) => JSON.parse(line));
    console.log(`[Gateway] Loaded ${ringBuffer.length} buffered reading(s) from disk.`);
  } catch (err) {
    console.warn('[Gateway] Starting with fresh buffer:', err.message);
  }
}

function appendReading(reading) {
  ringBuffer.push(reading);
  if (ringBuffer.length > MAX_BUFFER_ITEMS) {
    ringBuffer = ringBuffer.slice(-MAX_BUFFER_ITEMS);
    fs.writeFileSync(
      BUFFER_FILE,
      ringBuffer.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8'
    );
  } else {
    fs.appendFileSync(BUFFER_FILE, JSON.stringify(reading) + '\n', 'utf8');
  }
}

/**
 * Replace this function with your real hardware driver:
 *  - Modbus TCP: const client = new ModbusRTU(); await client.connectTCP('192.168.1.50', { port: 502 });
 *  - OPC-UA: session.read({ nodeId: 'ns=2;s=Kettle1.TempC' })
 *  - Serial Scale: serialport ReadlineParser
 */
let tick = 0;
async function readRealDeviceOrDemo() {
  tick += 1;
  const now = new Date();
  const iso = now.toISOString();

  return [
    {
      timestamp: iso,
      lineName: 'Line 1 · Kettle 500L',
      sensorCode: 'GW-K101-PLC',
      tempC: Number((85.2 + Math.sin(tick * 0.4) * 0.6).toFixed(1)),
      brix: Number((42.0 + Math.cos(tick * 0.3) * 0.3).toFixed(1)),
      ph: Number((4.12 + Math.sin(tick * 0.2) * 0.03).toFixed(2)),
      viscosityCp: Math.round(1180 + Math.sin(tick * 0.5) * 30),
      weightKg: 0.26,
      speedRpm: 54,
      pressureBar: 1.42,
    },
    {
      timestamp: iso,
      lineName: 'Line 2 · Kettle 1000L',
      sensorCode: 'GW-K201-PLC',
      tempC: Number((87.4 + Math.cos(tick * 0.35) * 0.7).toFixed(1)),
      brix: Number((45.1 + Math.sin(tick * 0.25) * 0.4).toFixed(1)),
      ph: Number((3.95 + Math.cos(tick * 0.2) * 0.03).toFixed(2)),
      viscosityCp: Math.round(1320 + Math.cos(tick * 0.4) * 25),
      weightKg: 0.27,
      speedRpm: 48,
      pressureBar: 1.55,
    },
  ];
}

setInterval(async () => {
  try {
    const readings = await readRealDeviceOrDemo();
    for (const r of readings) appendReading(r);
  } catch (err) {
    console.error('[Gateway] Hardware poll error:', err);
  }
}, POLL_MS);

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    });
    res.end();
    return;
  }

  const reqUrl = new URL(req.url || '/', `http://localhost:${PORT}`);
  const lineFilter = (reqUrl.searchParams.get('line') || '').trim().toLowerCase();

  if (reqUrl.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      bufferedCount: ringBuffer.length,
      latestTimestamp: ringBuffer.at(-1)?.timestamp || null,
    });
    return;
  }

  if (reqUrl.pathname === '/api/readings') {
    const latestByLine = new Map();
    for (let i = ringBuffer.length - 1; i >= 0; i--) {
      const item = ringBuffer[i];
      const lineKey = String(item.lineName || 'Line 1');
      if (lineFilter && !lineKey.toLowerCase().includes(lineFilter)) continue;
      if (!latestByLine.has(lineKey)) {
        latestByLine.set(lineKey, item);
      }
    }
    sendJson(res, 200, { readings: Array.from(latestByLine.values()) });
    return;
  }

  if (reqUrl.pathname === '/api/readings/history') {
    const since = reqUrl.searchParams.get('since') || '';
    const sinceMs = since ? Date.parse(since) : 0;
    const matched = ringBuffer.filter((item) => {
      const lineKey = String(item.lineName || '').toLowerCase();
      if (lineFilter && !lineKey.includes(lineFilter)) return false;
      if (sinceMs && Number.isFinite(sinceMs)) {
        const tsMs = Date.parse(String(item.timestamp || ''));
        if (Number.isFinite(tsMs) && tsMs <= sinceMs) return false;
      }
      return true;
    });
    sendJson(res, 200, {
      since: since || null,
      count: matched.length,
      readings: matched.slice(-200),
    });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MayraLab Local Sensor Gateway listening on http://0.0.0.0:${PORT}`);
  console.log(`  Live endpoint:     http://localhost:${PORT}/api/readings`);
  console.log(`  Backfill endpoint: http://localhost:${PORT}/api/readings/history`);
});
