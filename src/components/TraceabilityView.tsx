import { useMemo, useState } from 'react';
import { ArrowRight, Download, FileText, GitBranch, Search } from 'lucide-react';
import type {
  BackwardGenealogyResponse,
  FinishedGoodLot,
  ProductionBatch,
  RawMaterialLot,
} from '../types';
import { fetchFinishedGoodGenealogy } from '../services/mesService';

interface TraceabilityViewProps {
  batches: ProductionBatch[];
  rawMaterials: RawMaterialLot[];
  finishedGoods: FinishedGoodLot[];
  onOpenBatch: (batchId: string) => void;
  onOpenBatchReport: (batchId: string) => void;
}

export function TraceabilityView({
  batches,
  rawMaterials,
  finishedGoods,
  onOpenBatch,
  onOpenBatchReport,
}: TraceabilityViewProps) {
  const [query, setQuery] = useState('RM-TOM-261014-A');
  const [serverTrace, setServerTrace] = useState<BackwardGenealogyResponse | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);

  const quickExamples = useMemo(() => {
    const list: string[] = [];
    if (rawMaterials[0]) list.push(rawMaterials[0].lotNumber);
    if (finishedGoods[0]) list.push(finishedGoods[0].lotNumber);
    if (finishedGoods[1]?.shipments[0]) list.push(finishedGoods[1].shipments[0].customerName);
    if (batches[2]) list.push(batches[2].batchNumber);
    return list;
  }, [rawMaterials, finishedGoods, batches]);

  const traceResult = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return {
        matchedRawLots: [] as RawMaterialLot[],
        matchedBatches: [] as ProductionBatch[],
        matchedFgLots: [] as FinishedGoodLot[],
      };
    }

    // 1. Direct matches across all 3 stages
    const directRaw = rawMaterials.filter(
      (r) =>
        r.lotNumber.toLowerCase().includes(q) ||
        r.materialCode.toLowerCase().includes(q) ||
        r.materialName.toLowerCase().includes(q) ||
        r.supplier.toLowerCase().includes(q)
    );

    const directFg = finishedGoods.filter(
      (fg) =>
        fg.lotNumber.toLowerCase().includes(q) ||
        fg.batchNumber.toLowerCase().includes(q) ||
        fg.sku.toLowerCase().includes(q) ||
        fg.productName.toLowerCase().includes(q) ||
        fg.shipments.some(
          (s) =>
            s.shipmentRef.toLowerCase().includes(q) ||
            s.customerName.toLowerCase().includes(q)
        )
    );

    const rawLotNumbers = new Set(directRaw.map((r) => r.lotNumber));
    const fgBatchIds = new Set(directFg.map((fg) => fg.batchId));

    // 2. Link batches forward from raw lots AND backward from finished goods / direct query
    const matchedBatches = batches.filter(
      (b) =>
        b.batchNumber.toLowerCase().includes(q) ||
        b.lotNumber.toLowerCase().includes(q) ||
        b.sku.toLowerCase().includes(q) ||
        b.productName.toLowerCase().includes(q) ||
        fgBatchIds.has(b.id) ||
        b.issuedMaterials.some(
          (m) =>
            m.lotNumber.toLowerCase().includes(q) || rawLotNumbers.has(m.lotNumber)
        )
    );

    const linkedBatchIds = new Set(matchedBatches.map((b) => b.id));
    const linkedRawLotNums = new Set<string>(rawLotNumbers);
    for (const b of matchedBatches) {
      for (const m of b.issuedMaterials) {
        linkedRawLotNums.add(m.lotNumber);
      }
    }

    const matchedRawLots = rawMaterials.filter((r) => linkedRawLotNums.has(r.lotNumber));
    const matchedFgLots = finishedGoods.filter(
      (fg) => linkedBatchIds.has(fg.batchId) || directFg.some((d) => d.id === fg.id)
    );

    return { matchedRawLots, matchedBatches, matchedFgLots };
  }, [query, batches, rawMaterials, finishedGoods]);

  const impactedShipments = useMemo(() => {
    return traceResult.matchedFgLots.flatMap((fg) =>
      fg.shipments.map((s) => ({
        ...s,
        fgLotNumber: fg.lotNumber,
        productName: fg.productName,
        batchNumber: fg.batchNumber,
      }))
    );
  }, [traceResult.matchedFgLots]);

  async function handleRunBackwardTrace(fgId: string) {
    setTraceLoading(true);
    try {
      const data = await fetchFinishedGoodGenealogy(fgId);
      setServerTrace(data);
    } finally {
      setTraceLoading(false);
    }
  }

  function handleExportCsv() {
    const rows = [
      ['Stage', 'Identifier', 'Product / Material', 'Quantity', 'Counterparty / Status', 'Date'],
      ...traceResult.matchedRawLots.map((r) => [
        'Raw Material Lot',
        r.lotNumber,
        `${r.materialCode} ${r.materialName}`,
        `${r.quantityAvailable} ${r.unit} avail`,
        r.supplier,
        `Exp ${r.expiryDate}`,
      ]),
      ...traceResult.matchedBatches.map((b) => [
        'Production Batch',
        b.batchNumber,
        `${b.sku} ${b.productName}`,
        `${b.goodQty || b.plannedQty} ${b.outputUnit}`,
        `${b.status} (QC: ${b.qcStatus})`,
        b.plannedDate,
      ]),
      ...traceResult.matchedFgLots.map((fg) => [
        'Finished Goods Lot',
        fg.lotNumber,
        fg.productName,
        `${fg.quantityAvailable}/${fg.quantityProduced} ${fg.unit}`,
        fg.warehouseZone,
        `Exp ${fg.expiryDate}`,
      ]),
      ...impactedShipments.map((s) => [
        'Customer Shipment',
        s.shipmentRef,
        `${s.productName} (${s.fgLotNumber})`,
        String(s.quantityShipped),
        `${s.customerName} · ${s.destination}`,
        s.shippedDate,
      ]),
    ];

    const csv = rows
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kettler-traceability-${query.replace(/[^a-zA-Z0-9_-]/g, '_') || 'report'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {/* Search Bar */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Forward &amp; Backward Lot Genealogy Search
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Enter any raw material lot, production batch, finished lot, supplier, or customer
              shipment to trace full recall scope
            </p>
          </div>
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={traceResult.matchedBatches.length === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 text-slate-700 rounded-md whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            Export Trace CSV
          </button>
        </div>

        <div className="relative max-w-2xl">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setServerTrace(null);
            }}
            placeholder="Search RM-TOM-261014-A, LOT-261115-L1-MAR-001, B-261115-001, or customer..."
            className="w-full pl-10 pr-4 py-2.5 text-sm font-mono bg-[#F7F8FA] border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-600"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>Quick lookup:</span>
          {quickExamples.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => {
                setQuery(ex);
                setServerTrace(null);
              }}
              className="font-mono text-teal-700 hover:text-teal-900 underline underline-offset-2"
            >
              {ex}
            </button>
          ))}
        </div>
      </section>

      {/* 3-Stage Genealogy Columns */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Stage 1: Upstream Raw Material Lots */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-[#F7F8FA] border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-800">
              1. Upstream Raw Material Lots
            </h3>
            <span className="font-mono text-xs text-slate-500 tabular-nums">
              {traceResult.matchedRawLots.length}
            </span>
          </div>
          <div className="divide-y divide-slate-100">
            {traceResult.matchedRawLots.length === 0 ? (
              <div className="p-6 text-xs text-slate-500">No linked raw material lots found.</div>
            ) : (
              traceResult.matchedRawLots.map((rm) => (
                <div key={rm.id} className="p-4 space-y-1">
                  <div className="font-mono text-xs font-semibold text-slate-900">
                    {rm.lotNumber}
                  </div>
                  <div className="text-sm font-medium text-slate-900">{rm.materialName}</div>
                  <div className="text-xs text-slate-600">Supplier: {rm.supplier}</div>
                  <div className="text-xs font-mono text-slate-500 tabular-nums">
                    Remaining: {rm.quantityAvailable} {rm.unit} · Exp {rm.expiryDate}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Stage 2: Production Batch Records */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-[#F7F8FA] border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-800">
              2. Production Batch Records
            </h3>
            <span className="font-mono text-xs text-slate-500 tabular-nums">
              {traceResult.matchedBatches.length}
            </span>
          </div>
          <div className="divide-y divide-slate-100">
            {traceResult.matchedBatches.length === 0 ? (
              <div className="p-6 text-xs text-slate-500">No linked production batches found.</div>
            ) : (
              traceResult.matchedBatches.map((b) => (
                <div key={b.id} className="p-4 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-slate-900">
                      {b.batchNumber}
                    </span>
                    <span className="text-xs font-medium text-emerald-700">
                      {b.status} · QC {b.qcStatus}
                    </span>
                  </div>
                  <div className="text-sm font-medium text-slate-900">{b.productName}</div>
                  <div className="text-xs text-slate-600">
                    {b.lineName} · {b.plannedDate} · Formula {b.formulaVersion}
                  </div>
                  <div className="text-xs font-mono text-slate-500 tabular-nums">
                    Issued {b.issuedMaterials.length} lots · {b.processChecks.length} readings
                    {b.yieldPct > 0 ? ` · ${b.yieldPct}% yield` : ''}
                  </div>
                  <div className="flex items-center gap-4 pt-0.5">
                    <button
                      type="button"
                      onClick={() => onOpenBatch(b.id)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
                    >
                      Open batch record
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenBatchReport(b.id)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      HACCP PDF
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Stage 3: Finished Goods & Customer Shipments */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-[#F7F8FA] border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-800">
              3. Finished Lots &amp; Customer Shipments
            </h3>
            <span className="font-mono text-xs text-slate-500 tabular-nums">
              {traceResult.matchedFgLots.length} lots · {impactedShipments.length} ships
            </span>
          </div>
          <div className="divide-y divide-slate-100">
            {traceResult.matchedFgLots.length === 0 ? (
              <div className="p-6 text-xs text-slate-500">
                No released finished goods lots linked yet.
              </div>
            ) : (
              traceResult.matchedFgLots.map((fg) => (
                <div key={fg.id} className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-mono text-xs font-semibold text-slate-900">
                        {fg.lotNumber}
                      </div>
                      <div className="text-sm font-medium text-slate-900">{fg.productName}</div>
                      <div className="text-xs font-mono text-slate-500 tabular-nums">
                        On hand: {fg.quantityAvailable}/{fg.quantityProduced} {fg.unit} · Exp{' '}
                        {fg.expiryDate}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={traceLoading}
                      onClick={() => void handleRunBackwardTrace(fg.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded whitespace-nowrap shrink-0"
                    >
                      <GitBranch className="w-3 h-3" />
                      Backward Trace
                    </button>
                  </div>
                  {fg.shipments.length > 0 && (
                    <div className="pt-2 border-t border-slate-100 space-y-1.5">
                      <div className="text-[11px] font-semibold text-slate-500">
                        Downstream Customer Shipments
                      </div>
                      {fg.shipments.map((s, idx) => (
                        <div
                          key={`${fg.id}-${s.shipmentRef}-${idx}`}
                          className="text-xs bg-[#F7F8FA] rounded px-2.5 py-2 space-y-0.5"
                        >
                          <div className="flex justify-between">
                            <span className="font-semibold text-slate-900">{s.customerName}</span>
                            <span className="font-mono text-slate-700 tabular-nums">
                              {s.quantityShipped} {fg.unit}
                            </span>
                          </div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {s.shipmentRef} · {s.destination} · {s.shippedDate}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Backward Lot Genealogy Panel (Finished Product Lot -> Raw Material Lots Used) */}
      {(serverTrace || traceResult.matchedFgLots.length > 0) && (
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 bg-[#F7F8FA] border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-teal-700" />
              <h3 className="text-sm font-semibold text-slate-900">
                {serverTrace
                  ? `Verified Backward Lot Genealogy — ${serverTrace.finishedGood.lotNumber}`
                  : 'Backward Lot Genealogy (Finished Product Lot → Raw Material Lots)'}
              </h3>
            </div>
            {serverTrace && (
              <span className="font-mono text-xs text-slate-500">
                Batch {serverTrace.batch.batchNumber} · {serverTrace.batch.sku} (
                {serverTrace.batch.formulaVersion})
              </span>
            )}
          </div>

          {serverTrace ? (
            <div className="p-5 space-y-3">
              <div className="text-xs text-slate-600">
                Finished Lot{' '}
                <strong className="font-mono text-slate-900">
                  {serverTrace.finishedGood.lotNumber}
                </strong>{' '}
                ({serverTrace.finishedGood.productName},{' '}
                {serverTrace.finishedGood.quantityProduced}{' '}
                {serverTrace.finishedGood.unit}) traced back to{' '}
                <strong className="text-slate-900">
                  {serverTrace.rawMaterialLots.length}
                </strong>{' '}
                raw material lot(s):
              </div>
              <div className="overflow-x-auto border border-slate-200 rounded-md">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                      <th className="py-2 px-3">Raw Lot #</th>
                      <th className="py-2 px-3">Material</th>
                      <th className="py-2 px-3">Supplier</th>
                      <th className="py-2 px-3 text-right">Allocated</th>
                      <th className="py-2 px-3 text-right">Actual Used</th>
                      <th className="py-2 px-3">Added By &amp; When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {serverTrace.rawMaterialLots.map((rm, idx) => (
                      <tr key={`${rm.lotNumber}-${idx}`}>
                        <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                          {rm.lotNumber}
                        </td>
                        <td className="py-2 px-3">
                          <div className="font-medium text-slate-900">{rm.materialName}</div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {rm.materialCode}
                          </div>
                        </td>
                        <td className="py-2 px-3 text-slate-600">{rm.supplier || '—'}</td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums">
                          {rm.allocatedQty !== null
                            ? `${rm.allocatedQty} ${rm.unit}`
                            : '—'}
                        </td>
                        <td className="py-2 px-3 text-right font-mono font-semibold tabular-nums text-slate-900">
                          {rm.actualUsedQty} {rm.unit}
                        </td>
                        <td className="py-2 px-3 text-slate-600">
                          {rm.addedBy} ·{' '}
                          <span className="font-mono text-[11px]">{rm.addedAt}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {traceResult.matchedFgLots.map((fg) => {
                const linkedBatch = batches.find((b) => b.id === fg.batchId);
                return (
                  <div key={fg.id} className="p-4 space-y-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-mono font-semibold text-slate-900">
                          {fg.lotNumber}
                        </span>{' '}
                        <span className="text-slate-500">
                          → Batch {fg.batchNumber} ({fg.productName})
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={traceLoading}
                        onClick={() => void handleRunBackwardTrace(fg.id)}
                        className="text-xs font-medium text-teal-700 hover:text-teal-800"
                      >
                        Run Server Genealogy Check →
                      </button>
                    </div>
                    {linkedBatch && linkedBatch.issuedMaterials.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {linkedBatch.issuedMaterials.map((m, idx) => (
                          <span
                            key={`${m.lotNumber}-${idx}`}
                            className="px-2.5 py-1 rounded bg-[#F7F8FA] border border-slate-200 font-mono text-[11px] text-slate-800"
                          >
                            {m.lotNumber} ({m.materialCode}: {m.actualQty} {m.unit} · {m.operator})
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-slate-500 italic">No issued raw lots recorded on batch.</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

