import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { UserRole } from '../types';
import { formatCurrency } from './units';
import {
  DEFAULT_KPI_YIELD_TARGET_PCT,
  type MonthlyChartMetricMode,
  type MonthlyDimensionBreakdown,
  type MonthlyMomComparisonData,
  type MonthlyMomOverlayPoint,
  type MonthlyProductionBucket,
  type MonthlyProductionReportData,
  type MonthlyReportFilters,
} from './monthlyAnalytics';

export type MonthlyDimensionView = 'line' | 'product';

export interface MonthlyManagementPdfPayload {
  report: MonthlyProductionReportData;
  filters: MonthlyReportFilters;
  chartMetricMode: MonthlyChartMetricMode;
  dimensionView: MonthlyDimensionView;
  preparedBy?: string;
  userRole?: UserRole;
  managementNotes?: string;
  momData?: MonthlyMomComparisonData;
  showMomOverlay?: boolean;
}

function getLastTableY(doc: jsPDF, fallbackY: number): number {
  const typed = doc as jsPDF & { lastAutoTable?: { finalY?: number } };
  return typed.lastAutoTable?.finalY ?? fallbackY;
}

function ensureSpace(doc: jsPDF, currentY: number, neededHeight: number): number {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (currentY + neededHeight > pageHeight - 18) {
    doc.addPage();
    return 16;
  }
  return currentY;
}

export function formatFilterScopeSummary(filters: MonthlyReportFilters): string {
  const parts: string[] = [];
  if (filters.year !== 'ALL') parts.push(`Year: ${filters.year}`);
  if (filters.month !== 'ALL') parts.push(`Month: ${filters.month}`);
  if (filters.lineName !== 'ALL') parts.push(`Line: ${filters.lineName}`);
  if (filters.category !== 'ALL') parts.push(`Category: ${filters.category}`);
  if (filters.sku !== 'ALL') parts.push(`SKU: ${filters.sku}`);
  if (filters.statusScope !== 'ALL') {
    parts.push(`Status: ${filters.statusScope.replace(/_/g, ' ')}`);
  }
  if (filters.search.trim()) parts.push(`Search: "${filters.search.trim()}"`);
  return parts.length > 0 ? parts.join(' | ') : 'All Periods, Lines, Categories & SKUs';
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function drawMonthlyVectorChart(
  doc: jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  months: MonthlyProductionBucket[],
  mode: MonthlyChartMetricMode,
  overlaySeries?: MonthlyMomOverlayPoint[],
  showMomOverlay: boolean = false
): void {
  // Outer card frame
  doc.setDrawColor(226, 232, 240);
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(x, y, w, h, 1.5, 1.5, 'FD');

  const modeTitle =
    mode === 'output_yield'
      ? 'Monthly Production Output, Yield (%) & Velocity Trend'
      : mode === 'velocity_bottleneck'
        ? 'Monthly Production Velocity (u/hr) & Bottleneck Trend'
        : mode === 'mass_waste'
          ? 'Monthly Net Mass Output (kg) & Process Waste (kg)'
          : 'Monthly Plan Attainment (%) & QC Pass Rate (%)';

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(15, 23, 42);
  doc.text(modeTitle, x + 4, y + 6);

  // Legend top right
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  if (mode === 'output_yield') {
    doc.setFillColor(15, 118, 110);
    doc.rect(x + w - 92, y + 3.5, 2.5, 2.5, 'F');
    doc.setTextColor(71, 85, 105);
    doc.text('Output', x + w - 88.5, y + 5.7);

    doc.setFillColor(217, 119, 6);
    doc.rect(x + w - 73, y + 3.5, 2.5, 2.5, 'F');
    doc.text('Rej/Rwk', x + w - 69.5, y + 5.7);

    doc.setDrawColor(5, 150, 105);
    doc.setLineWidth(0.7);
    doc.line(x + w - 53, y + 4.8, x + w - 49, y + 4.8);
    doc.text('Yield %', x + w - 48, y + 5.7);

    doc.setDrawColor(2, 132, 199);
    doc.line(x + w - 29, y + 4.8, x + w - 25, y + 4.8);
    doc.text('Velocity', x + w - 24, y + 5.7);
  } else if (mode === 'velocity_bottleneck') {
    doc.setFillColor(15, 118, 110);
    doc.rect(x + w - 78, y + 3.5, 2.5, 2.5, 'F');
    doc.setTextColor(71, 85, 105);
    doc.text('Actual u/hr', x + w - 74.5, y + 5.7);

    doc.setFillColor(203, 213, 225);
    doc.rect(x + w - 53, y + 3.5, 2.5, 2.5, 'F');
    doc.text('Target u/hr', x + w - 49.5, y + 5.7);

    doc.setDrawColor(2, 132, 199);
    doc.setLineWidth(0.7);
    doc.line(x + w - 27, y + 4.8, x + w - 23, y + 4.8);
    doc.text('Trend', x + w - 22, y + 5.7);
  } else if (mode === 'mass_waste') {
    doc.setFillColor(15, 118, 110);
    doc.rect(x + w - 68, y + 3.5, 2.5, 2.5, 'F');
    doc.setTextColor(71, 85, 105);
    doc.text('Net Mass (kg)', x + w - 64.5, y + 5.7);

    doc.setFillColor(220, 38, 38);
    doc.rect(x + w - 43, y + 3.5, 2.5, 2.5, 'F');
    doc.text('Waste (kg)', x + w - 39.5, y + 5.7);

    doc.setDrawColor(5, 150, 105);
    doc.setLineWidth(0.7);
    doc.line(x + w - 23, y + 4.8, x + w - 19, y + 4.8);
    doc.text('Yield %', x + w - 18, y + 5.7);
  } else {
    doc.setFillColor(15, 118, 110);
    doc.rect(x + w - 72, y + 3.5, 2.5, 2.5, 'F');
    doc.setTextColor(71, 85, 105);
    doc.text('Plan %', x + w - 68.5, y + 5.7);

    doc.setDrawColor(5, 150, 105);
    doc.setLineWidth(0.7);
    doc.line(x + w - 53, y + 4.8, x + w - 49, y + 4.8);
    doc.text('Avg Yield %', x + w - 48, y + 5.7);

    doc.setDrawColor(37, 99, 235);
    doc.line(x + w - 26, y + 4.8, x + w - 22, y + 4.8);
    doc.text('QC Pass %', x + w - 21, y + 5.7);
  }

  const plotX = x + 13;
  const plotY = y + 11;
  const plotW = w - 25;
  const plotH = h - 20;

  if (months.length === 0) {
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text('No monthly data in current filter scope', x + w / 2, y + h / 2, {
      align: 'center',
    });
    return;
  }

  const displayMonths = months.slice(-12);

  // Determine left scale max
  let leftMax = 100;
  if (mode === 'output_yield') {
    const rawMax = Math.max(
      10,
      ...displayMonths.map((m) => Math.max(m.goodQty, m.rejectPlusReworkQty))
    );
    leftMax = Math.ceil((rawMax * 1.15) / 10) * 10;
  } else if (mode === 'velocity_bottleneck') {
    const rawMax = Math.max(
      10,
      ...displayMonths.map((m) => Math.max(m.avgVelocityUnitsPerHr, m.targetVelocityUnitsPerHr))
    );
    leftMax = Math.ceil((rawMax * 1.15) / 10) * 10;
  } else if (mode === 'mass_waste') {
    const rawMax = Math.max(
      10,
      ...displayMonths.map((m) => Math.max(m.outputMassKg, m.wasteKg))
    );
    leftMax = Math.ceil((rawMax * 1.15) / 10) * 10;
  } else {
    leftMax = 105;
  }

  const pctMin = mode === 'quality_plan' ? 0 : 75;
  const pctMax = 102;

  // Gridlines & left/right Y ticks (4 steps)
  doc.setLineWidth(0.2);
  doc.setFontSize(6.5);
  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4;
    const gy = plotY + plotH - ratio * plotH;
    doc.setDrawColor(226, 232, 240);
    doc.line(plotX, gy, plotX + plotW, gy);

    const leftVal = Math.round(ratio * leftMax);
    doc.setTextColor(100, 116, 139);
    doc.text(
      mode === 'quality_plan' ? `${leftVal}%` : leftVal.toLocaleString(),
      plotX - 1.5,
      gy + 1,
      { align: 'right' }
    );

    if (mode !== 'quality_plan' && mode !== 'velocity_bottleneck') {
      const rightVal = Math.round(pctMin + ratio * (pctMax - pctMin));
      doc.setTextColor(5, 150, 105);
      doc.text(`${rightVal}%`, plotX + plotW + 1.5, gy + 1, { align: 'left' });
    }
  }

  // Target KPI reference line (96.5%)
  if (mode !== 'velocity_bottleneck') {
    const targetRatio = (DEFAULT_KPI_YIELD_TARGET_PCT - pctMin) / (pctMax - pctMin);
    if (targetRatio >= 0 && targetRatio <= 1) {
      const targetY = plotY + plotH - targetRatio * plotH;
      doc.setDrawColor(5, 150, 105);
      doc.setLineWidth(0.35);
      doc.setLineDashPattern([1.5, 1.5], 0);
      doc.line(plotX, targetY, plotX + plotW, targetY);
      doc.setLineDashPattern([], 0);
      doc.setFontSize(6);
      doc.setTextColor(4, 120, 87);
      doc.text(`Target ${DEFAULT_KPI_YIELD_TARGET_PCT}%`, plotX + 1.5, targetY - 1);
    }
  }

  const slotW = plotW / displayMonths.length;
  const barGroupW = Math.min(18, slotW * 0.65);

  const maxVelocity = Math.max(
    1,
    ...displayMonths.map((m) => Math.max(m.avgVelocityUnitsPerHr, m.targetVelocityUnitsPerHr))
  );

  const yieldPoints: { cx: number; cy: number; hasValue: boolean }[] = [];
  const secondaryPoints: { cx: number; cy: number; hasValue: boolean }[] = [];
  const velocityPoints: { cx: number; cy: number; hasValue: boolean }[] = [];

  displayMonths.forEach((m, idx) => {
    const centerX = plotX + (idx + 0.5) * slotW;

    if (mode === 'output_yield') {
      const singleBarW = barGroupW * 0.48;
      const goodH = Math.max(0.4, (m.goodQty / leftMax) * plotH);
      doc.setFillColor(15, 118, 110);
      doc.rect(centerX - singleBarW - 0.3, plotY + plotH - goodH, singleBarW, goodH, 'F');

      if (m.rejectPlusReworkQty > 0) {
        const rejH = Math.max(0.4, (m.rejectPlusReworkQty / leftMax) * plotH);
        doc.setFillColor(217, 119, 6);
        doc.rect(centerX + 0.3, plotY + plotH - rejH, singleBarW, rejH, 'F');
      }
    } else if (mode === 'velocity_bottleneck') {
      const singleBarW = barGroupW * 0.48;
      if (m.targetVelocityUnitsPerHr > 0) {
        const targetH = Math.max(0.4, (m.targetVelocityUnitsPerHr / leftMax) * plotH);
        doc.setFillColor(203, 213, 225);
        doc.rect(centerX - singleBarW - 0.3, plotY + plotH - targetH, singleBarW, targetH, 'F');
      }
      if (m.avgVelocityUnitsPerHr > 0) {
        const actualH = Math.max(0.4, (m.avgVelocityUnitsPerHr / leftMax) * plotH);
        doc.setFillColor(15, 118, 110);
        doc.rect(centerX + 0.3, plotY + plotH - actualH, singleBarW, actualH, 'F');
      }
    } else if (mode === 'mass_waste') {
      const singleBarW = barGroupW * 0.48;
      const massH = Math.max(0.4, (m.outputMassKg / leftMax) * plotH);
      doc.setFillColor(15, 118, 110);
      doc.rect(centerX - singleBarW - 0.3, plotY + plotH - massH, singleBarW, massH, 'F');

      if (m.wasteKg > 0) {
        const wasteH = Math.max(0.4, (m.wasteKg / leftMax) * plotH);
        doc.setFillColor(220, 38, 38);
        doc.rect(centerX + 0.3, plotY + plotH - wasteH, singleBarW, wasteH, 'F');
      }
    } else {
      const singleBarW = Math.min(11, barGroupW * 0.7);
      const planH = Math.max(0.4, (Math.min(leftMax, m.planAttainmentPct) / leftMax) * plotH);
      doc.setFillColor(15, 118, 110);
      doc.rect(centerX - singleBarW / 2, plotY + plotH - planH, singleBarW, planH, 'F');
    }

    // Track velocity trend coordinates
    if (m.avgVelocityUnitsPerHr > 0) {
      const velDenom = mode === 'velocity_bottleneck' ? leftMax : maxVelocity * 1.15;
      const vRatio = Math.max(0, Math.min(1, m.avgVelocityUnitsPerHr / velDenom));
      velocityPoints.push({ cx: centerX, cy: plotY + plotH - vRatio * plotH, hasValue: true });
    } else {
      velocityPoints.push({ cx: centerX, cy: plotY + plotH, hasValue: false });
    }

    // Track yield line coordinates
    if (mode !== 'velocity_bottleneck' && m.avgYieldPct > 0) {
      const clampedY = Math.max(pctMin, Math.min(pctMax, m.avgYieldPct));
      const yRatio = (clampedY - pctMin) / (pctMax - pctMin);
      yieldPoints.push({ cx: centerX, cy: plotY + plotH - yRatio * plotH, hasValue: true });
    } else {
      yieldPoints.push({ cx: centerX, cy: plotY + plotH, hasValue: false });
    }

    if (mode === 'quality_plan' && m.qcDecidedCount > 0) {
      const clampedQ = Math.max(pctMin, Math.min(pctMax, m.qcPassRatePct));
      const qRatio = (clampedQ - pctMin) / (pctMax - pctMin);
      secondaryPoints.push({ cx: centerX, cy: plotY + plotH - qRatio * plotH, hasValue: true });
    } else if (mode === 'output_yield' && m.weightedYieldPct > 0) {
      const clampedW = Math.max(pctMin, Math.min(pctMax, m.weightedYieldPct));
      const wRatio = (clampedW - pctMin) / (pctMax - pctMin);
      secondaryPoints.push({ cx: centerX, cy: plotY + plotH - wRatio * plotH, hasValue: true });
    } else {
      secondaryPoints.push({ cx: centerX, cy: plotY + plotH, hasValue: false });
    }

    // X-axis label
    doc.setFontSize(6.5);
    doc.setTextColor(71, 85, 105);
    doc.text(m.label, centerX, plotY + plotH + 4.5, { align: 'center' });
  });

  // Draw secondary line (QC pass % or weighted yield %)
  doc.setDrawColor(37, 99, 235);
  doc.setLineWidth(0.5);
  if (mode === 'output_yield') {
    doc.setLineDashPattern([1.2, 1.2], 0);
  }
  for (let i = 1; i < secondaryPoints.length; i++) {
    if (secondaryPoints[i - 1].hasValue && secondaryPoints[i].hasValue) {
      doc.line(
        secondaryPoints[i - 1].cx,
        secondaryPoints[i - 1].cy,
        secondaryPoints[i].cx,
        secondaryPoints[i].cy
      );
    }
  }
  doc.setLineDashPattern([], 0);
  for (const pt of secondaryPoints) {
    if (pt.hasValue) {
      doc.setFillColor(37, 99, 235);
      doc.circle(pt.cx, pt.cy, 0.85, 'F');
    }
  }

  // Draw primary Avg KPI Yield % line
  doc.setDrawColor(5, 150, 105);
  doc.setLineWidth(0.75);
  for (let i = 1; i < yieldPoints.length; i++) {
    if (yieldPoints[i - 1].hasValue && yieldPoints[i].hasValue) {
      doc.line(
        yieldPoints[i - 1].cx,
        yieldPoints[i - 1].cy,
        yieldPoints[i].cx,
        yieldPoints[i].cy
      );
    }
  }
  for (const pt of yieldPoints) {
    if (pt.hasValue) {
      doc.setFillColor(5, 150, 105);
      doc.circle(pt.cx, pt.cy, 1.1, 'F');
    }
  }

  // Draw Avg Production Velocity trend line (sky-600 #0284C7)
  if (mode === 'output_yield' || mode === 'velocity_bottleneck') {
    doc.setDrawColor(2, 132, 199);
    doc.setLineWidth(0.75);
    for (let i = 1; i < velocityPoints.length; i++) {
      if (velocityPoints[i - 1].hasValue && velocityPoints[i].hasValue) {
        doc.line(
          velocityPoints[i - 1].cx,
          velocityPoints[i - 1].cy,
          velocityPoints[i].cx,
          velocityPoints[i].cy
        );
      }
    }
    for (const pt of velocityPoints) {
      if (pt.hasValue) {
        doc.setFillColor(2, 132, 199);
        doc.circle(pt.cx, pt.cy, 1.0, 'F');
      }
    }
  }

  // Draw optional Previous Month Avg Yield % dashed overlay curve
  if (showMomOverlay && overlaySeries && overlaySeries.length > 0) {
    const overlayByYm = new Map(overlaySeries.map((o) => [o.yearMonth, o]));
    const prevPoints: { cx: number; cy: number; hasValue: boolean }[] = displayMonths.map(
      (m, idx) => {
        const centerX = plotX + (idx + 0.5) * slotW;
        const ov = overlayByYm.get(m.yearMonth);
        if (ov && ov.prevAvgYieldPct !== null && ov.prevAvgYieldPct > 0) {
          const clampedP = Math.max(pctMin, Math.min(pctMax, ov.prevAvgYieldPct));
          const pRatio = (clampedP - pctMin) / (pctMax - pctMin);
          return { cx: centerX, cy: plotY + plotH - pRatio * plotH, hasValue: true };
        }
        return { cx: centerX, cy: plotY + plotH, hasValue: false };
      }
    );

    doc.setDrawColor(79, 70, 229);
    doc.setLineWidth(0.65);
    doc.setLineDashPattern([1.6, 1.2], 0);
    for (let i = 1; i < prevPoints.length; i++) {
      if (prevPoints[i - 1].hasValue && prevPoints[i].hasValue) {
        doc.line(
          prevPoints[i - 1].cx,
          prevPoints[i - 1].cy,
          prevPoints[i].cx,
          prevPoints[i].cy
        );
      }
    }
    doc.setLineDashPattern([], 0);
    for (const pt of prevPoints) {
      if (pt.hasValue) {
        doc.setFillColor(79, 70, 229);
        doc.circle(pt.cx, pt.cy, 0.9, 'F');
      }
    }
  }
}

function drawDimensionComparisonChart(
  doc: jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  items: MonthlyDimensionBreakdown[],
  dimensionView: MonthlyDimensionView
): void {
  doc.setDrawColor(226, 232, 240);
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(x, y, w, h, 1.5, 1.5, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(15, 23, 42);
  doc.text(
    dimensionView === 'line'
      ? 'Output & KPI Yield by Production Line'
      : 'Output & KPI Yield by Top Product / SKU',
    x + 4,
    y + 6
  );

  const topItems = items.slice(0, 6);
  if (topItems.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text('No line/product output in filter scope', x + w / 2, y + h / 2, {
      align: 'center',
    });
    return;
  }

  const maxGood = Math.max(1, ...topItems.map((d) => d.goodQty));
  const labelColW = 34;
  const valueColW = 24;
  const barAreaW = w - 8 - labelColW - valueColW;
  const startY = y + 11.5;
  const rowStep = (h - 15) / topItems.length;

  topItems.forEach((item, idx) => {
    const ry = startY + idx * rowStep;
    const barY = ry + 1;
    const barH = Math.min(4.2, rowStep * 0.46);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(30, 41, 59);
    doc.text(truncateText(item.label, 20), x + 4, ry + 3.6);

    // Background track
    doc.setFillColor(241, 245, 249);
    doc.rect(x + 4 + labelColW, barY, barAreaW, barH, 'F');

    // Fill bar
    const fillW = Math.max(0.6, (item.goodQty / maxGood) * barAreaW);
    doc.setFillColor(15, 118, 110);
    doc.rect(x + 4 + labelColW, barY, fillW, barH, 'F');

    // Metric value on right
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.8);
    const yieldColor: [number, number, number] =
      item.avgYieldPct >= DEFAULT_KPI_YIELD_TARGET_PCT
        ? [4, 120, 87]
        : item.avgYieldPct > 0
          ? [180, 83, 9]
          : [100, 116, 139];
    doc.setTextColor(...yieldColor);
    const yieldStr = item.avgYieldPct > 0 ? `${item.avgYieldPct.toFixed(1)}%` : '—';
    doc.text(
      `${item.goodQty.toLocaleString()} · ${yieldStr}`,
      x + w - 4,
      ry + 3.6,
      { align: 'right' }
    );
  });
}

export function buildMonthlyPdfDocument(payload: MonthlyManagementPdfPayload): {
  doc: jsPDF;
  filename: string;
} {
  const {
    report,
    filters,
    chartMetricMode,
    dimensionView,
    preparedBy = 'Plant Operations Manager',
    userRole = 'manager',
    managementNotes,
    momData,
    showMomOverlay = false,
  } = payload;

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 14;
  const contentWidth = pageWidth - marginX * 2;
  const filterSummary = formatFilterScopeSummary(filters);
  const generatedIso = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const scopeSlug =
    filters.month !== 'ALL'
      ? filters.month
      : filters.year !== 'ALL'
        ? filters.year
        : 'All-Months';
  const docRef = `MPR-${scopeSlug.toUpperCase()}`;

  // --- Executive Dark Header Band ---
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageWidth, 28, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('MANUFACTURING EXECUTION SYSTEM — MONTHLY KPI YIELD & PRODUCTION OUTPUT REPORT', marginX, 11);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.2);
  doc.setTextColor(203, 213, 225);
  doc.text(
    `Management Review Package   |   Ref: ${docRef}   |   Generated: ${generatedIso}   |   Prepared by: ${preparedBy} (${userRole.toUpperCase()})`,
    marginX,
    17.5
  );
  doc.text(`Active Filter Scope: ${truncateText(filterSummary, 130)}`, marginX, 23);

  // KPI Benchmark Badge (Top Right)
  const avgYield = report.summary.avgYieldPct;
  const kpiStatusLabel =
    avgYield <= 0
      ? 'KPI: PENDING'
      : avgYield >= DEFAULT_KPI_YIELD_TARGET_PCT
        ? `KPI: ON TARGET (${avgYield.toFixed(1)}%)`
        : `KPI: BELOW TARGET (${avgYield.toFixed(1)}%)`;
  const badgeColor: [number, number, number] =
    avgYield <= 0
      ? [71, 85, 105]
      : avgYield >= DEFAULT_KPI_YIELD_TARGET_PCT
        ? [21, 128, 61]
        : [180, 83, 9];

  doc.setFillColor(...badgeColor);
  doc.roundedRect(pageWidth - marginX - 54, 7, 54, 9.5, 1.5, 1.5, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.8);
  doc.text(kpiStatusLabel, pageWidth - marginX - 27, 13, { align: 'center' });

  let y = 34;

  // --- Section 1: 4-Card KPI Summary Strip ---
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('1. Executive KPI & Output Summary', marginX, y);
  y += 3;

  const cardGap = 4;
  const cardW = (contentWidth - cardGap * 3) / 4;
  const cardH = 21;
  const cards = [
    {
      title: 'Avg Monthly KPI Yield',
      value: avgYield > 0 ? `${avgYield.toFixed(1)}%` : '—',
      sub: `Weighted: ${report.summary.weightedYieldPct > 0 ? `${report.summary.weightedYieldPct.toFixed(1)}%` : '—'} · Target: ${DEFAULT_KPI_YIELD_TARGET_PCT}%`,
      note: `${report.summary.targetAttainmentPct.toFixed(0)}% of scored orders met target`,
    },
    {
      title: 'Total Good Production Output',
      value: `${report.summary.totalGoodQty.toLocaleString()} units`,
      sub: `Planned: ${report.summary.totalPlannedQty.toLocaleString()} · Plan: ${report.summary.planAttainmentPct.toFixed(1)}%`,
      note:
        report.summary.avgVelocityUnitsPerHr > 0
          ? `Avg Velocity: ${report.summary.avgVelocityUnitsPerHr.toLocaleString()} u/hr (${report.summary.totalOutputMassKg.toLocaleString()} kg)`
          : `Net Output Mass: ${report.summary.totalOutputMassKg.toLocaleString()} kg`,
    },
    {
      title: 'QC Release Pass Rate',
      value:
        report.summary.qcDecidedCount > 0
          ? `${report.summary.qcPassRatePct.toFixed(1)}%`
          : '—',
      sub: `${report.summary.qcPassedCount}/${report.summary.qcDecidedCount} QC decided · ${report.summary.qcHoldBatches} on Hold`,
      note: `${report.summary.completedOrClosedBatches}/${report.summary.totalBatches} completed/closed`,
    },
    {
      title: 'Rejects, Process Waste & Cost',
      value: `${(report.summary.totalRejectedQty + report.summary.totalReworkQty).toLocaleString()} units`,
      sub: `${report.summary.totalRejectedQty} rejected · ${report.summary.totalReworkQty} rework · ${report.summary.totalWasteKg.toFixed(1)} kg`,
      note: `Total Cost: ${formatCurrency(report.summary.totalProductionCost)}`,
    },
  ];

  cards.forEach((c, idx) => {
    const cx = marginX + idx * (cardW + cardGap);
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(cx, y, cardW, cardH, 1.5, 1.5, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.2);
    doc.setTextColor(100, 116, 139);
    doc.text(c.title, cx + 3.5, y + 5.2);

    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text(c.value, cx + 3.5, y + 11.4);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(71, 85, 105);
    doc.text(truncateText(c.sub, 44), cx + 3.5, y + 15.8);
    doc.text(truncateText(c.note, 44), cx + 3.5, y + 19.3);
  });

  y += cardH + 6.5;

  // --- Section 2: Vector Statistics Graphs ---
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('2. Monthly Trend & Performance Comparison Charts', marginX, y);
  y += 3;

  const chartH = 56;
  const leftChartW = 162;
  const rightChartW = contentWidth - leftChartW - 5;

  drawMonthlyVectorChart(
    doc,
    marginX,
    y,
    leftChartW,
    chartH,
    report.months,
    chartMetricMode,
    momData?.overlaySeries,
    showMomOverlay
  );
  drawDimensionComparisonChart(
    doc,
    marginX + leftChartW + 5,
    y,
    rightChartW,
    chartH,
    dimensionView === 'line' ? report.byLine : report.byProduct,
    dimensionView
  );

  y += chartH + 7;

  // --- Section 3: Monthly KPI Yield & Output Breakdown Table ---
  y = ensureSpace(doc, y, 36);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('3. Monthly KPI Yield & Production Output Summary Table', marginX, y);
  y += 3;

  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    theme: 'grid',
    headStyles: {
      fillColor: [15, 118, 110],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 7.5,
    },
    footStyles: {
      fillColor: [241, 245, 249],
      textColor: [15, 23, 42],
      fontStyle: 'bold',
      fontSize: 7.5,
    },
    styles: {
      fontSize: 7.5,
      cellPadding: 2.1,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.25,
    },
    columnStyles: {
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right', fontStyle: 'bold' },
      8: { halign: 'right', fontStyle: 'bold' },
      9: { halign: 'right' },
      10: { halign: 'right' },
    },
    head: [
      [
        'Month',
        'Jobs (Comp)',
        'Planned',
        'Good Output',
        'Plan %',
        'Mass (kg)',
        'Rej / Rwk',
        'Avg Yield %',
        'Velocity (u/h)',
        'QC Pass %',
        'Avg Unit Cost',
      ],
    ],
    body: report.months.map((m) => [
      `${m.label} (${m.yearMonth})`,
      `${m.totalBatches} (${m.completedBatches + m.closedBatches})`,
      m.plannedQty.toLocaleString(),
      m.goodQty.toLocaleString(),
      `${m.planAttainmentPct.toFixed(1)}%`,
      m.outputMassKg.toLocaleString(),
      `${m.rejectedQty} / ${m.reworkQty}`,
      m.avgYieldPct > 0 ? `${m.avgYieldPct.toFixed(1)}%` : '—',
      m.avgVelocityUnitsPerHr > 0
        ? `${m.avgVelocityUnitsPerHr.toLocaleString()}${m.isBottleneck ? ' (Slow)' : ''}`
        : '—',
      m.qcDecidedCount > 0 ? `${m.qcPassRatePct.toFixed(1)}%` : '—',
      m.avgUnitCost > 0 ? formatCurrency(m.avgUnitCost) : '—',
    ]),
    foot: [
      [
        'Period Total / Average',
        `${report.summary.totalBatches} (${report.summary.completedOrClosedBatches})`,
        report.summary.totalPlannedQty.toLocaleString(),
        report.summary.totalGoodQty.toLocaleString(),
        `${report.summary.planAttainmentPct.toFixed(1)}%`,
        report.summary.totalOutputMassKg.toLocaleString(),
        `${report.summary.totalRejectedQty} / ${report.summary.totalReworkQty}`,
        report.summary.avgYieldPct > 0 ? `${report.summary.avgYieldPct.toFixed(1)}%` : '—',
        report.summary.avgVelocityUnitsPerHr > 0
          ? `${report.summary.avgVelocityUnitsPerHr.toLocaleString()}`
          : '—',
        report.summary.qcDecidedCount > 0
          ? `${report.summary.qcPassRatePct.toFixed(1)}%`
          : '—',
        report.summary.avgUnitCost > 0 ? formatCurrency(report.summary.avgUnitCost) : '—',
      ],
    ],
  });

  y = getLastTableY(doc, y + 32) + 7;

  // --- Optional Month-over-Month Yield Comparative Table ---
  if (momData && (showMomOverlay || momData.overlaySeries.some((s) => s.hasPrevData))) {
    y = ensureSpace(doc, y, 32);
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('3B. Month-over-Month Comparative Yield & Output Overlay', marginX, y);
    y += 3;

    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      theme: 'grid',
      headStyles: {
        fillColor: [79, 70, 229],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 7.4,
      },
      styles: {
        fontSize: 7.4,
        cellPadding: 2,
        textColor: [30, 41, 59],
        lineColor: [226, 232, 240],
        lineWidth: 0.25,
      },
      columnStyles: {
        2: { halign: 'right' },
        3: { halign: 'right' },
        4: { halign: 'right' },
        5: { halign: 'right', fontStyle: 'bold' },
        6: { halign: 'right' },
        7: { halign: 'right', fontStyle: 'bold' },
        8: { halign: 'right' },
      },
      head: [
        [
          'Current Month',
          'Previous Month',
          'Curr Output',
          'Prev Output',
          'Output Delta',
          'Curr Yield %',
          'Prev Yield %',
          'MoM Yield Delta',
          'QC Pass Delta',
        ],
      ],
      body: momData.overlaySeries.map((pt) => [
        `${pt.label} (${pt.yearMonth})`,
        pt.prevLabel ? `${pt.prevLabel} (${pt.prevYearMonth})` : '—',
        pt.goodQty.toLocaleString(),
        pt.prevGoodQty !== null ? pt.prevGoodQty.toLocaleString() : '—',
        pt.goodQtyDelta !== null
          ? `${pt.goodQtyDelta >= 0 ? '+' : ''}${pt.goodQtyDelta.toLocaleString()}${
              pt.goodQtyDeltaPct !== null ? ` (${pt.goodQtyDeltaPct >= 0 ? '+' : ''}${pt.goodQtyDeltaPct.toFixed(1)}%)` : ''
            }`
          : '—',
        pt.avgYieldPct > 0 ? `${pt.avgYieldPct.toFixed(1)}%` : '—',
        pt.prevAvgYieldPct !== null ? `${pt.prevAvgYieldPct.toFixed(1)}%` : '—',
        pt.yieldDeltaPts !== null
          ? `${pt.yieldDeltaPts >= 0 ? '+' : ''}${pt.yieldDeltaPts.toFixed(1)} pts`
          : '—',
        pt.qcPassDeltaPts !== null
          ? `${pt.qcPassDeltaPts >= 0 ? '+' : ''}${pt.qcPassDeltaPts.toFixed(1)} pts`
          : '—',
      ]),
    });

    y = getLastTableY(doc, y + 26) + 7;
  }

  // --- Section 4: Production Line & Product Performance Summary ---
  if (report.byLine.length > 0 || report.byProduct.length > 0) {
    y = ensureSpace(doc, y, 36);
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('4. Production Line & Product SKU Performance Breakdown', marginX, y);
    y += 3;

    if (report.byLine.length > 0) {
      autoTable(doc, {
        startY: y,
        margin: { left: marginX, right: marginX },
        theme: 'grid',
        headStyles: {
          fillColor: [30, 41, 59],
          textColor: [255, 255, 255],
          fontStyle: 'bold',
          fontSize: 7.4,
        },
        styles: {
          fontSize: 7.4,
          cellPadding: 2,
          textColor: [30, 41, 59],
          lineColor: [226, 232, 240],
          lineWidth: 0.25,
        },
        columnStyles: {
          1: { halign: 'right' },
          2: { halign: 'right' },
          3: { halign: 'right' },
          4: { halign: 'right' },
          5: { halign: 'right' },
          6: { halign: 'right', fontStyle: 'bold' },
          7: { halign: 'right' },
        },
        head: [
          [
            'Production Line',
            'Jobs',
            'Planned Qty',
            'Good Output',
            'Plan %',
            'Mass (kg)',
            'Avg Yield %',
            'QC Pass %',
          ],
        ],
        body: report.byLine.map((line) => [
          line.label,
          line.batchCount,
          line.plannedQty.toLocaleString(),
          line.goodQty.toLocaleString(),
          `${line.planAttainmentPct.toFixed(1)}%`,
          line.outputMassKg.toLocaleString(),
          line.avgYieldPct > 0 ? `${line.avgYieldPct.toFixed(1)}%` : '—',
          line.qcPassRatePct > 0 ? `${line.qcPassRatePct.toFixed(1)}%` : '—',
        ]),
      });
      y = getLastTableY(doc, y + 24) + 5;
    }

    if (report.byProduct.length > 0) {
      y = ensureSpace(doc, y, 28);
      autoTable(doc, {
        startY: y,
        margin: { left: marginX, right: marginX },
        theme: 'grid',
        headStyles: {
          fillColor: [30, 41, 59],
          textColor: [255, 255, 255],
          fontStyle: 'bold',
          fontSize: 7.4,
        },
        styles: {
          fontSize: 7.4,
          cellPadding: 2,
          textColor: [30, 41, 59],
          lineColor: [226, 232, 240],
          lineWidth: 0.25,
        },
        columnStyles: {
          2: { halign: 'right' },
          3: { halign: 'right' },
          4: { halign: 'right' },
          5: { halign: 'right' },
          6: { halign: 'right', fontStyle: 'bold' },
          7: { halign: 'right' },
        },
        head: [
          [
            'SKU',
            'Product Name',
            'Jobs',
            'Planned Qty',
            'Good Output',
            'Mass (kg)',
            'Avg Yield %',
            'QC Pass %',
          ],
        ],
        body: report.byProduct.map((prod) => [
          prod.label,
          prod.sublabel || '—',
          prod.batchCount,
          prod.plannedQty.toLocaleString(),
          prod.goodQty.toLocaleString(),
          prod.outputMassKg.toLocaleString(),
          prod.avgYieldPct > 0 ? `${prod.avgYieldPct.toFixed(1)}%` : '—',
          prod.qcPassRatePct > 0 ? `${prod.qcPassRatePct.toFixed(1)}%` : '—',
        ]),
      });
      y = getLastTableY(doc, y + 24) + 7;
    }
  }

  // --- Section 5: Filtered Job Order Production Detail ---
  if (report.rows.length > 0) {
    y = ensureSpace(doc, y, 36);
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(
      `5. Filtered Job Order Production Detail (${report.rows.length} Record${report.rows.length === 1 ? '' : 's'})`,
      marginX,
      y
    );
    y += 3;

    autoTable(doc, {
      startY: y,
      margin: { left: marginX, right: marginX },
      theme: 'grid',
      headStyles: {
        fillColor: [15, 118, 110],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 7.3,
      },
      styles: {
        fontSize: 7.2,
        cellPadding: 1.9,
        textColor: [30, 41, 59],
        lineColor: [226, 232, 240],
        lineWidth: 0.25,
      },
      columnStyles: {
        5: { halign: 'right' },
        6: { halign: 'right' },
        7: { halign: 'right' },
        8: { halign: 'right', fontStyle: 'bold' },
      },
      head: [
        [
          'Month / Date',
          'Batch # / Lot #',
          'Product & SKU',
          'Category',
          'Line',
          'Planned',
          'Good Output',
          'Mass (kg)',
          'Yield %',
          'Status / QC',
        ],
      ],
      body: report.rows.map(({ batch, monthLabel, category, outputMassKg }) => [
        `${monthLabel}\n${batch.plannedDate || '—'}`,
        `${batch.batchNumber}\n${batch.lotNumber || 'Pending'}`,
        `${batch.productName}\n${batch.sku}`,
        category,
        batch.lineName,
        `${batch.plannedQty.toLocaleString()} ${batch.outputUnit}`,
        `${batch.goodQty.toLocaleString()} ${batch.outputUnit}`,
        outputMassKg > 0 ? outputMassKg.toLocaleString() : '—',
        batch.yieldPct > 0 ? `${batch.yieldPct.toFixed(1)}%` : '—',
        `${batch.status} · QC ${batch.qcStatus}`,
      ]),
    });

    y = getLastTableY(doc, y + 30) + 8;
  }

  // --- Section 6: Management Review Notes & Sign-Off ---
  const neededSigSpace = managementNotes && managementNotes.trim() ? 36 : 24;
  y = ensureSpace(doc, y, neededSigSpace);

  if (managementNotes && managementNotes.trim()) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(15, 23, 42);
    doc.text('Management Review Notes:', marginX, y);
    y += 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(51, 65, 85);
    const wrappedNotes = doc.splitTextToSize(managementNotes.trim(), contentWidth);
    doc.text(wrappedNotes, marginX, y);
    y += wrappedNotes.length * 4 + 4;
  }

  const sigW = (contentWidth - 16) / 3;
  const sigLabels = [
    `Prepared By (${preparedBy})`,
    'Production Operations Manager',
    'Quality & Plant Director',
  ];
  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(0.3);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.8);
  doc.setTextColor(71, 85, 105);

  sigLabels.forEach((label, idx) => {
    const sx = marginX + idx * (sigW + 8);
    doc.line(sx, y + 8, sx + sigW, y + 8);
    doc.text(truncateText(label, 42), sx, y + 12.2);
    doc.text('Signature & Review Date', sx, y + 15.8);
  });

  // Page Footers across all pages
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    const pageH = doc.internal.pageSize.getHeight();
    doc.setDrawColor(226, 232, 240);
    doc.line(marginX, pageH - 11, pageWidth - marginX, pageH - 11);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.2);
    doc.setTextColor(100, 116, 139);
    doc.text(
      `Manufacturing Execution System · Management Review Report (${docRef}) · ${truncateText(filterSummary, 95)}`,
      marginX,
      pageH - 6.8
    );
    doc.text(`Page ${p} of ${totalPages}`, pageWidth - marginX, pageH - 6.8, {
      align: 'right',
    });
  }

  const dateStamp = new Date().toISOString().slice(0, 10);
  const safeScope = scopeSlug.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `Kettler_Monthly_Management_Report_${safeScope}_${dateStamp}.pdf`;

  return { doc, filename };
}

export function generateMonthlyManagementPdf(payload: MonthlyManagementPdfPayload): string {
  const { doc, filename } = buildMonthlyPdfDocument(payload);
  doc.save(filename);
  return filename;
}
