import type { MaterialCategory, UnitOfMeasure } from '../types';

export interface ParsedRawMaterialCsvRow {
  rowNumber: number;
  lotNumber: string;
  materialCode: string;
  materialName: string;
  category: MaterialCategory;
  unit: UnitOfMeasure;
  quantityInitial: number;
  quantityAvailable: number;
  reorderLevel: number;
  unitCost: number;
  supplier: string;
  expiryDate: string;
  storageZone: string;
  error?: string;
}

export interface RawMaterialCsvParseResult {
  rows: ParsedRawMaterialCsvRow[];
  validRows: ParsedRawMaterialCsvRow[];
  invalidRows: ParsedRawMaterialCsvRow[];
  detectedHeaders: string[];
  errors: string[];
}

export const RAW_MATERIAL_CSV_TEMPLATE = [
  'lotNumber,materialCode,materialName,category,unit,quantityAvailable,reorderLevel,unitCost,supplier,expiryDate,storageZone',
  'RM-261121-A1,ING-STR-01,Organic Strawberry Puree (Brix 11),Ingredient,kg,450,150,4.20,Willamette Berry Farms,2027-08-15,Raw Ingredient Chiller A',
  'RM-261121-P1,PKG-JAR-500,500ml Flint Glass Jar + Twist Cap,Packaging,pcs,2400,500,0.48,Pacific Glassworks,2029-12-31,Dry Packaging Bay 3',
].join('\n');

const HEADER_ALIASES: Record<string, string> = {
  lotnumber: 'lotNumber',
  lotno: 'lotNumber',
  lot: 'lotNumber',
  lotid: 'lotNumber',
  batchlot: 'lotNumber',
  incominglot: 'lotNumber',
  incominglotnumber: 'lotNumber',
  rmlot: 'lotNumber',

  materialcode: 'materialCode',
  code: 'materialCode',
  sku: 'materialCode',
  itemcode: 'materialCode',
  partnumber: 'materialCode',
  ingredientcode: 'materialCode',
  rmcode: 'materialCode',

  materialname: 'materialName',
  name: 'materialName',
  description: 'materialName',
  materialdescription: 'materialName',
  itemname: 'materialName',
  ingredientname: 'materialName',
  material: 'materialName',

  category: 'category',
  type: 'category',
  materialcategory: 'category',
  group: 'category',

  unit: 'unit',
  uom: 'unit',
  unitofmeasure: 'unit',
  measure: 'unit',

  quantityavailable: 'quantityAvailable',
  available: 'quantityAvailable',
  availableqty: 'quantityAvailable',
  qtyavailable: 'quantityAvailable',
  onhand: 'quantityAvailable',
  onhandqty: 'quantityAvailable',
  qty: 'quantityAvailable',
  quantity: 'quantityAvailable',
  receivedqty: 'quantityAvailable',
  stock: 'quantityAvailable',
  stockqty: 'quantityAvailable',

  quantityinitial: 'quantityInitial',
  initialqty: 'quantityInitial',
  openingqty: 'quantityInitial',

  reorderlevel: 'reorderLevel',
  reorder: 'reorderLevel',
  minqty: 'reorderLevel',
  minlevel: 'reorderLevel',
  safetystock: 'reorderLevel',

  unitcost: 'unitCost',
  cost: 'unitCost',
  price: 'unitCost',
  costperunit: 'unitCost',
  unitprice: 'unitCost',

  supplier: 'supplier',
  vendor: 'supplier',
  manufacturer: 'supplier',
  source: 'supplier',

  expirydate: 'expiryDate',
  expiry: 'expiryDate',
  expdate: 'expiryDate',
  expiration: 'expiryDate',
  expirationdate: 'expiryDate',
  bestbefore: 'expiryDate',

  storagezone: 'storageZone',
  zone: 'storageZone',
  location: 'storageZone',
  warehousezone: 'storageZone',
  bin: 'storageZone',
  rack: 'storageZone',
};

export function normalizeCsvColumnKey(rawHeader: string): string {
  const cleaned = rawHeader
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return HEADER_ALIASES[cleaned] || rawHeader.replace(/^\uFEFF/, '').trim();
}

function detectCsvDelimiter(headerLine: string): ',' | ';' | '\t' {
  let commas = 0;
  let semis = 0;
  let tabs = 0;
  let inQuotes = false;
  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === ',') commas++;
      else if (ch === ';') semis++;
      else if (ch === '\t') tabs++;
    }
  }
  if (tabs > commas && tabs >= semis) return '\t';
  if (semis > commas && semis > tabs) return ';';
  return ',';
}

export function splitDelimitedCsvRows(text: string): string[][] {
  const cleanText = text.replace(/^\uFEFF/, '').trim();
  if (!cleanText) return [];
  const firstNewline = cleanText.search(/\r?\n/);
  const firstLine = firstNewline === -1 ? cleanText : cleanText.slice(0, firstNewline);
  const delimiter = detectCsvDelimiter(firstLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];
    if (ch === '"') {
      if (inQuotes && cleanText[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      row.push(cell.trim());
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && cleanText[i + 1] === '\n') {
        i++;
      }
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell.trim());
  if (row.some((c) => c.length > 0)) {
    rows.push(row);
  }
  return rows;
}

function parseNumericCell(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[$€£¥,\s]/g, '');
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

export function normalizeRawUnit(raw: unknown): UnitOfMeasure {
  const val = String(raw ?? '').trim().toLowerCase();
  if (val === 'g' || val === 'gram' || val === 'grams') return 'g';
  if (val === 'l' || val === 'lt' || val === 'ltr' || val === 'liter' || val === 'liters' || val === 'litre' || val === 'litres') return 'L';
  if (val === 'ml' || val === 'milliliter' || val === 'milliliters') return 'ml';
  if (val === 'pcs' || val === 'pc' || val === 'ea' || val === 'each' || val === 'unit' || val === 'units') return 'pcs';
  return 'kg';
}

export function normalizeRawCategory(raw: unknown): MaterialCategory {
  const val = String(raw ?? '').trim().toLowerCase();
  if (val.includes('pack')) return 'Packaging';
  return 'Ingredient';
}

function normalizeDateCell(raw: unknown): string {
  const str = String(raw ?? '').trim();
  if (!str) return '2027-12-31';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str);
  if (slashMatch) {
    const [, m, d, y] = slashMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return str.slice(0, 20);
}

export function parseRawMaterialCsv(csvText: string): RawMaterialCsvParseResult {
  const table = splitDelimitedCsvRows(csvText);
  if (table.length === 0) {
    return {
      rows: [],
      validRows: [],
      invalidRows: [],
      detectedHeaders: [],
      errors: ['CSV file is empty.'],
    };
  }
  if (table.length < 2) {
    return {
      rows: [],
      validRows: [],
      invalidRows: [],
      detectedHeaders: table[0].map(normalizeCsvColumnKey),
      errors: ['CSV must include a header row and at least one raw material data row.'],
    };
  }

  const rawHeaders = table[0];
  const mappedHeaders = rawHeaders.map(normalizeCsvColumnKey);
  const rows: ParsedRawMaterialCsvRow[] = [];

  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const record: Record<string, string> = {};
    mappedHeaders.forEach((key, idx) => {
      if (key) {
        record[key] = cells[idx] ?? '';
      }
    });

    const lotNumber = String(record.lotNumber || '').trim().slice(0, 64);
    const materialCode = String(record.materialCode || '').trim().slice(0, 48);
    const materialName = String(record.materialName || '').trim().slice(0, 120);
    const qtyAvail = parseNumericCell(record.quantityAvailable ?? record.quantityInitial);
    const qtyInit = parseNumericCell(record.quantityInitial);
    const reorderParsed = parseNumericCell(record.reorderLevel);
    const unitCostParsed = parseNumericCell(record.unitCost);

    const issues: string[] = [];
    if (!lotNumber) issues.push('Missing Lot Number');
    if (!materialCode) issues.push('Missing Material Code');
    if (!materialName) issues.push('Missing Material Name');
    if (qtyAvail === null || qtyAvail < 0) issues.push('Invalid Quantity');

    const safeQtyAvail = qtyAvail !== null && qtyAvail >= 0 ? qtyAvail : 0;
    const safeQtyInit =
      qtyInit !== null && qtyInit >= safeQtyAvail ? qtyInit : safeQtyAvail;

    rows.push({
      rowNumber: i + 1,
      lotNumber,
      materialCode,
      materialName,
      category: normalizeRawCategory(record.category),
      unit: normalizeRawUnit(record.unit),
      quantityInitial: safeQtyInit,
      quantityAvailable: safeQtyAvail,
      reorderLevel: reorderParsed !== null && reorderParsed >= 0 ? reorderParsed : 50,
      unitCost: unitCostParsed !== null && unitCostParsed >= 0 ? unitCostParsed : 0,
      supplier: String(record.supplier || 'CSV Import').trim().slice(0, 120) || 'CSV Import',
      expiryDate: normalizeDateCell(record.expiryDate),
      storageZone:
        String(record.storageZone || 'Raw Receiving Dock').trim().slice(0, 80) ||
        'Raw Receiving Dock',
      error: issues.length > 0 ? issues.join(', ') : undefined,
    });
  }

  const validRows = rows.filter((r) => !r.error);
  const invalidRows = rows.filter((r) => Boolean(r.error));

  return {
    rows,
    validRows,
    invalidRows,
    detectedHeaders: mappedHeaders,
    errors:
      validRows.length === 0
        ? ['No valid raw material rows found. Verify column headers (lotNumber, materialCode, materialName, quantityAvailable).']
        : [],
  };
}
