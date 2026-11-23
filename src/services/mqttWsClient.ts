/**
 * Lightweight MQTT 3.1.1 over WebSocket client for browser environments.
 * Connects to brokers exposing WebSocket listeners (e.g. ws://gateway:9001/mqtt or wss://...)
 * without requiring Node polyfills or direct hardware access.
 */

export interface MqttMessage {
  topic: string;
  payload: string;
}

export interface MqttClientCallbacks {
  onConnect?: () => void;
  onMessage: (msg: MqttMessage) => void;
  onError?: (reason: string) => void;
  onClose?: () => void;
}

function encodeUtf8String(str: string): Uint8Array {
  const utf8 = new TextEncoder().encode(str);
  const out = new Uint8Array(2 + utf8.length);
  out[0] = (utf8.length >> 8) & 0xff;
  out[1] = utf8.length & 0xff;
  out.set(utf8, 2);
  return out;
}

function encodeRemainingLength(len: number): number[] {
  const bytes: number[] = [];
  let x = len;
  do {
    let encodedByte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) encodedByte |= 128;
    bytes.push(encodedByte);
  } while (x > 0);
  return bytes;
}

function buildConnectPacket(clientId: string): Uint8Array {
  const protoName = encodeUtf8String('MQTT');
  const clientIdBytes = encodeUtf8String(clientId);
  // Variable header: protoName(6) + level(1) + flags(1) + keepAlive(2) = 10 bytes
  const remaining = 10 + clientIdBytes.length;
  const remBytes = encodeRemainingLength(remaining);
  const packet = new Uint8Array(1 + remBytes.length + remaining);
  let offset = 0;
  packet[offset++] = 0x10; // CONNECT
  for (const b of remBytes) packet[offset++] = b;
  packet.set(protoName, offset);
  offset += protoName.length;
  packet[offset++] = 0x04; // MQTT 3.1.1
  packet[offset++] = 0x02; // Clean session
  packet[offset++] = 0x00; // KeepAlive MSB
  packet[offset++] = 30; // KeepAlive 30s
  packet.set(clientIdBytes, offset);
  return packet;
}

function buildSubscribePacket(packetId: number, topic: string): Uint8Array {
  const topicBytes = encodeUtf8String(topic);
  const remaining = 2 + topicBytes.length + 1;
  const remBytes = encodeRemainingLength(remaining);
  const packet = new Uint8Array(1 + remBytes.length + remaining);
  let offset = 0;
  packet[offset++] = 0x82; // SUBSCRIBE with QoS 1 flag
  for (const b of remBytes) packet[offset++] = b;
  packet[offset++] = (packetId >> 8) & 0xff;
  packet[offset++] = packetId & 0xff;
  packet.set(topicBytes, offset);
  offset += topicBytes.length;
  packet[offset] = 0x00; // Requested QoS 0
  return packet;
}

export class BrowserMqttWsClient {
  private ws: WebSocket | null = null;
  private keepAliveTimer: number | null = null;
  private closedManually = false;

  constructor(
    private readonly url: string,
    private readonly topic: string,
    private readonly callbacks: MqttClientCallbacks
  ) {}

  connect(): void {
    this.closedManually = false;
    try {
      this.ws = new WebSocket(this.url, 'mqtt');
      this.ws.binaryType = 'arraybuffer';
    } catch (err) {
      this.callbacks.onError?.(
        err instanceof Error ? err.message : 'Unable to open MQTT WebSocket connection.'
      );
      return;
    }

    this.ws.onopen = () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const clientId = `mayralab-mes-${Math.random().toString(36).slice(2, 9)}`;
      const packet = buildConnectPacket(clientId);
      this.ws.send(packet.buffer as ArrayBuffer);
    };

    this.ws.onmessage = (evt) => {
      if (!(evt.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(evt.data);
      this.parsePackets(bytes);
    };

    this.ws.onerror = () => {
      if (!this.closedManually) {
        this.callbacks.onError?.(`MQTT broker unreachable at ${this.url}`);
      }
    };

    this.ws.onclose = () => {
      this.stopKeepAlive();
      if (!this.closedManually) {
        this.callbacks.onClose?.();
      }
    };
  }

  disconnect(): void {
    this.closedManually = true;
    this.stopKeepAlive();
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(new Uint8Array([0xe0, 0x00])); // DISCONNECT
        }
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = window.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(new Uint8Array([0xc0, 0x00])); // PINGREQ
      }
    }, 20000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      window.clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private parsePackets(buf: Uint8Array): void {
    let idx = 0;
    const decoder = new TextDecoder();
    while (idx < buf.length) {
      const header = buf[idx++];
      const packetType = (header >> 4) & 0x0f;
      const qos = (header >> 1) & 0x03;

      let multiplier = 1;
      let remainingLength = 0;
      let digit = 0;
      do {
        if (idx >= buf.length) return;
        digit = buf[idx++];
        remainingLength += (digit & 127) * multiplier;
        multiplier *= 128;
      } while ((digit & 128) !== 0);

      const end = Math.min(buf.length, idx + remainingLength);
      const body = buf.subarray(idx, end);
      idx = end;

      if (packetType === 2) {
        // CONNACK
        const returnCode = body[1] ?? 1;
        if (returnCode === 0) {
          this.startKeepAlive();
          this.callbacks.onConnect?.();
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const subPacket = buildSubscribePacket(1, this.topic || '#');
            this.ws.send(subPacket.buffer as ArrayBuffer);
          }
        } else {
          this.callbacks.onError?.(`MQTT broker rejected connection (code ${returnCode}).`);
        }
      } else if (packetType === 3) {
        // PUBLISH
        if (body.length < 2) continue;
        const topicLen = (body[0] << 8) | body[1];
        let pos = 2;
        const topic = decoder.decode(body.subarray(pos, pos + topicLen));
        pos += topicLen;
        if (qos > 0) {
          pos += 2; // skip packet identifier
        }
        const payload = decoder.decode(body.subarray(pos));
        this.callbacks.onMessage({ topic, payload });
      }
    }
  }
}
