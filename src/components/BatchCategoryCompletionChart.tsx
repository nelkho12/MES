import { useCallback, useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ArrowUpRight, RotateCcw } from 'lucide-react';
import type {
  ActiveTab,
  BatchCategoryCompletionItem,
  BatchCategoryCompletionResponse,
} from '../types';
import { fetchBatchCategoryCompletion, WORKSPACE_SYNC_EVENT } from '../services/mesService';

interface BatchCategoryCompletionChartProps {
  onOpenBatch: (batchId: string) => void;
  onNavigate: (tab: ActiveTab) => void;
}

type CompletionMetricMode = 'completion' | 'volume';

export function BatchCategoryCompletionChart({
  onOpenBatch,
  onNavigate,
}: BatchCategoryCompletionChartProps) {
  const [mode, setMode] = useState<CompletionMetricMode>('completion');
  const [data, setData] = useState<BatchCategoryCompletionResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredItem, setHoveredItem] = useState<{
    item: BatchCategoryCompletionItem;
    x: number;
    y: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [chartWidth, setChartWidth] = useState<number>(460);

  const loadCompletion = useCallback(async (isInitial = false) => {
    try {
      if (isInitial) setLoading(true);
      const res = await fetchBatchCategoryCompletion();
      setData(res);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to load category completion analytics.'
      );
    } finally {
      if (isInitial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCompletion(true);

    const handleSync = () => {
      void loadCompletion(false);
    };
    window.addEventListener(WORKSPACE_SYNC_EVENT, handleSync);
    return () => {
      window.removeEventListener(WORKSPACE_SYNC_EVENT, handleSync);
    };
  }, [loadCompletion]);

  // Track responsive container width with ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateWidth = () => {
      const next = Math.max(280, Math.floor(el.clientWidth));
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

  // Render D3.js horizontal category completion chart
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !data || data.categories.length === 0) return;

    const categories = data.categories;
    const height = Math.max(256, categories.length * 68 + 56);
    const margin = { top: 22, right: 98, bottom: 34, left: 86 };
    const innerWidth = Math.max(120, chartWidth - margin.left - margin.right);
    const innerHeight = height - margin.top - margin.bottom;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    svg
      .attr('viewBox', `0 0 ${chartWidth} ${height}`)
      .attr('width', chartWidth)
      .attr('height', height);

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const xScale = d3.scaleLinear().domain([0, 100]).range([0, innerWidth]);

    const yScale = d3
      .scaleBand<string>()
      .domain(categories.map((c) => c.category))
      .range([0, innerHeight])
      .padding(0.38);

    // Vertical percentage gridlines
    const xTicks = [0, 25, 50, 75, 100];
    g.append('g')
      .selectAll('line')
      .data(xTicks)
      .join('line')
      .attr('x1', (d) => xScale(d))
      .attr('x2', (d) => xScale(d))
      .attr('y1', 0)
      .attr('y2', innerHeight)
      .attr('stroke', '#E2E8F0')
      .attr('stroke-dasharray', (d) => (d === 0 || d === 100 ? 'none' : '3,3'));

    // X-Axis ticks
    const xAxis = d3
      .axisBottom(xScale)
      .tickValues(xTicks)
      .tickSize(0)
      .tickPadding(10)
      .tickFormat((d) => `${Number(d)}%`);

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

    // Plant-wide benchmark reference line in Completion mode
    if (mode === 'completion' && data.totalBatches > 0) {
      const avgX = xScale(data.overallCompletionRatePct);
      g.append('line')
        .attr('x1', avgX)
        .attr('x2', avgX)
        .attr('y1', -4)
        .attr('y2', innerHeight)
        .attr('stroke', '#0F766E')
        .attr('stroke-width', 1.25)
        .attr('stroke-dasharray', '4,3');

      g.append('text')
        .attr('x', Math.min(innerWidth, Math.max(0, avgX)))
        .attr('y', -9)
        .attr(
          'text-anchor',
          data.overallCompletionRatePct > 78
            ? 'end'
            : data.overallCompletionRatePct < 18
              ? 'start'
              : 'middle'
        )
        .attr('fill', '#0F766E')
        .attr('font-size', '10px')
        .attr('font-weight', '600')
        .attr('font-family', '"IBM Plex Mono", monospace')
        .text(`Plant Avg ${data.overallCompletionRatePct.toFixed(1)}%`);
    }

    const barHeight = Math.min(24, Math.max(16, yScale.bandwidth()));

    const rows = g
      .selectAll('g.category-row')
      .data(categories)
      .join('g')
      .attr('class', 'category-row')
      .attr('transform', (d) => {
        const top = (yScale(d.category) ?? 0) + (yScale.bandwidth() - barHeight) / 2;
        return `translate(0,${top})`;
      })
      .style('cursor', 'pointer');

    // Full-width subtle background track
    rows
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', innerWidth)
      .attr('height', barHeight)
      .attr('rx', 3)
      .attr('fill', '#F1F5F9');

    if (mode === 'completion') {
      // In-flight segment (In Progress + QC Hold) stacked immediately after completed
      rows
        .append('rect')
        .attr('x', (d) => xScale(d.completionRatePct))
        .attr('y', 0)
        .attr('width', (d) =>
          Math.max(
            0,
            xScale(Math.min(100, d.completionRatePct + d.inFlightRatePct)) -
              xScale(d.completionRatePct)
          )
        )
        .attr('height', barHeight)
        .attr('rx', 2)
        .attr('fill', '#F59E0B')
        .attr('fill-opacity', 0.38);

      // Completed / Closed primary bar
      rows
        .append('rect')
        .attr('class', 'primary-bar')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', (d) => Math.max(0, xScale(d.completionRatePct)))
        .attr('height', barHeight)
        .attr('rx', 3)
        .attr('fill', '#0F766E');
    } else {
      // Output Volume Fulfillment bar
      rows
        .append('rect')
        .attr('class', 'primary-bar')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', (d) => Math.max(0, xScale(d.volumeCompletionPct)))
        .attr('height', barHeight)
        .attr('rx', 3)
        .attr('fill', '#2563EB');
    }

    // Category label on left
    rows
      .append('text')
      .attr('x', -10)
      .attr('y', barHeight / 2)
      .attr('dy', '0.35em')
      .attr('text-anchor', 'end')
      .attr('fill', '#0F172A')
      .attr('font-size', '12px')
      .attr('font-weight', '600')
      .text((d) =>
        d.category.length > 11 ? `${d.category.slice(0, 10)}…` : d.category
      );

    // Right-hand monospace completion percentage + ratio
    rows
      .append('text')
      .attr('x', innerWidth + 10)
      .attr('y', barHeight / 2)
      .attr('dy', '0.35em')
      .attr('text-anchor', 'start')
      .attr('fill', (d) => (d.totalBatches === 0 ? '#94A3B8' : '#0F172A'))
      .attr('font-size', '11px')
      .attr('font-weight', '600')
      .attr('font-family', '"IBM Plex Mono", monospace')
      .text((d) => {
        if (d.totalBatches === 0) return '0.0% · 0/0';
        return mode === 'completion'
          ? `${d.completionRatePct.toFixed(1)}% · ${d.completedBatches}/${d.totalBatches}`
          : `${d.volumeCompletionPct.toFixed(1)}% · ${d.goodQtyTotal.toLocaleString()}`;
      });

    // Interactive transparent hit row for hover tooltip and click-to-inspect
    rows
      .append('rect')
      .attr('x', -margin.left)
      .attr('y', -10)
      .attr('width', chartWidth)
      .attr('height', barHeight + 20)
      .attr('fill', 'transparent')
      .on('mouseenter', function (_event, d) {
        d3.select(this.parentNode as SVGGElement)
          .select('.primary-bar')
          .attr('fill-opacity', 0.85);
        const top = (yScale(d.category) ?? 0) + (yScale.bandwidth() - barHeight) / 2;
        const pct =
          mode === 'completion' ? d.completionRatePct : d.volumeCompletionPct;
        setHoveredItem({
          item: d,
          x: margin.left + Math.min(innerWidth - 20, Math.max(40, xScale(pct))),
          y: margin.top + top,
        });
      })
      .on('mouseleave', function () {
        d3.select(this.parentNode as SVGGElement)
          .select('.primary-bar')
          .attr('fill-opacity', 1);
        setHoveredItem(null);
      })
      .on('click', (_event, d) => {
        if (d.latestBatchId) {
          onOpenBatch(d.latestBatchId);
        } else {
          onNavigate('batches');
        }
      });
  }, [data, mode, chartWidth, onOpenBatch, onNavigate]);

  const categories = data?.categories ?? [];

  return (
    <section className="bg-white border border-slate-200 rounded-lg p-5 h-full flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-100">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Batch Completion by Category
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Completion rate and in-flight breakdown across Sauce, Syrup &amp; Powder runs
          </p>
        </div>

        <div className="inline-flex rounded-md border border-slate-200 bg-[#F7F8FA] p-0.5 shrink-0">
          <button
            type="button"
            onClick={() => setMode('completion')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
              mode === 'completion'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Completion %
          </button>
          <button
            type="button"
            onClick={() => setMode('volume')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
              mode === 'volume'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Output %
          </button>
        </div>
      </div>

      {/* Summary Strip */}
      <div className="grid grid-cols-3 gap-4 py-3.5 border-b border-slate-100 text-xs">
        <div>
          <div className="text-slate-500">Overall Rate</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-slate-900 tabular-nums">
            {data ? `${data.overallCompletionRatePct.toFixed(1)}%` : '—'}
            <span className="ml-1.5 text-[11px] font-normal text-slate-500">
              {data ? `${data.completedBatches}/${data.totalBatches}` : ''}
            </span>
          </div>
        </div>
        <div>
          <div className="text-slate-500">Top Category</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-teal-800 tabular-nums truncate">
            {data?.leadingCategory
              ? `${data.leadingCategory} (${data.leadingCompletionRatePct?.toFixed(0)}%)`
              : '—'}
          </div>
        </div>
        <div>
          <div className="text-slate-500">In-Flight / QC</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-amber-700 tabular-nums">
            {data ? `${data.inFlightCount} active` : '—'}
          </div>
        </div>
      </div>

      {/* D3 Chart Viewport */}
      {error ? (
        <div className="flex-1 py-12 flex flex-col items-center justify-center gap-3 text-center">
          <p className="text-xs text-slate-600">{error}</p>
          <button
            type="button"
            onClick={() => void loadCompletion(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="flex-1 min-h-[256px] mt-4 bg-[#F7F8FA] rounded-md animate-pulse" />
      ) : categories.length === 0 ? (
        <div className="flex-1 py-12 flex flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm text-slate-500">
            No product categories or job orders configured yet.
          </p>
          <button
            type="button"
            onClick={() => onNavigate('batches')}
            className="px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
          >
            Open Batch Execution
          </button>
        </div>
      ) : (
        <div ref={containerRef} className="relative flex-1 mt-4 w-full select-none">
          <svg
            ref={svgRef}
            role="img"
            aria-label="D3 batch completion rates by product category chart"
            className="block w-full overflow-visible"
          />

          {/* Floating Category Breakdown Tooltip */}
          {hoveredItem && (
            <div
              className="pointer-events-none absolute z-20 w-60 rounded-md border border-slate-200 bg-white p-3 shadow-md"
              style={{
                left: `${Math.min(
                  Math.max(8, hoveredItem.x - 120),
                  Math.max(8, chartWidth - 248)
                )}px`,
                top: `${Math.max(4, hoveredItem.y - 126)}px`,
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-900">
                  {hoveredItem.item.category}
                </span>
                <span className="font-mono text-[11px] font-semibold text-teal-800 tabular-nums">
                  {hoveredItem.item.completionRatePct.toFixed(1)}% done
                </span>
              </div>
              <div className="mt-2 pt-2 border-t border-slate-100 grid grid-cols-2 gap-y-1 text-[11px] font-mono tabular-nums">
                <span className="text-slate-500">Completed:</span>
                <span className="text-right text-emerald-700 font-semibold">
                  {hoveredItem.item.completedBatches} / {hoveredItem.item.totalBatches}
                </span>
                <span className="text-slate-500">In Progress / QC:</span>
                <span className="text-right text-amber-700">
                  {hoveredItem.item.inProgressBatches + hoveredItem.item.qcHoldBatches} (
                  {hoveredItem.item.qcHoldBatches} QC)
                </span>
                <span className="text-slate-500">Planned Queue:</span>
                <span className="text-right text-slate-700">
                  {hoveredItem.item.plannedBatches}
                </span>
                <span className="text-slate-500">Output / Yield:</span>
                <span className="text-right text-slate-900">
                  {hoveredItem.item.volumeCompletionPct.toFixed(0)}% ·{' '}
                  {hoveredItem.item.avgYieldPct > 0
                    ? `${hoveredItem.item.avgYieldPct.toFixed(1)}%`
                    : '—'}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-teal-700">
                <span>
                  {hoveredItem.item.latestBatchNumber
                    ? `Click to inspect ${hoveredItem.item.latestBatchNumber}`
                    : 'Click to open batch queue'}
                </span>
                <ArrowUpRight className="w-3 h-3" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Legend Footer */}
      {categories.length > 0 && (
        <div className="mt-2 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-[11px] text-slate-500">
          {mode === 'completion' ? (
            <div className="flex flex-wrap items-center gap-3.5">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-[#0F766E] inline-block" />
                Completed / Closed
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-amber-400/50 inline-block" />
                In Progress / QC Hold
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-slate-200 inline-block" />
                Planned
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3.5">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-[#2563EB] inline-block" />
                Good Output vs Planned Qty
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={() => onNavigate('batch-check')}
            className="font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
          >
            Batch Check Specs
          </button>
        </div>
      )}
    </section>
  );
}
