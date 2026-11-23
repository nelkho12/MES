import type {
  FinishedGoodLot,
  RawMaterialLot,
  WmsConnectorConfig,
} from '../types';
import {
  normalizeCsvColumnKey,
  splitDelimitedCsvRows,
} from '../utils/rawMaterialCsv';

export const WMS_SCHEMA_VERSION = 'mayralab-wms-v1';

export const DEFAULT_WMS_CONNECTOR_CONFIG: WmsConnectorConfig = {
  enabled: false, // Switched OFF by default
  baseUrl: 'http://localhost:4200/api/wms',
  rawMaterialsPath: '/raw-materials',
  finishedGoodsPath: '/finished-goods',
  timeoutMs: 8000,
  autoPushFgOnQcPass: false,
  lastSyncAt: '',
};

export interface WmsRawMaterialPayload {
  schemaVersion: typeof WMS_SCHEMA_VERSION;
  exportedAt: string;
  recordType: 'raw_material_stock';
  items: Array<{
    lotNumber: string;
    materialCode: string;
    materialName: string;
    category: string;
    unit: string;
    quantityInitial: number;
    quantityAvailable: number;
    quantityAllocated: number;
    reorderLevel: number;
    unitCost: number;
    supplier: string;
    expiryDate: string;
    storageZone: string;
    status: string;
  }>;
}

export interface WmsFinishedGoodsPayload {
  schemaVersion: typeof WMS_SCHEMA_VERSION;
  exportedAt: string;
  recordType: 'finished_goods_lots';
  items: Array<{
    lotNumber: string;
    batchNumber: string;
    sku: string;
    productName: string;
    quantityProduced: number;
    quantityAvailable: number;
    unit: string;
    productionDate: string;
    expiryDate: string;
    qcStatus: string;
    warehouseZone: string;
    unitCost: number;
  }>;
}

function escapeCsvCell(val: unknown): string {
  const str = String(val ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function triggerBrowserDownload(
  content: string,
  filename: string,
  mimeType: string
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- (a) Client-side Export Helpers (No WMS server required) ----------

export function buildWmsRawMaterialsJson(lots: RawMaterialLot[]): WmsRawMaterialPayload {
  return {
    schemaVersion: WMS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    recordType: 'raw_material_stock',
    items: lots.map((l) => ({
      lotNumber: l.lotNumber,
      materialCode: l.materialCode,
      materialName: l.materialName,
      category: l.category,
      unit: l.unit,
      quantityInitial: l.quantityInitial,
      quantityAvailable: l.quantityAvailable,
      quantityAllocated: l.quantityAllocated ?? 0,
      reorderLevel: l.reorderLevel,
      unitCost: l.unitCost,
      supplier: l.supplier,
      expiryDate: l.expiryDate,
      storageZone: l.storageZone,
      status: l.status,
    })),
  };
}

export function buildWmsRawMaterialsCsv(lots: RawMaterialLot[]): string {
  const headers = [
    'lotNumber',
    'materialCode',
    'materialName',
    'category',
    'unit',
    'quantityInitial',
    'quantityAvailable',
    'quantityAllocated',
    'reorderLevel',
    'unitCost',
    'supplier',
    'expiryDate',
    'storageZone',
    'status',
  ];
  const lines = [headers.join(',')];
  for (const l of lots) {
    lines.push(
      [
        l.lotNumber,
        l.materialCode,
        l.materialName,
        l.category,
        l.unit,
        l.quantityInitial,
        l.quantityAvailable,
        l.quantityAllocated ?? 0,
        l.reorderLevel,
        l.unitCost,
        l.supplier,
        l.expiryDate,
        l.storageZone,
        l.status,
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }
  return lines.join('\n');
}

export function buildWmsFinishedGoodsJson(fgs: FinishedGoodLot[]): WmsFinishedGoodsPayload {
  return {
    schemaVersion: WMS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    recordType: 'finished_goods_lots',
    items: fgs.map((f) => ({
      lotNumber: f.lotNumber,
      batchNumber: f.batchNumber,
      sku: f.sku,
      productName: f.productName,
      quantityProduced: f.quantityProduced,
      quantityAvailable: f.quantityAvailable,
      unit: f.unit,
      productionDate: f.productionDate,
      expiryDate: f.expiryDate,
      qcStatus: f.qcStatus,
      warehouseZone: f.warehouseZone,
      unitCost: f.unitCost,
    })),
  };
}

export function buildWmsFinishedGoodsCsv(fgs: FinishedGoodLot[]): string {
  const headers = [
    'lotNumber',
    'batchNumber',
    'sku',
    'productName',
    'quantityProduced',
    'quantityAvailable',
    'unit',
    'productionDate',
    'expiryDate',
    'qcStatus',
    'warehouseZone',
    'unitCost',
  ];
  const lines = [headers.join(',')];
  for (const f of fgs) {
    lines.push(
      [
        f.lotNumber,
        f.batchNumber,
        f.sku,
        f.productName,
        f.quantityProduced,
        f.quantityAvailable,
        f.unit,
        f.productionDate,
        f.expiryDate,
        f.qcStatus,
        f.warehouseZone,
        f.unitCost,
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }
  return lines.join('\n');
}

// ---------- (a) Client-side Import File Parser (CSV or JSON) ----------

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}

export function parseWmsImportContent(
  content: string,
  fileName: string
): { items: Array<Record<string, unknown>>; errors: string[] } {
  const trimmed = content.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    return { items: [], errors: ['Import file is empty.'] };
  }

  const isJson =
    fileName.toLowerCase().endsWith('.json') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[');

  if (isJson) {
    try {
      const parsed = JSON.parse(trimmed);
      const items: Array<Record<string, unknown>> = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.items)
          ? parsed.items
          : Array.isArray(parsed?.data)
            ? parsed.data
            : [parsed];
      return {
        items: items.filter((r) => r && typeof r === 'object'),
        errors: [],
      };
    } catch (err) {
      return {
        items: [],
        errors: [err instanceof Error ? err.message : 'Invalid JSON format.'],
      };
    }
  }

  const table = splitDelimitedCsvRows(trimmed);
  if (table.length < 2) {
    return {
      items: [],
      errors: ['CSV must include a header row and at least one data row.'],
    };
  }
  const headers = table[0].map(normalizeCsvColumnKey);
  const items: Array<Record<string, unknown>> = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const row: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      if (h) {
        row[h] = cells[idx] ?? '';
      }
    });
    items.push(row);
  }
  return { items, errors: [] };
}

// ---------- (b) Optional External WMS REST Connector (Browser -> External WMS URL) ----------

function joinWmsUrl(baseUrl: string, subPath: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const path = subPath.trim().startsWith('/') ? subPath.trim() : `/${subPath.trim()}`;
  return `${base}${path}`;
}

async function wmsFetchJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`WMS REST endpoint returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`WMS REST request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function testWmsRestConnection(
  config: WmsConnectorConfig
): Promise<{ ok: boolean; message: string }> {
  if (!config.baseUrl.trim()) {
    return { ok: false, message: 'Enter a WMS Base URL first.' };
  }
  const url = joinWmsUrl(config.baseUrl, config.rawMaterialsPath);
  try {
    await wmsFetchJson<unknown>(url, { method: 'GET' }, config.timeoutMs);
    return { ok: true, message: `Connected cleanly to ${url}` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : `Unable to reach ${url}`,
    };
  }
}

export async function pullRawMaterialsFromWmsRest(
  config: WmsConnectorConfig
): Promise<Array<Record<string, unknown>>> {
  if (!config.enabled) {
    throw new Error('WMS REST Connector is switched OFF in Admin Settings.');
  }
  const url = joinWmsUrl(config.baseUrl, config.rawMaterialsPath);
  const data = await wmsFetchJson<unknown>(url, { method: 'GET' }, config.timeoutMs);
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown[] }).items)) {
    return (data as { items: Array<Record<string, unknown>> }).items;
  }
  throw new Error('WMS response must be a JSON array or { items: [...] }');
}

export async function pushFinishedGoodsToWmsRest(
  config: WmsConnectorConfig,
  finishedGoods: FinishedGoodLot[]
): Promise<{ status: string; count: number }> {
  if (!config.enabled) {
    throw new Error('WMS REST Connector is switched OFF in Admin Settings.');
  }
  const url = joinWmsUrl(config.baseUrl, config.finishedGoodsPath);
  const payload = buildWmsFinishedGoodsJson(finishedGoods);
  await wmsFetchJson<unknown>(
    url,
    { method: 'POST', body: JSON.stringify(payload) },
    config.timeoutMs
  );
  return { status: 'Synced', count: payload.items.length };
}

export async function pullFinishedGoodsFromWmsRest(
  config: WmsConnectorConfig
): Promise<Array<Record<string, unknown>>> {
  if (!config.enabled) {
    throw new Error('WMS REST Connector is switched OFF in Admin Settings.');
  }
  const url = joinWmsUrl(config.baseUrl, config.finishedGoodsPath);
  const data = await wmsFetchJson<unknown>(url, { method: 'GET' }, config.timeoutMs);
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown[] }).items)) {
    return (data as { items: Array<Record<string, unknown>> }).items;
  }
  throw new Error('WMS finished goods response must be a JSON array or { items: [...] }');
}
