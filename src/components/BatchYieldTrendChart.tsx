import { useCallback, useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ArrowUpRight, RotateCcw } from 'lucide-react';
import type { BatchYieldTrendPoint, BatchYieldTrendsResponse } from '../types';
import { fetchBatchYieldTrends, WORKSPACE_SYNC_EVENT } from '../services/mesService';
import { formatCurrency } from '../utils/units';

interface BatchYieldTrendChartProps {
  onOpenBatch: (batchId: string) => void;
}

type TrendMetric = 'yieldPct' | 'variancePct';

export function BatchYieldTrendChart({ onOpenBatch }: BatchYieldTrendChartProps) {
  const [selectedLine, setSelectedLine] = useState<string>('ALL');
  const [metric, setMetric] = useState<TrendMetric>('yieldPct');
  const [trendData, setTrendData] = useState<BatchYieldTrendsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<{
    point: BatchYieldTrendPoint;
    x: number;
    y: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [chartWidth, setChartWidth] = useState<number>(760);

  const loadTrends = useCallback(async (line: string, isInitial = false) => {
    try {
      if (isInitial) setLoading(true);
      const data = await fetchBatchYieldTrends(line);
      setTrendData(data);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to load historical yield performance.'
      );
    } finally {
      if (isInitial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTrends(selectedLine, true);

    const handleSync = () => {
      void loadTrends(selectedLine, false);
    };
    window.addEventListener(WORKSPACE_SYNC_EVENT, handleSync);
    return () => {
      window.removeEventListener(WORKSPACE_SYNC_EVENT, handleSync);
    };
  }, [selectedLine, loadTrends]);

  // Track responsive container width with ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateWidth = () => {
      const next = Math.max(320, Math.floor(el.clientWidth));
      setChartWidth(next);
    };
    updateWidth();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => updateWidth());
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  // Render D3.js chart whenever data, metric, or container width changes
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !trendData || trendData.points.length === 0) return;

    const points = trendData.points;
    const height = 276;
    const margin = { top: 20, right: 28, bottom: 48, left: 52 };
    const innerWidth = Math.max(180, chartWidth - margin.left - margin.right);
    const innerHeight = height - margin.top - margin.bottom;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${chartWidth} ${height}`).attr('width', chartWidth).attr('height', height);

    const defs = svg.append('defs');
    const areaGrad = defs
      .append('linearGradient')
      .attr('id', 'kettler-yield-area-gradient')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '0%')
      .attr('y2', '100%');
    areaGrad
      .append('stop')
      .attr('offset', '0%')
      .attr('stop-color', metric === 'yieldPct' ? '#0F766E' : '#2563EB')
      .attr('stop-opacity', 0.16);
    areaGrad
      .append('stop')
      .attr('offset', '100%')
      .attr('stop-color', metric === 'yieldPct' ? '#0F766E' : '#2563EB')
      .attr('stop-opacity', 0.0);

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const xScale = d3
      .scalePoint<string>()
      .domain(points.map((p) => p.id))
      .range([0, innerWidth])
      .padding(points.length === 1 ? 0.5 : 0.2);

    const values = points.map((p) => (metric === 'yieldPct' ? p.yieldPct : p.variancePct));
    const benchmarkValue = metric === 'yieldPct' ? trendData.targetYieldPct : 0;

    let yMin: number;
    let yMax: number;
    if (metric === 'yieldPct') {
      const minVal = Math.min(...values, benchmarkValue);
      const maxVal = Math.max(...values, benchmarkValue);
      yMin = Math.max(0, Math.floor(minVal - 2.5));
      yMax = Math.min(104, Math.ceil(maxVal + 2));
    } else {
      const minVal = Math.min(...values, 0);
      const maxVal = Math.max(...values, 0);
      yMin = Math.floor(minVal - 1.5);
      yMax = Math.ceil(maxVal + 1.5);
    }

    const yScale = d3.scaleLinear().domain([yMin, yMax]).nice().range([innerHeight, 0]);

    // Horizontal gridlines
    const yTicks = yScale.ticks(5);
    g.append('g')
      .selectAll('line')
      .data(yTicks)
      .join('line')
      .attr('x1', 0)
      .attr('x2', innerWidth)
      .attr('y1', (d) => yScale(d))
      .attr('y2', (d) => yScale(d))
      .attr('stroke', '#E2E8F0')
      .attr('stroke-dasharray', '3,3');

    // Y-Axis
    const yAxis = d3
      .axisLeft(yScale)
      .ticks(5)
      .tickSize(0)
      .tickPadding(10)
      .tickFormat((d) => `${Number(d).toFixed(0)}%`);

    const yAxisGroup = g.append('g').call(yAxis);
    yAxisGroup.select('.domain').remove();
    yAxisGroup
      .selectAll('text')
      .attr('fill', '#64748B')
      .attr('font-size', '11px')
      .attr('font-family', '"IBM Plex Mono", monospace');

    // X-Axis with Date + Batch Number labels
    const pointById = new Map(points.map((p) => [p.id, p]));
    const xAxis = d3.axisBottom(xScale).tickSize(0).tickPadding(12).tickFormat((id) => {
      const item = pointById.get(id);
      if (!item) return '';
      return `${item.plannedDate.slice(5)} · ${item.batchNumber.replace('B-', '')}`;
    });

    const xAxisGroup = g
      .append('g')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(xAxis);
    xAxisGroup.select('.domain').attr('stroke', '#CBD5E1');
    xAxisGroup
      .selectAll('text')
      .attr('fill', '#64748B')
      .attr('font-size', '11px')
      .attr('font-family', '"IBM Plex Mono", monospace');

    // Benchmark reference line (96.5% plant yield target or 0.0% variance)
    const benchmarkY = yScale(benchmarkValue);
    g.append('line')
      .attr('x1', 0)
      .attr('x2', innerWidth)
      .attr('y1', benchmarkY)
      .attr('y2', benchmarkY)
      .attr('stroke', metric === 'yieldPct' ? '#0F766E' : '#475569')
      .attr('stroke-width', 1.25)
      .attr('stroke-dasharray', '5,4');

    g.append('text')
      .attr('x', innerWidth)
      .attr('y', benchmarkY - 6)
      .attr('text-anchor', 'end')
      .attr('fill', metric === 'yieldPct' ? '#0F766E' : '#475569')
      .attr('font-size', '10px')
      .attr('font-weight', '600')
      .attr('font-family', '"IBM Plex Mono", monospace')
      .text(
        metric === 'yieldPct'
          ? `Plant Target ${trendData.targetYieldPct.toFixed(1)}%`
          : 'Zero Variance (0.0%)'
      );

    const strokeColor = metric === 'yieldPct' ? '#0F766E' : '#2563EB';

    // Area & Line curves when >= 2 points
    if (points.length >= 2) {
      const areaGen = d3
        .area<BatchYieldTrendPoint>()
        .x((d) => xScale(d.id) ?? 0)
        .y0(metric === 'yieldPct' ? innerHeight : yScale(0))
        .y1((d) => yScale(metric === 'yieldPct' ? d.yieldPct : d.variancePct))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(points)
        .attr('fill', 'url(#kettler-yield-area-gradient)')
        .attr('d', areaGen);

      const lineGen = d3
        .line<BatchYieldTrendPoint>()
        .x((d) => xScale(d.id) ?? 0)
        .y((d) => yScale(metric === 'yieldPct' ? d.yieldPct : d.variancePct))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(points)
        .attr('fill', 'none')
        .attr('stroke', strokeColor)
        .attr('stroke-width', 2.25)
        .attr('d', lineGen);
    }

    // Hover crosshair guide line (hidden until hovered)
    const hoverGuide = g
      .append('line')
      .attr('y1', 0)
      .attr('y2', innerHeight)
      .attr('stroke', '#94A3B8')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,3')
      .style('opacity', 0);

    // Data point nodes
    const nodeColor = (p: BatchYieldTrendPoint) => {
      if (p.yieldPct >= trendData.targetYieldPct) return '#047857';
      if (p.yieldPct >= 93.5) return '#B45309';
      return '#B91C1C';
    };

    const nodes = g
      .selectAll('g.yield-node')
      .data(points)
      .join('g')
      .attr('class', 'yield-node')
      .attr('transform', (d) => {
        const cx = xScale(d.id) ?? 0;
        const cy = yScale(metric === 'yieldPct' ? d.yieldPct : d.variancePct);
        return `translate(${cx},${cy})`;
      })
      .style('cursor', 'pointer');

    nodes
      .append('circle')
      .attr('r', 6)
      .attr('fill', '#FFFFFF')
      .attr('stroke', (d) => nodeColor(d))
      .attr('stroke-width', 2.5);

    nodes
      .append('circle')
      .attr('r', 2.5)
      .attr('fill', (d) => nodeColor(d));

    // Inline value callout above each point
    nodes
      .append('text')
      .attr('y', -12)
      .attr('text-anchor', 'middle')
      .attr('fill', '#0F172A')
      .attr('font-size', '11px')
      .attr('font-weight', '600')
      .attr('font-family', '"IBM Plex Mono", monospace')
      .text((d) =>
        metric === 'yieldPct'
          ? `${d.yieldPct.toFixed(1)}%`
          : `${d.variancePct >= 0 ? '+' : ''}${d.variancePct.toFixed(1)}%`
      );

    // Large invisible hit targets for smooth mouse/touch hovering & clicking
    nodes
      .append('circle')
      .attr('r', 18)
      .attr('fill', 'transparent')
      .on('mouseenter', function (_event, d) {
        const cx = xScale(d.id) ?? 0;
        const cy = yScale(metric === 'yieldPct' ? d.yieldPct : d.variancePct);
        hoverGuide.attr('x1', cx).attr('x2', cx).style('opacity', 1);
        setHoveredPoint({
          point: d,
          x: margin.left + cx,
          y: margin.top + cy,
        });
      })
      .on('mouseleave', () => {
        hoverGuide.style('opacity', 0);
        setHoveredPoint(null);
      })
      .on('click', (_event, d) => {
        onOpenBatch(d.id);
      });
  }, [trendData, metric, chartWidth, onOpenBatch]);

  const points = trendData?.points ?? [];

  return (
    <section className="bg-white border border-slate-200 rounded-lg p-5 h-full flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-100">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Historical Batch Yield Trends
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Chronological yield performance across completed runs — hover to inspect lot metrics or
            click a point to open batch record
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <select
            aria-label="Filter yield trends by production line"
            value={selectedLine}
            onChange={(e) => setSelectedLine(e.target.value)}
            className="border border-slate-200 bg-white rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:outline-none focus:border-teal-700"
          >
            <option value="ALL">All Production Lines</option>
            {(trendData?.availableLines ?? []).map((line) => (
              <option key={line} value={line}>
                {line}
              </option>
            ))}
          </select>

          <div className="inline-flex rounded-md border border-slate-200 bg-[#F7F8FA] p-0.5">
            <button
              type="button"
              onClick={() => setMetric('yieldPct')}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                metric === 'yieldPct'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Yield %
            </button>
            <button
              type="button"
              onClick={() => setMetric('variancePct')}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                metric === 'variancePct'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Variance %
            </button>
          </div>
        </div>
      </div>

      {/* Summary Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 py-3.5 border-b border-slate-100 text-xs">
        <div>
          <div className="text-slate-500">Scored Runs</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-slate-900 tabular-nums">
            {points.length} batch{points.length === 1 ? '' : 'es'}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Historical Avg Yield</div>
          <div
            className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${
              (trendData?.avgYieldPct ?? 0) >= 96.5
                ? 'text-emerald-700'
                : (trendData?.avgYieldPct ?? 0) > 0
                  ? 'text-amber-700'
                  : 'text-slate-900'
            }`}
          >
            {trendData && trendData.avgYieldPct > 0
              ? `${trendData.avgYieldPct.toFixed(1)}%`
              : '—'}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Top Performing Batch</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-slate-900 tabular-nums truncate">
            {trendData?.bestBatchNumber
              ? `${trendData.bestBatchNumber} (${trendData.bestYieldPct?.toFixed(1)}%)`
              : '—'}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Cumulative Process Waste</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-slate-900 tabular-nums">
            {trendData ? `${trendData.totalWasteKg.toFixed(1)} kg` : '—'}
          </div>
        </div>
      </div>

      {/* Chart Viewport */}
      {error ? (
        <div className="py-12 flex flex-col items-center justify-center gap-3 text-center">
          <p className="text-xs text-slate-600">{error}</p>
          <button
            type="button"
            onClick={() => void loadTrends(selectedLine, true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="h-[276px] mt-4 bg-[#F7F8FA] rounded-md animate-pulse" />
      ) : points.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-500">
          No completed output batches recorded for this line yet. Report batch output in Batch
          Execution to track historical yield trends.
        </div>
      ) : (
        <div ref={containerRef} className="relative flex-1 mt-4 w-full select-none">
          <svg
            ref={svgRef}
            role="img"
            aria-label="D3 batch yield trends over time chart"
            className="block w-full overflow-visible"
          />

          {/* Floating D3 Inspection Tooltip */}
          {hoveredPoint && (
            <div
              className="pointer-events-none absolute z-20 w-64 rounded-md border border-slate-200 bg-white p-3 shadow-md"
              style={{
                left: `${Math.min(Math.max(12, hoveredPoint.x - 128), Math.max(12, chartWidth - 268))}px`,
                top: `${Math.max(4, hoveredPoint.y - 134)}px`,
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-slate-900">
                  {hoveredPoint.point.batchNumber}
                </span>
                <span className="font-mono text-[11px] text-slate-500">
                  {hoveredPoint.point.plannedDate}
                </span>
              </div>
              <div className="mt-0.5 text-xs font-medium text-slate-800 truncate">
                {hoveredPoint.point.productName}
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                {hoveredPoint.point.lineName} · {hoveredPoint.point.sku}
              </div>
              <div className="mt-2 pt-2 border-t border-slate-100 grid grid-cols-2 gap-y-1 text-[11px] font-mono tabular-nums">
                <span className="text-slate-500">Yield:</span>
                <span
                  className={`text-right font-semibold ${
                    hoveredPoint.point.yieldPct >= 96.5
                      ? 'text-emerald-700'
                      : hoveredPoint.point.yieldPct >= 93.5
                        ? 'text-amber-700'
                        : 'text-red-700'
                  }`}
                >
                  {hoveredPoint.point.yieldPct.toFixed(1)}% (
                  {hoveredPoint.point.variancePct >= 0 ? '+' : ''}
                  {hoveredPoint.point.variancePct.toFixed(1)}%)
                </span>
                <span className="text-slate-500">Good Output:</span>
                <span className="text-right text-slate-900">
                  {hoveredPoint.point.goodQty.toLocaleString()}/{hoveredPoint.point.plannedQty.toLocaleString()}{' '}
                  {hoveredPoint.point.outputUnit}
                </span>
                <span className="text-slate-500">Waste / Cost:</span>
                <span className="text-right text-slate-900">
                  {hoveredPoint.point.wasteKg} kg · {formatCurrency(hoveredPoint.point.unitCost)}/u
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-teal-700">
                <span>Click node to open batch</span>
                <ArrowUpRight className="w-3 h-3" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Legend Footer */}
      {points.length > 0 && (
        <div className="mt-2 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-[11px] text-slate-500">
          <div className="flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-700 inline-block" />
              On / Above Target (≥96.5%)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-700 inline-block" />
              Minor Variance (93.5–96.4%)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-700 inline-block" />
              Below Threshold (&lt;93.5%)
            </span>
          </div>
          <span className="font-mono">Click any node to inspect batch execution</span>
        </div>
      )}
    </section>
  );
}
