# Local Factory PC Sensor Gateway Guide (Outside the Browser Applet)

## Why a Local Gateway PC Is Required
A web browser applet **cannot** open raw TCP sockets, COM/RS-485 serial ports, Modbus RTU/TCP connections, or OPC-UA binary sessions directly to factory PLCs and scales due to browser security sandboxing.

To bridge real shop-floor hardware safely without coupling hardware drivers into the web app, run a lightweight Node.js gateway service on a **factory LAN PC** that sits on the same network as your PLCs/sensors:

```
[PLC / Kettle / Scale / Probe]
   │  Modbus TCP / Modbus RTU / OPC-UA / RS-232 Serial
   ▼
[Local Gateway PC — gateway-example.mjs]
   │  Polls hardware every 2s & appends ISO-timestamped JSON
   │  to circular ring buffer (readings-buffer.jsonl)
   ├──► REST JSON + CORS (:4100)
   │      GET /api/readings?line=...
   │      GET /api/readings/history?since=...&line=...   <── Back-fill!
   └──► (Optional) MQTT over WebSocket (:9001/mqtt)
          topic: mayralab/mes/<line>/readings
```

---

## Important Browser Tab-Capture Limit & How Back-Fill Solves It
* **Limit**: The browser applet only polls or auto-saves live sensor readings **while Batch Execution is open in an active browser tab**. If a shop-floor tablet goes to sleep, reloads, or closes for 20 minutes, the browser misses those readings.
* **Solution**: `gateway-example.mjs` continuously logs every hardware poll with an ISO timestamp (`timestamp`) into an in-memory + disk ring buffer (`readings-buffer.jsonl`).
* **Back-Fill**: When an operator opens an active batch in Kettler MES (or clicks **Back-Fill Missed Readings** in Step 5), the applet queries `GET /api/readings/history?since=<lastTimestamp>&line=<lineName>`, tags every point `source = "Sensor"`, and inserts missed readings chronologically **without ever overwriting existing `Manual` operator entries**.

---

## Quick Start (Test Immediately)
Requires **Node.js 18+** on the gateway PC (zero npm packages required for demo mode):

```bash
cd gateway-bridge
node gateway-example.mjs
```

Endpoints exposed:
* `http://localhost:4100/health`
* `http://localhost:4100/api/readings?line=Line%201`
* `http://localhost:4100/api/readings/history?since=2026-11-20T00:00:00Z&line=Line%201`

In Kettler MES → **Sensor Settings**:
1. Set **Adapter Mode** to `Gateway REST Poll`.
2. Enter **Live Readings URL**: `http://<GATEWAY-LAN-IP>:4100/api/readings`.
3. Turn **Master Sensor Monitoring Switch** to **ON** and enable the desired line(s).

---

## Connecting Real PLC / Scale Hardware
Install the driver needed for your device on the Gateway PC and replace `readRealDeviceOrDemo()` inside `gateway-example.mjs`:
* **Modbus TCP / RTU**: `npm install modbus-serial`
* **OPC-UA**: `npm install node-opcua-client`
* **RS-232 / RS-485 Weight Scale**: `npm install serialport`
* **MQTT over WebSocket (Optional)**: Run Eclipse Mosquitto with:
  ```conf
  listener 1883
  listener 9001
  protocol websockets
  allow_anonymous true
  ```
  and publish the exact same JSON reading object to topic `mayralab/mes/line1/readings`.
