import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileJson,
  FileSpreadsheet,
  Plus,
  Search,
  Settings,
  Trash2,
  Truck,
  Upload,
  X,
} from 'lucide-react';
import type {
  FinishedGoodLot,
  MaterialCategory,
  RawMaterialLot,
  UnitOfMeasure,
  WmsConnectorConfig,
} from '../types';
import { daysUntil, formatCurrency } from '../utils/units';
import {
  parseRawMaterialCsv,
  RAW_MATERIAL_CSV_TEMPLATE,
  type RawMaterialCsvParseResult,
} from '../utils/rawMaterialCsv';
import {
  buildWmsFinishedGoodsCsv,
  buildWmsFinishedGoodsJson,
  buildWmsRawMaterialsCsv,
  buildWmsRawMaterialsJson,
  parseWmsImportContent,
  triggerBrowserDownload,
} from '../services/wmsConnector';
import {
  adjustRawMaterialLot,
  deleteRawMaterialLot,
  importWmsFinishedGoods,
  importWmsRawMaterials,
  receiveRawMaterialLot,
  recordCustomerShipment,
} from '../services/mesService';

interface InventoryViewProps {
  ownerId: string;
  rawMaterials: RawMaterialLot[];
  finishedGoods: FinishedGoodLot[];
  wmsConfig?: WmsConnectorConfig;
  onOpenAdminSettings?: () => void;
  onNotify: (msg: string) => void;
}

export function InventoryView({
  ownerId,
  rawMaterials,
  finishedGoods,
  wmsConfig,
  onOpenAdminSettings,
  onNotify,
}: InventoryViewProps) {
  const [subTab, setSubTab] = useState<'raw' | 'finished'>('raw');
  const wmsFileInputRef = useRef<HTMLInputElement | null>(null);
  const csvModalInputRef = useRef<HTMLInputElement | null>(null);
  const [wmsBusy, setWmsBusy] = useState(false);
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [csvFileName, setCsvFileName] = useState('');
  const [csvParseResult, setCsvParseResult] = useState<RawMaterialCsvParseResult | null>(null);
  const [csvImportMode, setCsvImportMode] = useState<'set' | 'add'>('set');
  const [csvDragOver, setCsvDragOver] = useState(false);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'All' | MaterialCategory>('All');
  const [showReceiveModal, setShowReceiveModal] = useState(false);
  const [adjustingLot, setAdjustingLot] = useState<RawMaterialLot | null>(null);
  const [adjustMode, setAdjustMode] = useState<'add' | 'deduct' | 'set'>('add');
  const [adjustQty, setAdjustQty] = useState('100');
  const [editLotNumber, setEditLotNumber] = useState('');
  const [editReorderLevel, setEditReorderLevel] = useState('0');
  const [editUnitCost, setEditUnitCost] = useState('0');
  const [editExpiryDate, setEditExpiryDate] = useState('');
  const [editSupplier, setEditSupplier] = useState('');
  const [editStorageZone, setEditStorageZone] = useState('');
  const [confirmDeleteLotId, setConfirmDeleteLotId] = useState<string | null>(null);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [shippingLot, setShippingLot] = useState<FinishedGoodLot | null>(null);
  const [busy, setBusy] = useState(false);

  // Receive raw lot form
  const [lotNumber, setLotNumber] = useState(
    `RM-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-N1`
  );
  const [materialCode, setMaterialCode] = useState('ING-MNG-08');
  const [materialName, setMaterialName] = useState(
    'Aseptic Alphonso Mango Puree (Brix 16)'
  );
  const [category, setCategory] = useState<MaterialCategory>('Ingredient');
  const [unit, setUnit] = useState<UnitOfMeasure>('kg');
  const [qtyInitial, setQtyInitial] = useState('500');
  const [reorderLevel, setReorderLevel] = useState('250');
  const [unitCost, setUnitCost] = useState('3.75');
  const [supplier, setSupplier] = useState('Ratnagiri Orchard Exports');
  const [expiryDate, setExpiryDate] = useState('2027-06-15');
  const [storageZone, setStorageZone] = useState('Raw Ingredient Chiller B');

  // Shipment form
  const [shipRef, setShipRef] = useState(
    `SHP-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-021`
  );
  const [shipCustomer, setShipCustomer] = useState('Cascade Natural Markets');
  const [shipQty, setShipQty] = useState('200');
  const [shipDest, setShipDest] = useState('Portland Cold Hub');

  const filteredRaw = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rawMaterials.filter((lot) => {
      if (categoryFilter !== 'All' && lot.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        lot.lotNumber.toLowerCase().includes(q) ||
        lot.materialCode.toLowerCase().includes(q) ||
        lot.materialName.toLowerCase().includes(q) ||
        lot.supplier.toLowerCase().includes(q)
      );
    });
  }, [rawMaterials, categoryFilter, search]);

  const filteredFg = useMemo(() => {
    const q = search.trim().toLowerCase();
    return finishedGoods.filter((fg) => {
      if (!q) return true;
      return (
        fg.lotNumber.toLowerCase().includes(q) ||
        fg.batchNumber.toLowerCase().includes(q) ||
        fg.sku.toLowerCase().includes(q) ||
        fg.productName.toLowerCase().includes(q)
      );
    });
  }, [finishedGoods, search]);

  const rawValuation = useMemo(
    () => rawMaterials.reduce((sum, r) => sum + r.quantityAvailable * r.unitCost, 0),
    [rawMaterials]
  );

  const fgValuation = useMemo(
    () => finishedGoods.reduce((sum, f) => sum + f.quantityAvailable * f.unitCost, 0),
    [finishedGoods]
  );

  async function handleReceiveLot(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await receiveRawMaterialLot(ownerId, {
        lotNumber,
        materialCode,
        materialName,
        category,
        unit,
        quantityInitial: Number(qtyInitial) || 0,
        reorderLevel: Number(reorderLevel) || 0,
        unitCost: Number(unitCost) || 0,
        supplier,
        expiryDate,
        storageZone,
      });
      setShowReceiveModal(false);
      onNotify(`Received lot ${lotNumber} into ${storageZone}`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Unable to save incoming lot.');
    } finally {
      setBusy(false);
    }
  }

  function openAdjustModal(lot: RawMaterialLot) {
    setAdjustingLot(lot);
    setAdjustMode('add');
    setAdjustQty(String(Math.max(lot.reorderLevel, 100)));
    setEditLotNumber(lot.lotNumber);
    setEditReorderLevel(String(lot.reorderLevel));
    setEditUnitCost(String(lot.unitCost));
    setEditExpiryDate(lot.expiryDate);
    setEditSupplier(lot.supplier);
    setEditStorageZone(lot.storageZone);
    setConfirmDeleteLotId(null);
    setAdjustError(null);
  }

  async function handleAdjustSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!adjustingLot) return;
    const numericQty = Number(adjustQty);
    if (!Number.isFinite(numericQty) || numericQty < 0) {
      setAdjustError('Please enter a valid non-negative quantity.');
      return;
    }

    setBusy(true);
    setAdjustError(null);
    try {
      const updated = await adjustRawMaterialLot(adjustingLot.id, {
        mode: adjustMode,
        quantity: numericQty,
        ...(adjustMode === 'set'
          ? {
              lotNumber: editLotNumber,
              reorderLevel: Number(editReorderLevel),
              unitCost: Number(editUnitCost),
              expiryDate: editExpiryDate,
              supplier: editSupplier,
              storageZone: editStorageZone,
            }
          : {}),
      });

      setAdjustingLot(null);
      onNotify(
        `Updated ${updated.lotNumber}: available stock is now ${updated.quantityAvailable.toLocaleString()} ${updated.unit}.`
      );
    } catch (error) {
      setAdjustError(
        error instanceof Error ? error.message : 'Unable to adjust stock lot.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteRawLot(lot: RawMaterialLot) {
    setBusy(true);
    setAdjustError(null);
    try {
      await deleteRawMaterialLot(lot.id);
      setAdjustingLot(null);
      setConfirmDeleteLotId(null);
      onNotify(`Removed raw material lot ${lot.lotNumber}.`);
    } catch (error) {
      setAdjustError(
        error instanceof Error ? error.message : 'Unable to remove raw material lot.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleRecordShipment(e: React.FormEvent) {
    e.preventDefault();
    if (!shippingLot) return;
    setBusy(true);
    try {
      await recordCustomerShipment(shippingLot, {
        shipmentRef: shipRef,
        customerName: shipCustomer,
        quantityShipped: Number(shipQty) || 1,
        shippedDate: new Date().toISOString().slice(0, 10),
        destination: shipDest,
      });
      setShippingLot(null);
      onNotify(
        `Dispatched ${shipQty} ${shippingLot.unit} of lot ${shippingLot.lotNumber} to ${shipCustomer}`
      );
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to record shipment.'
      );
    } finally {
      setBusy(false);
    }
  }

  function makeNextShipRef(): string {
    const existingRefs = new Set(
      finishedGoods.flatMap((fg) => fg.shipments.map((s) => s.shipmentRef))
    );
    const dateStamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    let seq = 21 + existingRefs.size;
    let candidate = `SHP-${dateStamp}-${String(seq).padStart(3, '0')}`;
    while (existingRefs.has(candidate)) {
      seq += 1;
      candidate = `SHP-${dateStamp}-${String(seq).padStart(3, '0')}`;
    }
    return candidate;
  }

  async function handleWmsImportFile(file: File | undefined) {
    if (!file) return;
    setWmsBusy(true);
    try {
      const content = await file.text();
      const parsed = parseWmsImportContent(content, file.name);
      if (parsed.items.length === 0) {
        onNotify(parsed.errors[0] || 'No valid rows found in WMS import file.');
        return;
      }
      const res =
        subTab === 'raw'
          ? await importWmsRawMaterials(parsed.items, 'set')
          : await importWmsFinishedGoods(parsed.items);
      onNotify(
        `WMS ${subTab === 'raw' ? 'Raw Material' : 'Finished Goods'} Import: ${res.createdCount} created, ${res.updatedCount} updated, ${res.skippedCount} skipped.`
      );
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Unable to import WMS file.');
    } finally {
      setWmsBusy(false);
      if (wmsFileInputRef.current) wmsFileInputRef.current.value = '';
    }
  }

  async function handleSelectRawCsvFile(file: File | undefined) {
    if (!file) return;
    try {
      const content = await file.text();
      const parsed = parseRawMaterialCsv(content);
      setCsvFileName(file.name);
      setCsvParseResult(parsed);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Unable to read CSV file.');
    } finally {
      if (csvModalInputRef.current) csvModalInputRef.current.value = '';
    }
  }

  async function handleConfirmRawCsvImport() {
    if (!csvParseResult || csvParseResult.validRows.length === 0) return;
    setBusy(true);
    try {
      const payloadItems = csvParseResult.validRows.map((row) => ({
        lotNumber: row.lotNumber,
        materialCode: row.materialCode,
        materialName: row.materialName,
        category: row.category,
        unit: row.unit,
        quantityInitial: row.quantityInitial,
        quantityAvailable: row.quantityAvailable,
        reorderLevel: row.reorderLevel,
        unitCost: row.unitCost,
        supplier: row.supplier,
        expiryDate: row.expiryDate,
        storageZone: row.storageZone,
      }));
      const res = await importWmsRawMaterials(payloadItems, csvImportMode);
      setShowCsvModal(false);
      setCsvFileName('');
      setCsvParseResult(null);
      onNotify(
        `CSV Raw Material Import complete: ${res.createdCount} created, ${res.updatedCount} updated, ${res.skippedCount} skipped.`
      );
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Unable to import CSV raw materials.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Raw Material &amp; Packaging Value</div>
          <div className="mt-1 font-mono text-xl font-semibold text-slate-900 tabular-nums">
            {formatCurrency(rawValuation)}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {rawMaterials.length} tracked lots ·{' '}
            {rawMaterials.filter((m) => m.status === 'Low' || m.status === 'Depleted').length} below
            reorder
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">QC-Released Finished Goods Value</div>
          <div className="mt-1 font-mono text-xl font-semibold text-slate-900 tabular-nums">
            {formatCurrency(fgValuation)}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {finishedGoods.reduce((s, f) => s + f.quantityAvailable, 0).toLocaleString()} units
            available across {finishedGoods.length} lots
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs text-slate-500">Auto-Posting Integration</div>
          <div className="mt-1 text-sm font-semibold text-emerald-700">
            Zero manual FG stock keying
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Passed batches auto-post with batch/lot ID and calculated expiry date
          </div>
        </div>
      </div>

      {/* Sub-navigation & Filters */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setSubTab('raw')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'raw'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Raw Materials &amp; Packaging ({rawMaterials.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('finished')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'finished'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Finished Goods Inventory ({finishedGoods.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {subTab === 'raw' && (
            <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
              {(['All', 'Ingredient', 'Packaging'] as const).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                    categoryFilter === cat
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}

          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search lot, SKU, supplier..."
              className="pl-9 pr-3 py-1.5 text-sm bg-white border border-slate-200 rounded-md w-56 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
            />
          </div>

          {subTab === 'raw' && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setCsvFileName('');
                  setCsvParseResult(null);
                  setCsvImportMode('set');
                  setShowCsvModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:border-teal-600 rounded-md whitespace-nowrap"
              >
                <Upload className="w-3.5 h-3.5 text-teal-700" />
                Import CSV
              </button>
              <button
                type="button"
                onClick={() => setShowReceiveModal(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                Receive Raw Lot
              </button>
            </div>
          )}
        </div>
      </div>

      {/* WMS File Exchange Bar (Works 100% Without Server) */}
      <div className="bg-white border border-slate-200 rounded-lg px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span className="font-semibold text-slate-800">
            WMS Exchange ({subTab === 'raw' ? 'Raw Material Stock' : 'Finished Goods Lots'}):
          </span>
          <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-slate-100 text-slate-700">
            {wmsConfig?.enabled ? 'REST Connector ON' : 'File Mode (No WMS Server Required)'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const stamp = new Date().toISOString().slice(0, 10);
              if (subTab === 'raw') {
                triggerBrowserDownload(
                  JSON.stringify(buildWmsRawMaterialsJson(rawMaterials), null, 2),
                  `wms-raw-materials-${stamp}.json`,
                  'application/json'
                );
              } else {
                triggerBrowserDownload(
                  JSON.stringify(buildWmsFinishedGoodsJson(finishedGoods), null, 2),
                  `wms-finished-goods-${stamp}.json`,
                  'application/json'
                );
              }
              onNotify(
                `Exported ${subTab === 'raw' ? rawMaterials.length + ' raw lots' : finishedGoods.length + ' FG lots'} as mayralab-wms-v1 JSON.`
              );
            }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-[#F7F8FA] border border-slate-200 hover:border-teal-600 rounded-md"
          >
            <FileJson className="w-3.5 h-3.5 text-teal-700" />
            Export JSON
          </button>
          <button
            type="button"
            onClick={() => {
              const stamp = new Date().toISOString().slice(0, 10);
              if (subTab === 'raw') {
                triggerBrowserDownload(
                  buildWmsRawMaterialsCsv(rawMaterials),
                  `wms-raw-materials-${stamp}.csv`,
                  'text/csv;charset=utf-8'
                );
              } else {
                triggerBrowserDownload(
                  buildWmsFinishedGoodsCsv(finishedGoods),
                  `wms-finished-goods-${stamp}.csv`,
                  'text/csv;charset=utf-8'
                );
              }
              onNotify(
                `Exported ${subTab === 'raw' ? rawMaterials.length + ' raw lots' : finishedGoods.length + ' FG lots'} as CSV.`
              );
            }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-[#F7F8FA] border border-slate-200 hover:border-teal-600 rounded-md"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
            Export CSV
          </button>
          <input
            ref={wmsFileInputRef}
            type="file"
            accept=".json,.csv,application/json,text/csv"
            className="hidden"
            onChange={(e) => void handleWmsImportFile(e.target.files?.[0])}
          />
          <button
            type="button"
            disabled={wmsBusy}
            onClick={() => wmsFileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded-md"
          >
            <Upload className="w-3.5 h-3.5" />
            {wmsBusy ? 'Importing...' : 'Import JSON / CSV'}
          </button>
          {onOpenAdminSettings && (
            <button
              type="button"
              onClick={onOpenAdminSettings}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 hover:border-teal-600 rounded-md"
            >
              <Settings className="w-3.5 h-3.5" />
              WMS Config
            </button>
          )}
        </div>
      </div>

      {/* Data Table */}
      {subTab === 'raw' ? (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#F7F8FA] border-b border-slate-200 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-4">Lot Number</th>
                  <th className="py-2.5 px-4">Material &amp; Code</th>
                  <th className="py-2.5 px-4">Supplier &amp; Zone</th>
                  <th className="py-2.5 px-4 text-right">Available</th>
                  <th className="py-2.5 px-4 text-right">Unit Cost</th>
                  <th className="py-2.5 px-4">Expiry</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredRaw.map((lot) => {
                  const expDays = daysUntil(lot.expiryDate);
                  return (
                    <tr key={lot.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 px-4 font-mono text-xs font-semibold text-slate-900">
                        {lot.lotNumber}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{lot.materialName}</div>
                        <div className="text-xs text-slate-500">
                          <span className="font-mono">{lot.materialCode}</span> · {lot.category}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-slate-800 text-xs">{lot.supplier}</div>
                        <div className="text-xs text-slate-500">{lot.storageZone}</div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">
                        <div className="font-semibold text-slate-900">
                          {lot.quantityAvailable.toLocaleString()} {lot.unit}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Min {lot.reorderLevel} {lot.unit}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-slate-700">
                        {formatCurrency(lot.unitCost)}/{lot.unit}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-mono text-xs text-slate-900">{lot.expiryDate}</div>
                        <div
                          className={`text-[11px] tabular-nums ${
                            expDays <= 30 ? 'text-amber-700 font-medium' : 'text-slate-500'
                          }`}
                        >
                          {expDays > 0 ? `${expDays}d left` : 'Expired'}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`text-xs font-medium ${
                            lot.status === 'Available'
                              ? 'text-emerald-700'
                              : lot.status === 'Low'
                                ? 'text-amber-700'
                                : 'text-red-700'
                          }`}
                        >
                          {lot.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => openAdjustModal(lot)}
                          className="text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
                        >
                          Replenish / Adjust
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#F7F8FA] border-b border-slate-200 text-xs font-medium text-slate-500">
                  <th className="py-2.5 px-4">Finished Lot / Batch</th>
                  <th className="py-2.5 px-4">Product &amp; SKU</th>
                  <th className="py-2.5 px-4">Warehouse</th>
                  <th className="py-2.5 px-4 text-right">On Hand / Produced</th>
                  <th className="py-2.5 px-4 text-right">Unit Cost</th>
                  <th className="py-2.5 px-4">Prod · Expiry</th>
                  <th className="py-2.5 px-4">Shipments</th>
                  <th className="py-2.5 px-4 text-right">Dispatch</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredFg.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-sm text-slate-500">
                      No finished goods posted yet. Pass a batch in QC Hold to auto-post inventory.
                    </td>
                  </tr>
                ) : (
                  filteredFg.map((fg) => (
                    <tr key={fg.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 px-4">
                        <div className="font-mono text-xs font-semibold text-slate-900">
                          {fg.lotNumber}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">
                          Batch {fg.batchNumber}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{fg.productName}</div>
                        <div className="font-mono text-xs text-slate-500">{fg.sku}</div>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-700">
                        <div>{fg.warehouseZone}</div>
                        <div className="text-emerald-700 font-medium">{fg.qcStatus}</div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">
                        <div className="font-semibold text-slate-900">
                          {fg.quantityAvailable.toLocaleString()} {fg.unit}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          of {fg.quantityProduced.toLocaleString()} produced
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-slate-800">
                        {formatCurrency(fg.unitCost)}
                      </td>
                      <td className="py-3 px-4 font-mono text-xs">
                        <div className="text-slate-600">{fg.productionDate}</div>
                        <div className="text-slate-900 font-medium">Exp {fg.expiryDate}</div>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600">
                        {fg.shipments.length === 0 ? (
                          <span className="text-slate-400">In stock</span>
                        ) : (
                          fg.shipments.map((s, idx) => (
                            <div
                              key={`${fg.id}-${s.shipmentRef}-${idx}`}
                              className="truncate max-w-[180px]"
                            >
                              {s.customerName} ({s.quantityShipped})
                            </div>
                          ))
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          disabled={fg.quantityAvailable <= 0}
                          onClick={() => {
                            setShipRef(makeNextShipRef());
                            setShippingLot(fg);
                            setShipQty(String(Math.min(200, fg.quantityAvailable)));
                          }}
                          className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-800 disabled:text-slate-400 whitespace-nowrap"
                        >
                          <Truck className="w-3.5 h-3.5" />
                          Ship Lot
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Receive Raw Material Lot Modal */}
      {showReceiveModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                Receive Raw Material / Packaging Lot
              </h3>
              <button
                type="button"
                onClick={() => setShowReceiveModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={(e) => void handleReceiveLot(e)} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Incoming Lot Number
                  </label>
                  <input
                    type="text"
                    required
                    value={lotNumber}
                    onChange={(e) => setLotNumber(e.target.value)}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Material Code
                  </label>
                  <input
                    type="text"
                    required
                    value={materialCode}
                    onChange={(e) => setMaterialCode(e.target.value)}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Material Description
                </label>
                <input
                  type="text"
                  required
                  value={materialName}
                  onChange={(e) => setMaterialName(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Category</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as MaterialCategory)}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm bg-white"
                  >
                    <option value="Ingredient">Ingredient</option>
                    <option value="Packaging">Packaging</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Unit</label>
                  <select
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as UnitOfMeasure)}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm bg-white font-mono"
                  >
                    <option value="kg">kg</option>
                    <option value="g">g</option>
                    <option value="L">L</option>
                    <option value="ml">ml</option>
                    <option value="pcs">pcs</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Received Qty
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    required
                    value={qtyInitial}
                    onChange={(e) => setQtyInitial(e.target.value)}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Reorder Level
                  </label>
                  <input
                    type="number"
                    required
                    value={reorderLevel}
                    onChange={(e) => setReorderLevel(e.target.value)}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Unit Cost ($)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={unitCost}
                    onChange={(e) => setUnitCost(e.target.value)}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Expiry Date
                  </label>
                  <input
                    type="date"
                    required
                    value={expiryDate}
                    onChange={(e) => setExpiryDate(e.target.value)}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Supplier</label>
                  <input
                    type="text"
                    required
                    value={supplier}
                    onChange={(e) => setSupplier(e.target.value)}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Storage Zone
                  </label>
                  <input
                    type="text"
                    required
                    value={storageZone}
                    onChange={(e) => setStorageZone(e.target.value)}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm"
                  />
                </div>
              </div>
              <div className="pt-2 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowReceiveModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                >
                  Save Incoming Lot
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Ship Finished Goods Modal */}
      {shippingLot && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                Record Customer Shipment
              </h3>
              <button
                type="button"
                onClick={() => setShippingLot(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600">
              Lot <span className="font-mono font-semibold">{shippingLot.lotNumber}</span> ·{' '}
              {shippingLot.productName} ({shippingLot.quantityAvailable} {shippingLot.unit}{' '}
              available)
            </p>
            <form onSubmit={(e) => void handleRecordShipment(e)} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Shipment Reference
                </label>
                <input
                  type="text"
                  required
                  value={shipRef}
                  onChange={(e) => setShipRef(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Customer</label>
                <input
                  type="text"
                  required
                  value={shipCustomer}
                  onChange={(e) => setShipCustomer(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Quantity ({shippingLot.unit})
                  </label>
                  <input
                    type="number"
                    required
                    min={1}
                    max={shippingLot.quantityAvailable}
                    value={shipQty}
                    onChange={(e) => setShipQty(e.target.value)}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Destination Hub
                  </label>
                  <input
                    type="text"
                    required
                    value={shipDest}
                    onChange={(e) => setShipDest(e.target.value)}
                    className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm"
                  />
                </div>
              </div>
              <div className="pt-2 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShippingLot(null)}
                  className="px-4 py-2 text-xs font-medium text-slate-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
                >
                  Confirm Dispatch
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Adjust / Replenish / Correct Raw Material Lot Modal */}
      {adjustingLot && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-lg w-full p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Replenish or Correct Stock Lot
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  <span className="font-mono font-semibold text-slate-700">
                    {adjustingLot.lotNumber}
                  </span>{' '}
                  · {adjustingLot.materialName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setAdjustingLot(null);
                  setConfirmDeleteLotId(null);
                  setAdjustError(null);
                }}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Adjustment Mode Tabs */}
            <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-md">
              <button
                type="button"
                onClick={() => {
                  setAdjustMode('add');
                  setAdjustQty(String(Math.max(adjustingLot.reorderLevel, 100)));
                  setAdjustError(null);
                }}
                className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  adjustMode === 'add'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                + Add Stock
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdjustMode('deduct');
                  setAdjustQty('100');
                  setAdjustError(null);
                }}
                className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  adjustMode === 'deduct'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                - Deduct / Reverse
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdjustMode('set');
                  setAdjustQty(String(adjustingLot.quantityAvailable));
                  setAdjustError(null);
                }}
                className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                  adjustMode === 'set'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Set Exact &amp; Edit
              </button>
            </div>

            {adjustError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                {adjustError}
              </div>
            )}

            <form onSubmit={(e) => void handleAdjustSubmit(e)} className="space-y-4">
              {/* Live Stock Preview */}
              {(() => {
                const parsed = Number(adjustQty);
                const valid = Number.isFinite(parsed) && parsed >= 0;
                const nextQty = !valid
                  ? adjustingLot.quantityAvailable
                  : adjustMode === 'add'
                    ? Number((adjustingLot.quantityAvailable + parsed).toFixed(3))
                    : adjustMode === 'deduct'
                      ? Number(Math.max(0, adjustingLot.quantityAvailable - parsed).toFixed(3))
                      : Number(Math.max(0, parsed).toFixed(3));
                return (
                  <div className="bg-[#F7F8FA] border border-slate-200 rounded-md px-3.5 py-2.5 flex items-center justify-between text-xs">
                    <div>
                      <span className="text-slate-500">Current On Hand:</span>{' '}
                      <span className="font-mono font-semibold text-slate-900 tabular-nums">
                        {adjustingLot.quantityAvailable.toLocaleString()} {adjustingLot.unit}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">After Save:</span>{' '}
                      <span className="font-mono font-semibold text-teal-800 tabular-nums">
                        {nextQty.toLocaleString()} {adjustingLot.unit}
                      </span>
                    </div>
                  </div>
                );
              })()}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {adjustMode === 'add'
                    ? `Quantity to Add (${adjustingLot.unit})`
                    : adjustMode === 'deduct'
                      ? `Quantity to Deduct / Reverse (${adjustingLot.unit})`
                      : `Exact Physical Available Stock (${adjustingLot.unit})`}
                </label>
                <input
                  type="number"
                  step="0.001"
                  min={0}
                  required
                  value={adjustQty}
                  onChange={(e) => setAdjustQty(e.target.value)}
                  className="w-full border border-slate-200 rounded px-3 py-2 text-sm font-mono tabular-nums focus:outline-none focus:border-teal-600"
                />
                {adjustMode === 'deduct' && (
                  <p className="mt-1 text-[11px] text-slate-500">
                    Use this if stock was replenished twice or entered too high. Cannot drop below 0.
                  </p>
                )}
              </div>

              {adjustMode === 'set' && (
                <div className="space-y-3 pt-2 border-t border-slate-100">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        Lot Number
                      </label>
                      <input
                        type="text"
                        required
                        value={editLotNumber}
                        onChange={(e) => setEditLotNumber(e.target.value)}
                        className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        Expiry Date
                      </label>
                      <input
                        type="date"
                        required
                        value={editExpiryDate}
                        onChange={(e) => setEditExpiryDate(e.target.value)}
                        className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        Reorder Level ({adjustingLot.unit})
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        min={0}
                        required
                        value={editReorderLevel}
                        onChange={(e) => setEditReorderLevel(e.target.value)}
                        className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        Unit Cost ($/{adjustingLot.unit})
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        required
                        value={editUnitCost}
                        onChange={(e) => setEditUnitCost(e.target.value)}
                        className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        Supplier
                      </label>
                      <input
                        type="text"
                        required
                        value={editSupplier}
                        onChange={(e) => setEditSupplier(e.target.value)}
                        className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        Storage Zone
                      </label>
                      <input
                        type="text"
                        required
                        value={editStorageZone}
                        onChange={(e) => setEditStorageZone(e.target.value)}
                        className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-xs"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
                <div>
                  {confirmDeleteLotId === adjustingLot.id ? (
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleDeleteRawLot(adjustingLot)}
                        className="px-2.5 py-1.5 text-xs font-medium text-white bg-red-700 hover:bg-red-800 rounded"
                      >
                        Confirm Remove Lot
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteLotId(null)}
                        className="text-xs text-slate-500 hover:text-slate-800"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmDeleteLotId(adjustingLot.id)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-red-700 hover:text-red-800"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete Wrong Lot
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setAdjustingLot(null);
                      setConfirmDeleteLotId(null);
                    }}
                    className="px-3.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className={`px-4 py-2 text-xs font-medium text-white rounded-md whitespace-nowrap ${
                      adjustMode === 'deduct'
                        ? 'bg-amber-700 hover:bg-amber-800'
                        : 'bg-teal-700 hover:bg-teal-800'
                    }`}
                  >
                    {busy
                      ? 'Saving...'
                      : adjustMode === 'add'
                        ? 'Confirm Add Stock'
                        : adjustMode === 'deduct'
                          ? 'Confirm Deduction'
                          : 'Save Correction'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Upload Raw Material CSV Modal */}
      {showCsvModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-lg max-w-4xl w-full p-6 space-y-4 my-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Import Raw Materials — Upload CSV
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Upload a CSV spreadsheet to bulk-create new raw material lots or update existing lot stock.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCsvModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-[#F7F8FA] border border-slate-200 rounded-md">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-slate-700">If Lot Number Already Exists:</span>
                <div className="flex items-center gap-1 p-0.5 bg-slate-200/70 rounded">
                  <button
                    type="button"
                    onClick={() => setCsvImportMode('set')}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                      csvImportMode === 'set'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Sync / Set Exact Qty
                  </button>
                  <button
                    type="button"
                    onClick={() => setCsvImportMode('add')}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                      csvImportMode === 'add'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Add Received Qty
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  triggerBrowserDownload(
                    RAW_MATERIAL_CSV_TEMPLATE,
                    'raw-materials-import-template.csv',
                    'text/csv;charset=utf-8'
                  );
                  onNotify('Downloaded raw-materials-import-template.csv');
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-800 bg-white border border-teal-200 hover:border-teal-500 rounded-md"
              >
                <Download className="w-3.5 h-3.5" />
                Download CSV Template
              </button>
            </div>

            <input
              ref={csvModalInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => void handleSelectRawCsvFile(e.target.files?.[0])}
            />
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setCsvDragOver(true);
              }}
              onDragLeave={() => setCsvDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setCsvDragOver(false);
                void handleSelectRawCsvFile(e.dataTransfer.files?.[0]);
              }}
              onClick={() => csvModalInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                csvDragOver
                  ? 'border-teal-600 bg-teal-50/60'
                  : 'border-slate-300 bg-slate-50/50 hover:border-teal-500 hover:bg-slate-50'
              }`}
            >
              <Upload className="w-6 h-6 text-teal-700 mx-auto mb-2" />
              <div className="text-sm font-medium text-slate-900">
                {csvFileName ? `Selected: ${csvFileName}` : 'Click to choose a CSV file or drag & drop here'}
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Required columns: <span className="font-mono">lotNumber</span>,{' '}
                <span className="font-mono">materialCode</span>,{' '}
                <span className="font-mono">materialName</span>,{' '}
                <span className="font-mono">quantityAvailable</span> (flexible header names &amp; comma/semicolon delimiters supported).
              </p>
            </div>

            {csvParseResult && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-4">
                    <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {csvParseResult.validRows.length} valid row(s)
                    </span>
                    {csvParseResult.invalidRows.length > 0 && (
                      <span className="inline-flex items-center gap-1 font-medium text-red-700">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        {csvParseResult.invalidRows.length} invalid row(s) will be skipped
                      </span>
                    )}
                  </div>
                  <span className="text-slate-500">
                    Total parsed: {csvParseResult.rows.length}
                  </span>
                </div>

                {csvParseResult.errors.length > 0 && (
                  <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                    {csvParseResult.errors[0]}
                  </div>
                )}

                {csvParseResult.rows.length > 0 && (
                  <div className="overflow-x-auto border border-slate-200 rounded-md max-h-64 overflow-y-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium sticky top-0">
                          <th className="py-2 px-3">Row</th>
                          <th className="py-2 px-3">Action</th>
                          <th className="py-2 px-3">Lot Number</th>
                          <th className="py-2 px-3">Material</th>
                          <th className="py-2 px-3 text-right">Qty</th>
                          <th className="py-2 px-3 text-right">Cost</th>
                          <th className="py-2 px-3">Supplier / Zone</th>
                          <th className="py-2 px-3">Expiry</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {csvParseResult.rows.map((row) => {
                          const existingLot = rawMaterials.find(
                            (r) =>
                              row.lotNumber &&
                              r.lotNumber.toUpperCase() === row.lotNumber.toUpperCase()
                          );
                          return (
                            <tr
                              key={row.rowNumber}
                              className={row.error ? 'bg-red-50/50' : 'hover:bg-slate-50'}
                            >
                              <td className="py-2 px-3 font-mono text-slate-500">
                                {row.rowNumber}
                              </td>
                              <td className="py-2 px-3 whitespace-nowrap">
                                {row.error ? (
                                  <span className="text-red-700 font-medium">{row.error}</span>
                                ) : existingLot ? (
                                  <span className="text-sky-800 font-medium">
                                    {csvImportMode === 'add' ? 'Add to Lot' : 'Update Lot'}
                                  </span>
                                ) : (
                                  <span className="text-emerald-700 font-medium">New Lot</span>
                                )}
                              </td>
                              <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                                {row.lotNumber || '—'}
                              </td>
                              <td className="py-2 px-3">
                                <div className="font-medium text-slate-900">
                                  {row.materialName || '—'}
                                </div>
                                <div className="font-mono text-[11px] text-slate-500">
                                  {row.materialCode || '—'} · {row.category}
                                </div>
                              </td>
                              <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-900">
                                {row.quantityAvailable.toLocaleString()} {row.unit}
                              </td>
                              <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-700">
                                {formatCurrency(row.unitCost)}
                              </td>
                              <td className="py-2 px-3 text-slate-600">
                                <div>{row.supplier}</div>
                                <div className="text-[11px] text-slate-400">{row.storageZone}</div>
                              </td>
                              <td className="py-2 px-3 font-mono text-slate-700">
                                {row.expiryDate}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div className="pt-2 border-t border-slate-100 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowCsvModal(false)}
                className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !csvParseResult || csvParseResult.validRows.length === 0}
                onClick={() => void handleConfirmRawCsvImport()}
                className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-45 rounded-md whitespace-nowrap"
              >
                {busy
                  ? 'Importing...'
                  : `Import ${csvParseResult?.validRows.length || 0} Valid Lot${
                      (csvParseResult?.validRows.length || 0) === 1 ? '' : 's'
                    }`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
