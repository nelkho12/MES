import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  AuditLogEntry,
  FinishedGoodLot,
  FormulaBOM,
  ProductionBatch,
  RawMaterialLot,
  RolePermissionMatrix,
  TelemetryHistoryPoint,
  ThermalSensor,
  UserRole,
} from '../types';
import { formatCurrency } from './units';
import { hasFeaturePermission } from '../services/permissions';
import { extractAuditFieldChanges, formatAuditValue } from './auditDiff';

export interface BatchReportOptions {
  includeColdChainSensors: boolean;
  includeTelemetryLog: boolean;
  includeCostingLedger: boolean;
}

export interface BatchReportPayload {
  batch: ProductionBatch;
  formula?: FormulaBOM;
  finishedGood?: FinishedGoodLot;
  rawMaterials: RawMaterialLot[];
  sensors: ThermalSensor[];
  telemetryHistory: TelemetryHistoryPoint[];
  auditLogs?: AuditLogEntry[];
  preparedBy: string;
  userRole: UserRole;
  rolePermissions?: RolePermissionMatrix;
  options: BatchReportOptions;
}

export interface HaccpComplianceSummary {
  verdict: 'COMPLIANT' | 'ACTION REQUIRED' | 'PENDING QC';
  totalProcessChecks: number;
  passedProcessChecks: number;
  outOfToleranceMaterials: number;
  excursionSensors: number;
  warningSensors: number;
  linkedSensors: ThermalSensor[];
}

export function evaluateBatchHaccpCompliance(
  batch: ProductionBatch,
  sensors: ThermalSensor[],
  includeColdChainSensors: boolean
): HaccpComplianceSummary {
  const linkedSensors = sensors.filter((s) => {
    const matchesLine =
      s.linkedLine.toLowerCase() === batch.lineName.toLowerCase() ||
      batch.processChecks.some((c) => c.sensorCode === s.sensorCode);
    const isColdChain =
      includeColdChainSensors &&
      (s.zone.toLowerCase().includes('cold') ||
        s.equipmentType.toLowerCase().includes('chiller') ||
        s.linkedLine.toLowerCase().includes('raw'));
    return matchesLine || isColdChain;
  });

  const effectiveSensors = linkedSensors.length > 0 ? linkedSensors : sensors;
  const totalProcessChecks = batch.processChecks.length;
  const passedProcessChecks = batch.processChecks.filter((c) => c.withinSpec).length;
  const outOfToleranceMaterials = batch.issuedMaterials.filter(
    (m) => !m.withinTolerance
  ).length;
  const excursionSensors = effectiveSensors.filter((s) => s.status === 'Excursion').length;
  const warningSensors = effectiveSensors.filter((s) => s.status === 'Warning').length;

  let verdict: 'COMPLIANT' | 'ACTION REQUIRED' | 'PENDING QC' = 'COMPLIANT';
  if (
    batch.qcStatus === 'Failed' ||
    excursionSensors > 0 ||
    passedProcessChecks < totalProcessChecks ||
    outOfToleranceMaterials > 0
  ) {
    verdict = 'ACTION REQUIRED';
  } else if (batch.qcStatus === 'Pending') {
    verdict = 'PENDING QC';
  }

  return {
    verdict,
    totalProcessChecks,
    passedProcessChecks,
    outOfToleranceMaterials,
    excursionSensors,
    warningSensors,
    linkedSensors: effectiveSensors,
  };
}

function getLastTableY(doc: jsPDF, fallbackY: number): number {
  const typed = doc as jsPDF & { lastAutoTable?: { finalY?: number } };
  return typed.lastAutoTable?.finalY ?? fallbackY;
}

function ensureSpace(doc: jsPDF, currentY: number, neededHeight: number): number {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (currentY + neededHeight > pageHeight - 20) {
    doc.addPage();
    return 18;
  }
  return currentY;
}

export function generateBatchCompliancePdf(payload: BatchReportPayload): string {
  const {
    batch,
    formula,
    finishedGood,
    rawMaterials,
    sensors,
    telemetryHistory,
    auditLogs = [],
    preparedBy,
    userRole,
    rolePermissions,
    options,
  } = payload;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 14;
  const contentWidth = pageWidth - marginX * 2;
  const isOemMasked = Boolean(
    !hasFeaturePermission(rolePermissions, userRole, 'viewConfidentialOem') &&
      formula?.isConfidentialOem
  );
  const compliance = evaluateBatchHaccpCompliance(
    batch,
    sensors,
    options.includeColdChainSensors
  );

  const generatedIso = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const reportDocId = `BMR-${batch.batchNumber}`;

  // --- Top Industrial Header Band ---
  doc.setFillColor(15, 23, 42); // Slate 900
  doc.rect(0, 0, pageWidth, 30, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('KETTLER MES — BATCH MANUFACTURING & HACCP REPORT', marginX, 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(203, 213, 225);
  doc.text(
    `Facility: Kettler Processing Plant 01   |   Document ID: ${reportDocId}   |   Generated: ${generatedIso}`,
    marginX,
    18.5
  );
  doc.text(
    `Prepared by: ${preparedBy} (${userRole.toUpperCase()})   |   OEM Mode: ${
      isOemMasked ? 'CONFIDENTIAL MASKED' : formula?.isConfidentialOem ? 'OEM FULL' : 'STANDARD'
    }`,
    marginX,
    24
  );

  // Compliance Verdict Stamp (Right aligned in header)
  const verdictColor: [number, number, number] =
    compliance.verdict === 'COMPLIANT'
      ? [21, 128, 61]
      : compliance.verdict === 'PENDING QC'
        ? [180, 83, 9]
        : [185, 28, 28];
  doc.setFillColor(...verdictColor);
  doc.roundedRect(pageWidth - marginX - 42, 7.5, 42, 10, 1.5, 1.5, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text(`HACCP: ${compliance.verdict}`, pageWidth - marginX - 21, 13.8, {
    align: 'center',
  });

  let y = 38;

  // --- Section 1: Batch Identification & Metadata ---
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('1. Batch Identification & Manufacturing Metadata', marginX, y);
  y += 3;

  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    theme: 'grid',
    styles: {
      fontSize: 8.5,
      cellPadding: 2.4,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.25,
    },
    columnStyles: {
      0: { fontStyle: 'bold', fillColor: [248, 250, 252], cellWidth: 34 },
      1: { cellWidth: 57 },
      2: { fontStyle: 'bold', fillColor: [248, 250, 252], cellWidth: 34 },
      3: { cellWidth: 57 },
    },
    body: [
      ['Batch Number', batch.batchNumber, 'Traceable Lot #', batch.lotNumber || 'Pending Release'],
      ['Product Name', batch.productName, 'SKU / Version', `${batch.sku} (${batch.formulaVersion})`],
      [
        'Line / Equipment',
        batch.equipmentName || batch.lineName,
        'Shift & Team',
        `${batch.shift || 'Shift A'} · ${batch.assignedTeam}`,
      ],
      [
        'Planned Window',
        `${batch.plannedStartAt || batch.plannedDate} → ${batch.plannedEndAt || '—'}`,
        'Actual Window',
        `${batch.actualStartAt || 'Not started'} → ${batch.actualEndAt || 'Pending'}`,
      ],
      [
        'Operators',
        (batch.operators && batch.operators.length > 0 ? batch.operators.join(', ') : batch.assignedTeam),
        'Demand Source',
        `${batch.sourceType}${batch.sourceRef ? ` · ${batch.sourceRef}` : ''}`,
      ],
      [
        'Lifecycle Status',
        batch.status,
        'Pack / Shelf Life',
        `${batch.packSize || formula?.packSize || batch.outputUnit} · ${formula?.shelfLifeDays ?? '—'} days`,
      ],
    ],
  });

  y = getLastTableY(doc, y + 36) + 7;

  // --- Section 2: Production Output, Yield & Costing ---
  y = ensureSpace(doc, y, 36);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('2. Production Output, Mass, Losses & Batch Costing', marginX, y);
  y += 3;

  const totalCost = batch.materialCost + batch.laborCost + batch.overheadCost;
  const outputRows: (string | number)[][] = [
    [
      `${batch.plannedQty.toLocaleString()} ${batch.outputUnit}`,
      batch.goodQty > 0
        ? `${batch.goodQty.toLocaleString()} ${batch.outputUnit}${batch.outputMassQty ? ` (${batch.outputMassQty} ${batch.outputMassUnit || 'kg'})` : ''}`
        : 'Pending',
      `${batch.rejectedQty} / ${batch.reworkQty} / ${batch.byProductQty || 0}`,
      `${batch.wasteKg} kg`,
      batch.yieldPct > 0 ? `${batch.yieldPct.toFixed(1)}%` : '—',
      batch.yieldPct > 0
        ? `${batch.variancePct >= 0 ? '+' : ''}${batch.variancePct.toFixed(1)}%`
        : '—',
    ],
  ];

  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    theme: 'grid',
    headStyles: {
      fillColor: [15, 118, 110],
      textColor: [255, 255, 255],
      fontSize: 8,
      fontStyle: 'bold',
    },
    styles: {
      fontSize: 8.5,
      cellPadding: 2.5,
      textColor: [15, 23, 42],
      lineColor: [226, 232, 240],
    },
    head: [
      ['Planned Qty', 'Good Output (Mass)', 'Reject / Rework / By-Prod', 'Waste', 'Actual Yield %', 'Variance'],
    ],
    body: outputRows,
  });

  if (batch.lossReasonCodes && batch.lossReasonCodes.length > 0) {
    const lossSummary = batch.lossReasonCodes
      .map((l) => `${l.lossType}: ${l.quantity} ${l.unit} (${l.reasonCode})`)
      .join('   |   ');
    y = getLastTableY(doc, y + 18) + 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(71, 85, 105);
    doc.text(`Loss Reason Codes: ${lossSummary}`, marginX, y);
  }

  y = getLastTableY(doc, y + 18) + 4;

  if (options.includeCostingLedger) {
    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      theme: 'grid',
      headStyles: {
        fillColor: [241, 245, 249],
        textColor: [51, 65, 85],
        fontSize: 8,
        fontStyle: 'bold',
      },
      styles: {
        fontSize: 8.5,
        cellPadding: 2.3,
        textColor: [15, 23, 42],
        lineColor: [226, 232, 240],
      },
      head: [['Material Cost', 'Labor Cost', 'Overhead Cost', 'Total Batch Cost', 'Cost / Good Unit']],
      body: [
        [
          formatCurrency(batch.materialCost),
          formatCurrency(batch.laborCost),
          formatCurrency(batch.overheadCost),
          formatCurrency(totalCost),
          batch.unitCost > 0 ? formatCurrency(batch.unitCost) : '—',
        ],
      ],
    });
    y = getLastTableY(doc, y + 16) + 7;
  } else {
    y += 4;
  }

  // --- Section 3: Material Issue & FEFO Lot Traceability ---
  y = ensureSpace(doc, y, 42);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('3. Issued Raw Material Lots & Weigh Tolerance Log (Step 4)', marginX, y);
  y += 3;

  if (batch.issuedMaterials.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8.5);
    doc.setTextColor(100, 116, 139);
    doc.text('No raw material lots have been issued to this batch yet.', marginX, y + 4);
    y += 11;
  } else {
    const materialRows = batch.issuedMaterials.map((m) => {
      const bomLine = formula?.ingredients.find((i) => i.materialCode === m.materialCode);
      const rawLot = rawMaterials.find((r) => r.lotNumber === m.lotNumber);
      const displayCode = isOemMasked ? bomLine?.anonymizedCode || 'OEM-SPEC' : m.materialCode;
      const displayName = isOemMasked
        ? `Confidential Component (${displayCode})`
        : m.materialName;
      return [
        displayCode,
        displayName,
        `${m.lotNumber}${rawLot ? `\n(${rawLot.supplier})` : ''}`,
        `${m.requiredQty} ${m.unit}`,
        `${m.actualQty} ${m.unit}`,
        `${m.variancePct >= 0 ? '+' : ''}${m.variancePct.toFixed(2)}%`,
        m.withinTolerance ? 'PASS' : 'OUT OF TOL',
        `${m.operator}\n${m.issuedAt}`,
      ];
    });

    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      theme: 'striped',
      headStyles: {
        fillColor: [15, 23, 42],
        textColor: [255, 255, 255],
        fontSize: 7.5,
      },
      styles: {
        fontSize: 7.5,
        cellPadding: 2,
        textColor: [30, 41, 59],
        lineColor: [226, 232, 240],
      },
      didParseCell: (hookData) => {
        if (hookData.section === 'body' && hookData.column.index === 6) {
          const val = String(hookData.cell.raw || '');
          hookData.cell.styles.fontStyle = 'bold';
          hookData.cell.styles.textColor = val === 'PASS' ? [21, 128, 61] : [185, 28, 28];
        }
      },
      head: [
        ['Code', 'Material', 'Lot / Supplier', 'Required', 'Actual', 'Var %', 'Tolerance', 'Operator / Time'],
      ],
      body: materialRows,
    });
    y = getLastTableY(doc, y + 32) + 7;
  }

  // --- Section 4: In-Process Quality Checks ---
  y = ensureSpace(doc, y, 42);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('4. In-Process Quality & CCP Verification Log (Step 5)', marginX, y);
  y += 3;

  if (batch.processChecks.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8.5);
    doc.setTextColor(100, 116, 139);
    doc.text('No in-process thermal or quality checks recorded yet.', marginX, y + 4);
    y += 11;
  } else {
    const checkRows = batch.processChecks.map((chk, idx) => {
      const timeLabel = chk.readingTime || chk.recordedAt.slice(11, 16) || '';
      const weightKg =
        chk.recordedWeightKg ??
        (chk.recordedWeightG !== null && chk.recordedWeightG !== undefined
          ? Number((chk.recordedWeightG / 1000).toFixed(3))
          : null);
      const customSummary =
        chk.batchCheckReadings && chk.batchCheckReadings.length > 0
          ? `\n${chk.batchCheckReadings
              .map((r) => `${r.name}: ${r.value}${r.unit ? ` ${r.unit}` : ''}`)
              .join(', ')}`
          : '';
      return [
        `T${idx + 1}${timeLabel ? ` @${timeLabel}` : ''}`,
        chk.recordedTempC !== null ? `${chk.recordedTempC.toFixed(1)}°C` : '—',
        `${chk.recordedBrix !== null ? `${chk.recordedBrix}%` : '—'} / ${
          chk.recordedPh !== null ? chk.recordedPh : '—'
        }${
          chk.recordedAw !== null && chk.recordedAw !== undefined
            ? ` / ${chk.recordedAw.toFixed(3)}`
            : ''
        }`,
        `${weightKg !== null ? `${weightKg}kg` : '—'}\n${chk.recordedViscosityCp ?? '—'}cP / ${chk.recordedSpeedRpm ?? '—'}rpm / ${chk.recordedPressureBar ?? '—'}bar`,
        `${chk.durationMin}m`,
        `${chk.source || 'Manual'}\n(${chk.sensorCode})`,
        chk.withinSpec ? 'IN SPEC' : 'DEVIATION',
        `${chk.operator} · ${chk.recordedAt}${chk.deviationRecord ? `\nDEV: ${chk.deviationRecord}` : ''}${chk.notes ? `\n${chk.notes}` : ''}${customSummary}`,
      ];
    });

    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      theme: 'striped',
      headStyles: {
        fillColor: [15, 118, 110],
        textColor: [255, 255, 255],
        fontSize: 7.5,
      },
      styles: {
        fontSize: 7.2,
        cellPadding: 2,
        textColor: [30, 41, 59],
        lineColor: [226, 232, 240],
      },
      didParseCell: (hookData) => {
        if (hookData.section === 'body' && hookData.column.index === 6) {
          const val = String(hookData.cell.raw || '');
          hookData.cell.styles.fontStyle = 'bold';
          hookData.cell.styles.textColor = val === 'IN SPEC' ? [21, 128, 61] : [185, 28, 28];
        }
      },
      head: [
        ['Time Reading', 'Temp', 'Brix (%) / pH / Aw', 'Wt / Visc / RPM / Bar', 'Dur', 'Source', 'CCP Spec', 'Logged By & Deviations'],
      ],
      body: checkRows,
    });
    y = getLastTableY(doc, y + 32) + 7;
  }

  // --- Section 5: HACCP Temperature Sensor Telemetry & Critical Limit Log ---
  y = ensureSpace(doc, y, 52);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('5. HACCP Temperature Sensor Telemetry & Critical Limits', marginX, y);
  y += 3;

  const sensorRows = compliance.linkedSensors.map((s) => {
    const readings = telemetryHistory
      .map((pt) => Number(pt[s.sensorCode]))
      .filter((v) => Number.isFinite(v));
    const minObs = readings.length > 0 ? Math.min(...readings, s.currentTempC) : s.currentTempC;
    const maxObs = readings.length > 0 ? Math.max(...readings, s.currentTempC) : s.currentTempC;
    const avgObs =
      readings.length > 0
        ? readings.reduce((acc, v) => acc + v, 0) / readings.length
        : s.currentTempC;

    return [
      s.sensorCode,
      `${s.name}\n${s.zone}`,
      `${s.minSafeTempC}–${s.maxSafeTempC}°C\n(Target ${s.targetTempC}°C)`,
      `${s.currentTempC.toFixed(1)}°C`,
      `${minObs.toFixed(1)} / ${avgObs.toFixed(1)} / ${maxObs.toFixed(1)}°C`,
      `${s.humidityPct}%`,
      s.status.toUpperCase(),
      s.yieldImpactNote,
    ];
  });

  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    theme: 'grid',
    headStyles: {
      fillColor: [15, 23, 42],
      textColor: [255, 255, 255],
      fontSize: 7.5,
    },
    styles: {
      fontSize: 7.4,
      cellPadding: 2,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
    },
    columnStyles: {
      7: { cellWidth: 42 },
    },
    didParseCell: (hookData) => {
      if (hookData.section === 'body' && hookData.column.index === 6) {
        const val = String(hookData.cell.raw || '');
        hookData.cell.styles.fontStyle = 'bold';
        if (val === 'NOMINAL') hookData.cell.styles.textColor = [21, 128, 61];
        else if (val === 'WARNING') hookData.cell.styles.textColor = [180, 83, 9];
        else hookData.cell.styles.textColor = [185, 28, 28];
      }
    },
    head: [
      ['Probe', 'Equipment / Zone', 'HACCP Limits', 'Current', 'Min / Avg / Max', 'RH', 'Status', 'Yield / HACCP Assessment'],
    ],
    body: sensorRows,
  });

  y = getLastTableY(doc, y + 36) + 6;

  // Optional Vector Sparkline Plot + Timestamped Telemetry Data Table
  if (options.includeTelemetryLog && telemetryHistory.length > 0 && compliance.linkedSensors.length > 0) {
    const primarySensor = compliance.linkedSensors[0];
    const pts = telemetryHistory.slice(-10);
    const values = pts
      .map((p) => Number(p[primarySensor.sensorCode]))
      .filter((v) => Number.isFinite(v));

    if (values.length >= 2) {
      y = ensureSpace(doc, y, 42);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(30, 41, 59);
      doc.text(
        `Primary Line Probe Trend — ${primarySensor.sensorCode} (${primarySensor.name})`,
        marginX,
        y
      );
      y += 3;

      const chartX = marginX;
      const chartY = y;
      const chartW = contentWidth;
      const chartH = 26;

      doc.setFillColor(248, 250, 252);
      doc.setDrawColor(203, 213, 225);
      doc.rect(chartX, chartY, chartW, chartH, 'FD');

      const minVal = Math.min(...values, primarySensor.minSafeTempC) - 1.5;
      const maxVal = Math.max(...values, primarySensor.maxSafeTempC) + 1.5;
      const range = Math.max(1, maxVal - minVal);
      const mapY = (v: number) => chartY + chartH - ((v - minVal) / range) * (chartH - 4) - 2;

      // Safe band upper/lower dashed guides
      doc.setDrawColor(220, 38, 38);
      doc.setLineDashPattern([1.5, 1.5], 0);
      const maxLineY = mapY(primarySensor.maxSafeTempC);
      doc.line(chartX + 1, maxLineY, chartX + chartW - 1, maxLineY);

      doc.setDrawColor(37, 99, 235);
      const minLineY = mapY(primarySensor.minSafeTempC);
      doc.line(chartX + 1, minLineY, chartX + chartW - 1, minLineY);
      doc.setLineDashPattern([], 0);

      // Telemetry polyline
      doc.setDrawColor(15, 118, 110);
      doc.setLineWidth(0.6);
      const stepX = (chartW - 12) / Math.max(1, values.length - 1);
      for (let i = 0; i < values.length - 1; i++) {
        const x1 = chartX + 6 + i * stepX;
        const y1 = mapY(values[i]);
        const x2 = chartX + 6 + (i + 1) * stepX;
        const y2 = mapY(values[i + 1]);
        doc.line(x1, y1, x2, y2);
      }

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.text(
        `Max Safe: ${primarySensor.maxSafeTempC}°C   |   Target: ${primarySensor.targetTempC}°C   |   Min Safe: ${primarySensor.minSafeTempC}°C   |   Samples: ${pts[0].time} – ${pts[pts.length - 1].time}`,
        chartX + 2,
        chartY + chartH + 4
      );
      y = chartY + chartH + 8;
    }

    // Timestamped Telemetry Table (up to 4 linked probes across last 8 intervals)
    y = ensureSpace(doc, y, 42);
    const logSensors = compliance.linkedSensors.slice(0, 4);
    const logHead = [
      'Timestamp',
      ...logSensors.map((s) => `${s.sensorCode} (°C)`),
      'Interval HACCP Check',
    ];
    const logBody = telemetryHistory.slice(-8).map((pt) => {
      let intervalOk = true;
      const readings = logSensors.map((s) => {
        const val = Number(pt[s.sensorCode]);
        if (Number.isFinite(val)) {
          if (val < s.minSafeTempC || val > s.maxSafeTempC) intervalOk = false;
          return `${val.toFixed(1)}°C`;
        }
        return '—';
      });
      return [pt.time, ...readings, intervalOk ? 'PASS' : 'EXCURSION'];
    });

    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      theme: 'striped',
      headStyles: {
        fillColor: [51, 65, 85],
        textColor: [255, 255, 255],
        fontSize: 7.5,
      },
      styles: {
        fontSize: 7.5,
        cellPadding: 1.8,
        textColor: [30, 41, 59],
      },
      didParseCell: (hookData) => {
        if (hookData.section === 'body' && hookData.column.index === logSensors.length + 1) {
          const val = String(hookData.cell.raw || '');
          hookData.cell.styles.fontStyle = 'bold';
          hookData.cell.styles.textColor = val === 'PASS' ? [21, 128, 61] : [185, 28, 28];
        }
      },
      head: [logHead],
      body: logBody,
    });
    y = getLastTableY(doc, y + 32) + 7;
  }

  // --- Section 6: QC Quarantine Release, Finished Goods Posting & Sign-Off ---
  y = ensureSpace(doc, y, 52);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('6. QC Release, Finished Goods Posting & QA Sign-Off (Steps 7–9)', marginX, y);
  y += 3;

  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    theme: 'grid',
    styles: {
      fontSize: 8.2,
      cellPadding: 2.3,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
    },
    columnStyles: {
      0: { fontStyle: 'bold', fillColor: [248, 250, 252], cellWidth: 38 },
      1: { cellWidth: 53 },
      2: { fontStyle: 'bold', fillColor: [248, 250, 252], cellWidth: 38 },
      3: { cellWidth: 53 },
    },
    body: [
      ['QC Disposition', batch.qcStatus, 'QC Inspector', batch.qcInspector || 'Awaiting Sign-Off'],
      [
        'In-Process QC',
        batch.qcInProcessSummary || '—',
        'Final QC Results',
        batch.qcFinalResults || '—',
      ],
      [
        'Retained Sample',
        `${batch.retainedSampleQty || 0} units · ${batch.retainedSampleCode || '—'}`,
        'Retain Location',
        batch.retainedSampleLocation || '—',
      ],
      [
        'Auto-Posted to FG',
        batch.postedToInventory ? 'Yes (Zero Manual Keying)' : 'Not Posted Yet',
        'FG Warehouse Zone',
        finishedGood?.warehouseZone || '—',
      ],
      [
        'FG Lot / Expiry',
        finishedGood ? `${finishedGood.lotNumber} · Exp ${finishedGood.expiryDate}` : '—',
        'Customer Shipments',
        finishedGood && finishedGood.shipments.length > 0
          ? finishedGood.shipments.map((s) => `${s.customerName} (${s.quantityShipped})`).join('; ')
          : 'None dispatched',
      ],
      ['QC Inspection Notes', { content: batch.qcNotes || 'No inspection remarks logged.', colSpan: 3 } as unknown as string],
    ],
  });

  y = getLastTableY(doc, y + 28) + 8;

  const batchAudit = auditLogs.filter(
    (l) => l.batchId === batch.id || l.entityId === batch.id
  );
  if (batchAudit.length > 0) {
    y = ensureSpace(doc, y, 36);
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.text('7. Electronic Audit Trail (21 CFR Part 11 Trace)', marginX, y);
    y += 3;
    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      theme: 'striped',
      headStyles: { fillColor: [51, 65, 85], textColor: [255, 255, 255], fontSize: 7.5 },
      styles: { fontSize: 7.2, cellPadding: 1.8, textColor: [30, 41, 59] },
      head: [['When', 'User (Role)', 'Action', 'Field Changes (Before -> After)', 'Reason']],
      body: batchAudit.map((l) => {
        const whenStr =
          typeof l.createdAt === 'string'
            ? l.createdAt
            : l.createdAt instanceof Date
              ? l.createdAt.toISOString().replace('T', ' ').slice(0, 19)
              : String(l.createdAt ?? '');
        const changes = extractAuditFieldChanges(l.oldValue, l.newValue);
        const diffLines =
          changes.length > 0
            ? changes
                .map((c) =>
                  c.before !== null
                    ? `${c.label}: ${formatAuditValue(c.before)} -> ${formatAuditValue(c.after)}`
                    : `${c.label}: ${formatAuditValue(c.after)}`
                )
                .join('\n')
            : '—';
        return [
          whenStr,
          `${l.actorName} (${l.actorRole})`,
          `${l.action} · ${l.entityType}`,
          diffLines,
          l.reason || '—',
        ];
      }),
    });
    y = getLastTableY(doc, y + 24) + 10;
  } else {
    y += 4;
  }

  y = ensureSpace(doc, y, 22);

  // Formal Audit Signature Lines
  const sigW = (contentWidth - 12) / 3;
  const sigLabels = ['Production Supervisor', 'HACCP / QC Compliance Officer', 'Plant QA Release'];
  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(0.3);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);

  sigLabels.forEach((label, idx) => {
    const sx = marginX + idx * (sigW + 6);
    doc.line(sx, y + 8, sx + sigW, y + 8);
    doc.text(label, sx, y + 12.5);
    doc.text('Signature & Date', sx, y + 16);
  });

  // Page Footers on every page
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    const pageH = doc.internal.pageSize.getHeight();
    doc.setDrawColor(226, 232, 240);
    doc.line(marginX, pageH - 12, pageWidth - marginX, pageH - 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(
      `Kettler MES · Controlled HACCP Batch Record (${reportDocId})`,
      marginX,
      pageH - 7.5
    );
    doc.text(`Page ${p} of ${totalPages}`, pageWidth - marginX, pageH - 7.5, {
      align: 'right',
    });
  }

  const safeBatch = batch.batchNumber.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `Kettler_HACCP_Batch_Report_${safeBatch}.pdf`;
  doc.save(filename);
  return filename;
}
