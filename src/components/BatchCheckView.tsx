import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Beaker,
  CheckCircle2,
  ClipboardCheck,
  Edit3,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type {
  BatchCheckAdditionalParam,
  BatchCheckAdditionalReading,
  BatchCheckConditionStatus,
  BatchCheckProductCategory,
  BatchCheckRecord,
  BatchCheckSpec,
  CategoryParameterPresetMap,
  ProductionBatch,
} from '../types';
import {
  createBatchCheckRecord,
  deleteBatchCheckRecord,
  deleteBatchCheckSpec,
  saveBatchCheckSpec,
  updateBatchCheckRecord,
  updatePlantOptions,
} from '../services/mesService';

interface BatchCheckViewProps {
  specs: BatchCheckSpec[];
  records: BatchCheckRecord[];
  batches: ProductionBatch[];
  productCategories?: string[];
  categoryParameterPresets?: CategoryParameterPresetMap;
  operatorName: string;
  onNotify: (msg: string) => void;
}

type CategoryFilter = 'All' | BatchCheckProductCategory;

const DEFAULT_CATEGORIES: BatchCheckProductCategory[] = [
  'Sauce',
  'Syrup',
  'Powder',
];
const SAMPLING_STAGES = [
  'Start of Run',
  'In-Process',
  'Pre-Fill',
  'Final Composite',
];

interface CategoryPreset {
  phMin: string;
  phMax: string;
  awMin: string;
  awMax: string;
  brixMin: string;
  brixMax: string;
  requirementNotes: string;
  additionalParams: BatchCheckAdditionalParam[];
}

const CATEGORY_PRESETS: Record<BatchCheckProductCategory, CategoryPreset> = {
  Sauce: {
    phMin: '3.90',
    phMax: '4.30',
    awMin: '',
    awMax: '',
    brixMin: '8.5',
    brixMax: '11.0',
    requirementNotes:
      'Acidified culinary sauce standard — verify pH <= 4.30 and Brix prior to hot-fill transfer (Aw optional/not required).',
    additionalParams: [
      {
        id: 'prm-viscosity',
        name: 'Brookfield Viscosity',
        unit: 'cP',
        minTarget: 1400,
        maxTarget: 2100,
        targetNote: 'Spindle #4 @ 20 RPM, 25°C',
      },
      {
        id: 'prm-core-temp',
        name: 'Hot-Fill Core Temp',
        unit: '°C',
        minTarget: 84,
        maxTarget: 90,
        targetNote: 'Filler hopper core probe',
      },
    ],
  },
  Syrup: {
    phMin: '3.50',
    phMax: '4.20',
    awMin: '',
    awMax: '',
    brixMin: '30.0',
    brixMax: '35.0',
    requirementNotes:
      'High-solids syrup / glaze standard — maintain Brix >= 30.0°Bx and check inline strainer clarity (Aw optional/not required).',
    additionalParams: [
      {
        id: 'prm-sg',
        name: 'Specific Gravity',
        unit: 'SG',
        minTarget: 1.13,
        maxTarget: 1.16,
        targetNote: 'Hydrometer @ 20°C',
      },
      {
        id: 'prm-mesh',
        name: 'Strainer Clarity',
        unit: 'μm',
        minTarget: null,
        maxTarget: 150,
        targetNote: '100% pass through 150 μm basket',
      },
    ],
  },
  Powder: {
    phMin: '4.80',
    phMax: '6.20',
    awMin: '0.150',
    awMax: '0.420',
    brixMin: '',
    brixMax: '',
    requirementNotes:
      'Low-Aw dry seasoning / powder standard — pH measured on 10% w/w aqueous slurry; Aw must remain <= 0.420.',
    additionalParams: [
      {
        id: 'prm-moisture',
        name: 'Loss-on-Drying Moisture',
        unit: '%',
        minTarget: 1.0,
        maxTarget: 4.5,
        targetNote: 'Halogen moisture analyzer @ 105°C',
      },
      {
        id: 'prm-sieve',
        name: '60-Mesh Sieve Pass',
        unit: '%',
        minTarget: 97.0,
        maxTarget: 100.0,
        targetNote: 'Zero agglomerates retained on #60 mesh',
      },
    ],
  },
};

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function formatRange(
  min: number | null,
  max: number | null,
  decimals = 2,
  unit = ''
): string {
  if (min === null && max === null) return 'N/A';
  const fmt = (v: number) => v.toFixed(decimals);
  if (min !== null && max !== null) {
    return `${fmt(min)}–${fmt(max)}${unit}`;
  }
  if (min !== null) return `>= ${fmt(min)}${unit}`;
  return `<= ${fmt(max!)}${unit}`;
}

function isReadingInRange(
  raw: string,
  min: number | null,
  max: number | null
): boolean | null {
  const num = parseOptionalNumber(raw);
  if (num === null) return null;
  if (min !== null && num < min) return false;
  if (max !== null && num > max) return false;
  return true;
}

type TriplicateTuple = [string, string, string];
const EMPTY_TRIPLICATE: TriplicateTuple = ['', '', ''];

interface TriplicateEvaluation {
  parsedValues: (number | null)[];
  validNumbers: number[];
  capturedCount: number;
  isRequired: boolean;
  isActive: boolean;
  isComplete: boolean;
  isIncomplete: boolean;
  average: number | null;
  perReadingOk: (boolean | null)[];
  hasOutOfSpec: boolean;
  outOfSpecLabels: string[];
}

function evaluateTriplicateGroup(
  readings: TriplicateTuple,
  min: number | null,
  max: number | null,
  decimals: number
): TriplicateEvaluation {
  const parsedValues = readings.map((raw) => parseOptionalNumber(raw));
  const validNumbers = parsedValues
    .filter((v): v is number => v !== null)
    .map((v) => Number(v.toFixed(decimals)));
  const capturedCount = validNumbers.length;
  const isRequired = min !== null || max !== null;
  const isActive = isRequired || capturedCount > 0;
  const isComplete = capturedCount === 3;
  const isIncomplete = isActive && capturedCount < 3;
  const average =
    capturedCount > 0
      ? Number(
          (
            validNumbers.reduce((acc, v) => acc + v, 0) / capturedCount
          ).toFixed(decimals)
        )
      : null;
  const perReadingOk = parsedValues.map((num) => {
    if (num === null) return null;
    if (min !== null && num < min) return false;
    if (max !== null && num > max) return false;
    return true;
  });
  const outOfSpecLabels = perReadingOk
    .map((ok, idx) => (ok === false ? `R${idx + 1}` : null))
    .filter((label): label is string => label !== null);

  return {
    parsedValues,
    validNumbers,
    capturedCount,
    isRequired,
    isActive,
    isComplete,
    isIncomplete,
    average,
    perReadingOk,
    hasOutOfSpec: outOfSpecLabels.length > 0,
    outOfSpecLabels,
  };
}

interface EditableParamRow {
  id: string;
  name: string;
  unit: string;
  minTarget: string;
  maxTarget: string;
  targetNote: string;
}

interface AdhocReadingRow {
  paramId: string;
  name: string;
  unit: string;
  value: string;
  withinSpec: boolean;
}

export function BatchCheckView({
  specs,
  records,
  batches,
  productCategories = DEFAULT_CATEGORIES,
  categoryParameterPresets,
  operatorName,
  onNotify,
}: BatchCheckViewProps) {
  const availableCategories = useMemo(() => {
    const merged = new Set<string>(
      productCategories.length > 0 ? productCategories : DEFAULT_CATEGORIES
    );
    for (const key of Object.keys(categoryParameterPresets || {})) {
      if (key.trim()) merged.add(key.trim());
    }
    for (const s of specs) {
      if (s.productCategory) merged.add(s.productCategory);
    }
    return Array.from(merged);
  }, [productCategories, categoryParameterPresets, specs]);

  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('All');
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const [selectedSpecId, setSelectedSpecId] = useState<string>(specs[0]?.id || '');
  const [recordScope, setRecordScope] = useState<'selected' | 'all'>('selected');

  // Spec form state (pH, Aw, Brix are optional per category setup)
  const [showSpecForm, setShowSpecForm] = useState(false);
  const [editingSpecId, setEditingSpecId] = useState<string | null>(null);
  const [linkedBatchId, setLinkedBatchId] = useState('');
  const [specBatchNumber, setSpecBatchNumber] = useState('');
  const [specProductName, setSpecProductName] = useState('');
  const [specCategory, setSpecCategory] = useState<BatchCheckProductCategory>('Sauce');
  const [phEnabled, setPhEnabled] = useState(true);
  const [awEnabled, setAwEnabled] = useState(false);
  const [brixEnabled, setBrixEnabled] = useState(true);
  const [phMin, setPhMin] = useState('');
  const [phMax, setPhMax] = useState('');
  const [awMin, setAwMin] = useState('');
  const [awMax, setAwMax] = useState('');
  const [brixMin, setBrixMin] = useState('');
  const [brixMax, setBrixMax] = useState('');
  const [additionalParamRows, setAdditionalParamRows] = useState<EditableParamRow[]>([]);
  const [requirementNotes, setRequirementNotes] = useState('');
  const [savingSpec, setSavingSpec] = useState(false);
  const [confirmDeleteSpecId, setConfirmDeleteSpecId] = useState<string | null>(null);

  // Condition record form state
  const [showRecordForm, setShowRecordForm] = useState(false);
  const [showOptionalMetrics, setShowOptionalMetrics] = useState(false);
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [recordSpecId, setRecordSpecId] = useState<string>('');
  const [samplingStage, setSamplingStage] = useState('In-Process');
  const [phReadings, setPhReadings] = useState<TriplicateTuple>(EMPTY_TRIPLICATE);
  const [awReadings, setAwReadings] = useState<TriplicateTuple>(EMPTY_TRIPLICATE);
  const [brixReadings, setBrixReadings] =
    useState<TriplicateTuple>(EMPTY_TRIPLICATE);
  const [specParamValues, setSpecParamValues] = useState<Record<string, string>>({});
  const [adhocReadings, setAdhocReadings] = useState<AdhocReadingRow[]>([]);
  const [conditionStatusChoice, setConditionStatusChoice] = useState<
    BatchCheckConditionStatus | 'Auto'
  >('Auto');
  const [inspectorName, setInspectorName] = useState(operatorName);
  const [recordNotes, setRecordNotes] = useState('');
  const [recordFormError, setRecordFormError] = useState<string | null>(null);
  const [savingRecord, setSavingRecord] = useState(false);
  const [confirmDeleteRecordId, setConfirmDeleteRecordId] = useState<string | null>(null);

  const filteredSpecs = useMemo(() => {
    if (categoryFilter === 'All') return specs;
    return specs.filter((s) => s.productCategory === categoryFilter);
  }, [specs, categoryFilter]);

  useEffect(() => {
    if (filteredSpecs.length === 0) {
      if (selectedSpecId !== '') setSelectedSpecId('');
      return;
    }
    if (!filteredSpecs.some((s) => s.id === selectedSpecId)) {
      setSelectedSpecId(filteredSpecs[0].id);
    }
  }, [filteredSpecs, selectedSpecId]);

  const selectedSpec = useMemo(
    () => specs.find((s) => s.id === selectedSpecId) || filteredSpecs[0] || null,
    [specs, filteredSpecs, selectedSpecId]
  );

  const recordFormSpec = useMemo(
    () => specs.find((s) => s.id === recordSpecId) || selectedSpec || null,
    [specs, recordSpecId, selectedSpec]
  );

  const latestRecordBySpec = useMemo(() => {
    const map = new Map<string, BatchCheckRecord>();
    for (const rec of records) {
      if (!map.has(rec.specId)) {
        map.set(rec.specId, rec);
      }
    }
    return map;
  }, [records]);

  const visibleRecords = useMemo(() => {
    if (recordScope === 'selected' && selectedSpec) {
      return records.filter((r) => r.specId === selectedSpec.id);
    }
    if (categoryFilter !== 'All') {
      return records.filter((r) => r.productCategory === categoryFilter);
    }
    return records;
  }, [records, recordScope, selectedSpec, categoryFilter]);

  const alertRecordCount = useMemo(
    () => records.filter((r) => r.conditionStatus !== 'In Spec').length,
    [records]
  );

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { All: specs.length };
    for (const cat of availableCategories) {
      counts[cat] = specs.filter((s) => s.productCategory === cat).length;
    }
    return counts;
  }, [specs, availableCategories]);

  function applyCategoryDefaults(category: BatchCheckProductCategory) {
    const bomPresetParams = categoryParameterPresets?.[category];
    const preset = CATEGORY_PRESETS[category];

    if (bomPresetParams && bomPresetParams.length > 0) {
      const phParam = bomPresetParams.find(
        (p) => p.key.toLowerCase() === 'ph' || p.name.toLowerCase() === 'ph' || p.name.toLowerCase().includes('slurry ph')
      );
      const awParam = bomPresetParams.find(
        (p) =>
          p.key.toLowerCase() === 'aw' ||
          p.key.toLowerCase() === 'water_activity' ||
          p.name.toLowerCase().includes('water activity')
      );
      const brixParam = bomPresetParams.find(
        (p) => p.key.toLowerCase() === 'brix' || p.name.toLowerCase().includes('brix')
      );

      setPhEnabled(Boolean(phParam));
      setPhMin(phParam && phParam.min !== null ? String(phParam.min) : '');
      setPhMax(phParam && phParam.max !== null ? String(phParam.max) : '');

      setAwEnabled(Boolean(awParam));
      setAwMin(awParam && awParam.min !== null ? String(awParam.min) : '');
      setAwMax(awParam && awParam.max !== null ? String(awParam.max) : '');

      setBrixEnabled(Boolean(brixParam));
      setBrixMin(brixParam && brixParam.min !== null ? String(brixParam.min) : '');
      setBrixMax(brixParam && brixParam.max !== null ? String(brixParam.max) : '');

      const genericStep5Keys = new Set([
        'temperature',
        'ph',
        'aw',
        'water_activity',
        'brix',
        'weight',
        'time',
        'speed',
        'pressure',
      ]);
      const customCategoryParams: EditableParamRow[] = bomPresetParams
        .filter((p) => !genericStep5Keys.has(p.key.toLowerCase()))
        .map((p) => ({
          id: p.id,
          name: p.name,
          unit: p.unit,
          minTarget: p.min !== null ? String(p.min) : '',
          maxTarget: p.max !== null ? String(p.max) : '',
          targetNote: p.target !== null ? `Target: ${p.target} ${p.unit}`.trim() : '',
        }));

      const fallbackExtras: EditableParamRow[] = (preset?.additionalParams || [])
        .filter(
          (ep) =>
            !customCategoryParams.some(
              (cp) => cp.name.toLowerCase() === ep.name.toLowerCase()
            )
        )
        .map((p) => ({
          id: p.id,
          name: p.name,
          unit: p.unit,
          minTarget: p.minTarget !== null ? String(p.minTarget) : '',
          maxTarget: p.maxTarget !== null ? String(p.maxTarget) : '',
          targetNote: p.targetNote,
        }));

      setRequirementNotes(
        preset?.requirementNotes ||
          `Loaded ${category} parameter setup (${[
            phParam ? 'pH' : null,
            awParam ? 'Aw' : null,
            brixParam ? 'Brix' : null,
          ]
            .filter(Boolean)
            .join(', ') || 'custom parameters only'}).`
      );
      setAdditionalParamRows([...customCategoryParams, ...fallbackExtras]);
      return;
    }

    if (!preset) {
      setPhEnabled(false);
      setAwEnabled(false);
      setBrixEnabled(false);
      setPhMin('');
      setPhMax('');
      setAwMin('');
      setAwMax('');
      setBrixMin('');
      setBrixMax('');
      setRequirementNotes('');
      setAdditionalParamRows([]);
      onNotify(
        `No preset template for "${category}" — pH, Aw & Brix are off by default. Enable any checks needed or add custom parameters.`
      );
      return;
    }

    setPhEnabled(Boolean(preset.phMin || preset.phMax));
    setPhMin(preset.phMin);
    setPhMax(preset.phMax);
    setAwEnabled(Boolean(preset.awMin || preset.awMax));
    setAwMin(preset.awMin);
    setAwMax(preset.awMax);
    setBrixEnabled(Boolean(preset.brixMin || preset.brixMax));
    setBrixMin(preset.brixMin);
    setBrixMax(preset.brixMax);
    setRequirementNotes(preset.requirementNotes);
    setAdditionalParamRows(
      preset.additionalParams.map((p) => ({
        id: p.id,
        name: p.name,
        unit: p.unit,
        minTarget: p.minTarget !== null ? String(p.minTarget) : '',
        maxTarget: p.maxTarget !== null ? String(p.maxTarget) : '',
        targetNote: p.targetNote,
      }))
    );
  }

  function openNewSpecForm() {
    const initialCategory: BatchCheckProductCategory =
      categoryFilter === 'All' ? availableCategories[0] || 'Sauce' : categoryFilter;
    setEditingSpecId(null);
    setLinkedBatchId('');
    setSpecBatchNumber('');
    setSpecProductName('');
    setSpecCategory(initialCategory);
    applyCategoryDefaults(initialCategory);
    setShowSpecForm(true);
    setShowRecordForm(false);
  }

  function openEditSpecForm(spec: BatchCheckSpec) {
    setEditingSpecId(spec.id);
    setLinkedBatchId(spec.batchId || '');
    setSpecBatchNumber(spec.batchNumber);
    setSpecProductName(spec.productName);
    setSpecCategory(spec.productCategory);
    setPhEnabled(spec.phMin !== null || spec.phMax !== null);
    setAwEnabled(spec.awMin !== null || spec.awMax !== null);
    setBrixEnabled(spec.brixMin !== null || spec.brixMax !== null);
    setPhMin(spec.phMin !== null ? String(spec.phMin) : '');
    setPhMax(spec.phMax !== null ? String(spec.phMax) : '');
    setAwMin(spec.awMin !== null ? String(spec.awMin) : '');
    setAwMax(spec.awMax !== null ? String(spec.awMax) : '');
    setBrixMin(spec.brixMin !== null ? String(spec.brixMin) : '');
    setBrixMax(spec.brixMax !== null ? String(spec.brixMax) : '');
    setRequirementNotes(spec.requirementNotes || '');
    setAdditionalParamRows(
      (spec.additionalParams || []).map((p) => ({
        id: p.id,
        name: p.name,
        unit: p.unit,
        minTarget: p.minTarget !== null ? String(p.minTarget) : '',
        maxTarget: p.maxTarget !== null ? String(p.maxTarget) : '',
        targetNote: p.targetNote || '',
      }))
    );
    setShowSpecForm(true);
    setShowRecordForm(false);
  }

  function handleLinkedBatchSelect(batchId: string) {
    setLinkedBatchId(batchId);
    const found = batches.find((b) => b.id === batchId);
    if (found) {
      setSpecBatchNumber(found.batchNumber);
      setSpecProductName(found.productName);
    }
  }

  function addParamRow() {
    setAdditionalParamRows((prev) => [
      ...prev,
      {
        id: `prm-${Date.now().toString(36)}-${prev.length + 1}`,
        name: '',
        unit: '',
        minTarget: '',
        maxTarget: '',
        targetNote: '',
      },
    ]);
  }

  function updateParamRow(
    idx: number,
    field: keyof EditableParamRow,
    val: string
  ) {
    setAdditionalParamRows((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, [field]: val } : row))
    );
  }

  function removeParamRow(idx: number) {
    setAdditionalParamRows((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSaveSpec(e: React.FormEvent) {
    e.preventDefault();
    if (!specBatchNumber.trim() || !specProductName.trim()) {
      onNotify('Batch number and product name are required.');
      return;
    }

    setSavingSpec(true);
    try {
      const saved = await saveBatchCheckSpec({
        id: editingSpecId || undefined,
        batchId: linkedBatchId,
        batchNumber: specBatchNumber.trim(),
        productName: specProductName.trim(),
        productCategory: specCategory,
        phMin: phEnabled ? parseOptionalNumber(phMin) : null,
        phMax: phEnabled ? parseOptionalNumber(phMax) : null,
        awMin: awEnabled ? parseOptionalNumber(awMin) : null,
        awMax: awEnabled ? parseOptionalNumber(awMax) : null,
        brixMin: brixEnabled ? parseOptionalNumber(brixMin) : null,
        brixMax: brixEnabled ? parseOptionalNumber(brixMax) : null,
        additionalParams: additionalParamRows
          .filter((r) => r.name.trim().length > 0)
          .map((r) => ({
            id: r.id,
            name: r.name.trim(),
            unit: r.unit.trim(),
            minTarget: parseOptionalNumber(r.minTarget),
            maxTarget: parseOptionalNumber(r.maxTarget),
            targetNote: r.targetNote.trim(),
          })),
        requirementNotes: requirementNotes.trim(),
      });
      setSelectedSpecId(saved.id);
      setShowSpecForm(false);
      setEditingSpecId(null);
      onNotify(
        `Saved ${saved.productCategory} requirement for batch ${saved.batchNumber}.`
      );
    } catch (error) {
      onNotify(
        error instanceof Error
          ? error.message
          : 'Unable to save batch requirement.'
      );
    } finally {
      setSavingSpec(false);
    }
  }

  async function handleDeleteSpec(spec: BatchCheckSpec) {
    try {
      await deleteBatchCheckSpec(spec.id);
      setConfirmDeleteSpecId(null);
      onNotify(`Removed batch check requirement for ${spec.batchNumber}.`);
    } catch (error) {
      onNotify(
        error instanceof Error
          ? error.message
          : 'Unable to delete batch requirement.'
      );
    }
  }

  function openNewRecordForm(targetSpec?: BatchCheckSpec) {
    const spec = targetSpec || selectedSpec || specs[0];
    if (!spec) {
      onNotify('Create a batch requirement specification first.');
      return;
    }
    setEditingRecordId(null);
    setRecordSpecId(spec.id);
    setSamplingStage('In-Process');
    setPhReadings(['', '', '']);
    setAwReadings(['', '', '']);
    setBrixReadings(['', '', '']);
    setShowOptionalMetrics(false);
    setSpecParamValues({});
    setAdhocReadings([]);
    setConditionStatusChoice('Auto');
    setInspectorName(operatorName || 'QC Inspector');
    setRecordNotes('');
    setRecordFormError(null);
    setShowRecordForm(true);
    setShowSpecForm(false);
  }

  function openEditRecordForm(rec: BatchCheckRecord) {
    const spec = specs.find((s) => s.id === rec.specId) || selectedSpec || specs[0];
    setEditingRecordId(rec.id);
    setRecordSpecId(rec.specId);
    setSamplingStage(rec.samplingStage || 'In-Process');

    const toTuple = (
      arr: number[] | undefined,
      fallback: number | null,
      decimals: number
    ): TriplicateTuple => {
      if (arr && arr.length === 3) {
        return [
          arr[0].toFixed(decimals),
          arr[1].toFixed(decimals),
          arr[2].toFixed(decimals),
        ];
      }
      if (fallback !== null && fallback !== undefined) {
        return [fallback.toFixed(decimals), '', ''];
      }
      return ['', '', ''];
    };

    setPhReadings(toTuple(rec.phReadings, rec.measuredPh, 2));
    setAwReadings(toTuple(rec.awReadings, rec.measuredAw, 3));
    setBrixReadings(toTuple(rec.brixReadings, rec.measuredBrix, 1));
    setShowOptionalMetrics(false);

    const specParamIds = new Set((spec?.additionalParams || []).map((p) => p.id));
    const nextSpecVals: Record<string, string> = {};
    const nextAdhoc: AdhocReadingRow[] = [];
    for (const ar of rec.additionalReadings || []) {
      if (specParamIds.has(ar.paramId)) {
        nextSpecVals[ar.paramId] = ar.value;
      } else {
        nextAdhoc.push({
          paramId: ar.paramId,
          name: ar.name,
          unit: ar.unit,
          value: ar.value,
          withinSpec: ar.withinSpec,
        });
      }
    }
    setSpecParamValues(nextSpecVals);
    setAdhocReadings(nextAdhoc);
    setConditionStatusChoice(rec.conditionStatus || 'Auto');
    setInspectorName(rec.inspectorName || operatorName || 'QC Inspector');
    setRecordNotes(rec.notes || '');
    setRecordFormError(null);
    setShowRecordForm(true);
    setShowSpecForm(false);
  }

  function updateTriplicateSlot(
    setter: (fn: (prev: TriplicateTuple) => TriplicateTuple) => void,
    slotIdx: 0 | 1 | 2,
    value: string
  ) {
    setRecordFormError(null);
    setter((prev) => {
      const next: TriplicateTuple = [prev[0], prev[1], prev[2]];
      next[slotIdx] = value;
      return next;
    });
  }

  function addAdhocReading() {
    setAdhocReadings((prev) => [
      ...prev,
      {
        paramId: `extra-${Date.now().toString(36)}-${prev.length + 1}`,
        name: '',
        unit: '',
        value: '',
        withinSpec: true,
      },
    ]);
  }

  const phEval = evaluateTriplicateGroup(
    phReadings,
    recordFormSpec?.phMin ?? null,
    recordFormSpec?.phMax ?? null,
    2
  );
  const awEval = evaluateTriplicateGroup(
    awReadings,
    recordFormSpec?.awMin ?? null,
    recordFormSpec?.awMax ?? null,
    3
  );
  const brixEval = evaluateTriplicateGroup(
    brixReadings,
    recordFormSpec?.brixMin ?? null,
    recordFormSpec?.brixMax ?? null,
    1
  );

  const activeTriplicateGroups = [phEval, awEval, brixEval].filter(
    (g) => g.isActive
  );
  const completedTriplicateGroups = activeTriplicateGroups.filter(
    (g) => g.isComplete
  );
  const totalCapturedReadings =
    phEval.capturedCount + awEval.capturedCount + brixEval.capturedCount;
  const totalRequiredReadings = activeTriplicateGroups.length * 3;
  const triplicateReadinessPct =
    totalRequiredReadings > 0
      ? Math.min(100, Math.round((totalCapturedReadings / totalRequiredReadings) * 100))
      : 0;
  const allActiveGroupsComplete =
    activeTriplicateGroups.length > 0 &&
    activeTriplicateGroups.every((g) => g.isComplete);

  async function handleCreateRecord(e: React.FormEvent) {
    e.preventDefault();
    setRecordFormError(null);

    if (!recordFormSpec) {
      const msg = 'Select a batch requirement first.';
      setRecordFormError(msg);
      onNotify(msg);
      return;
    }
    if (!inspectorName.trim()) {
      const msg = 'Inspector name is required.';
      setRecordFormError(msg);
      onNotify(msg);
      return;
    }

    if (phEval.isIncomplete) {
      const msg = `Measured pH requires all 3 readings (R1, R2, R3) — currently ${phEval.capturedCount}/3 captured.`;
      setRecordFormError(msg);
      onNotify(msg);
      return;
    }
    if (awEval.isIncomplete) {
      const msg = `Measured Aw requires all 3 readings (R1, R2, R3) — currently ${awEval.capturedCount}/3 captured.`;
      setRecordFormError(msg);
      onNotify(msg);
      return;
    }
    if (brixEval.isIncomplete) {
      const msg = `Measured Brix requires all 3 readings (R1, R2, R3) — currently ${brixEval.capturedCount}/3 captured.`;
      setRecordFormError(msg);
      onNotify(msg);
      return;
    }

    const specReadings: BatchCheckAdditionalReading[] = (
      recordFormSpec.additionalParams || []
    )
      .map((param) => {
        const rawVal = (specParamValues[param.id] || '').trim();
        if (!rawVal) return null;
        const num = parseOptionalNumber(rawVal);
        const within = isReadingInRange(rawVal, param.minTarget, param.maxTarget);
        return {
          paramId: param.id,
          name: param.name,
          unit: param.unit,
          value: rawVal,
          numericValue: num,
          withinSpec: within ?? true,
        };
      })
      .filter((r): r is BatchCheckAdditionalReading => r !== null);

    const extraReadings: BatchCheckAdditionalReading[] = adhocReadings
      .filter((r) => r.name.trim().length > 0 && r.value.trim().length > 0)
      .map((r) => ({
        paramId: r.paramId,
        name: r.name.trim(),
        unit: r.unit.trim(),
        value: r.value.trim(),
        numericValue: parseOptionalNumber(r.value),
        withinSpec: r.withinSpec,
      }));

    const combinedReadings = [...specReadings, ...extraReadings];
    if (
      phEval.capturedCount === 0 &&
      awEval.capturedCount === 0 &&
      brixEval.capturedCount === 0 &&
      combinedReadings.length === 0
    ) {
      const msg =
        'Enter at least one configured category parameter reading before saving.';
      setRecordFormError(msg);
      onNotify(msg);
      return;
    }

    setSavingRecord(true);
    try {
      const payload = {
        specId: recordFormSpec.id,
        samplingStage,
        measuredPh: phEval.average,
        measuredAw: awEval.average,
        measuredBrix: brixEval.average,
        phReadings: phEval.validNumbers,
        awReadings: awEval.validNumbers,
        brixReadings: brixEval.validNumbers,
        additionalReadings: combinedReadings,
        conditionStatus: conditionStatusChoice,
        inspectorName: inspectorName.trim(),
        notes: recordNotes.trim(),
      };
      const saved = editingRecordId
        ? await updateBatchCheckRecord(editingRecordId, payload)
        : await createBatchCheckRecord(recordFormSpec.id, payload);
      setSelectedSpecId(recordFormSpec.id);
      setShowRecordForm(false);
      setEditingRecordId(null);
      setRecordFormError(null);
      onNotify(
        `${editingRecordId ? 'Updated' : 'Logged'} ${saved.samplingStage} check for ${saved.batchNumber} (${saved.conditionStatus}).`
      );
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : 'Unable to save condition record.';
      setRecordFormError(msg);
      onNotify(msg);
    } finally {
      setSavingRecord(false);
    }
  }

  async function handleDeleteRecord(recordId: string) {
    try {
      await deleteBatchCheckRecord(recordId);
      setConfirmDeleteRecordId(null);
      onNotify('Condition record removed.');
    } catch (error) {
      onNotify(
        error instanceof Error
          ? error.message
          : 'Unable to remove condition record.'
      );
    }
  }

  return (
    <div className="space-y-6">
      {/* Top Summary Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">
            Configured Batch Specs
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {specs.length}
            </span>
            <span className="text-xs text-slate-500">
              {availableCategories
                .slice(0, 3)
                .map((cat) => `${categoryCounts[cat] ?? 0} ${cat}`)
                .join(' · ')}
            </span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">
            Condition Checks Logged
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {records.length}
            </span>
            <span className="text-xs text-slate-500">
              Category-configured quality metrics
            </span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">
            Hold / Out-of-Spec Records
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span
              className={`font-mono text-2xl font-semibold tabular-nums ${
                alertRecordCount > 0 ? 'text-red-700' : 'text-emerald-700'
              }`}
            >
              {alertRecordCount}
            </span>
            <span
              className={`text-xs font-medium ${
                alertRecordCount > 0 ? 'text-red-700' : 'text-emerald-700'
              }`}
            >
              {alertRecordCount > 0
                ? 'Requires corrective review'
                : 'All checks within spec'}
            </span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-col justify-between">
          <div className="text-xs font-medium text-slate-500">
            Quick QC Actions
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={openNewSpecForm}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded transition-colors whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              New Batch Requirement
            </button>
            <button
              type="button"
              onClick={() => openNewRecordForm()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded transition-colors whitespace-nowrap"
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              Record Check
            </button>
          </div>
        </div>
      </section>

      {/* Category Tabs & Action Header */}
      <section className="bg-white border border-slate-200 rounded-lg px-5 py-3.5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {(['All', ...availableCategories] as CategoryFilter[]).map(
            (cat) => {
              const active = categoryFilter === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-teal-50 text-teal-800 border border-teal-200'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50 border border-transparent'
                  }`}
                >
                  {cat}{' '}
                  <span className="font-mono tabular-nums text-slate-500 ml-1">
                    {categoryCounts[cat] ?? 0}
                  </span>
                </button>
              );
            }
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openNewSpecForm}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Batch Requirement
          </button>
          <button
            type="button"
            onClick={() => openNewRecordForm()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
          >
            <Beaker className="w-3.5 h-3.5" />
            Record Condition Check
          </button>
        </div>
      </section>

      {/* Inline Batch Requirement Specification Editor */}
      {showSpecForm && (
        <section className="bg-white border border-teal-300 rounded-lg p-5 space-y-5">
          <div className="flex items-center justify-between gap-4 pb-3 border-b border-slate-100">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {editingSpecId
                  ? 'Edit Batch Quality Requirement'
                  : 'Define Batch Quality Requirement'}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Configure tolerances per category setup — pH, Water Activity (Aw), and Brix are optional and only checked when enabled for the category.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowSpecForm(false);
                setEditingSpecId(null);
              }}
              className="p-1.5 text-slate-400 hover:text-slate-700 rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <form onSubmit={(e) => void handleSaveSpec(e)} className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Link Existing Plant Batch (Optional)
                </label>
                <select
                  value={linkedBatchId}
                  onChange={(e) => handleLinkedBatchSelect(e.target.value)}
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs text-slate-800 bg-white focus:outline-none focus:border-teal-600"
                >
                  <option value="">Custom / Standalone Batch</option>
                  {batches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.batchNumber} — {b.productName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Batch Number *
                </label>
                <input
                  type="text"
                  value={specBatchNumber}
                  onChange={(e) => setSpecBatchNumber(e.target.value)}
                  placeholder="e.g. B-261118-PWD-02"
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:border-teal-600"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Product Name *
                </label>
                <input
                  type="text"
                  value={specProductName}
                  onChange={(e) => setSpecProductName(e.target.value)}
                  placeholder="e.g. Smoked Chili BBQ Sauce"
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-teal-600"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Product Category *
                </label>
                <div className="flex items-center gap-2">
                  <select
                    value={specCategory}
                    onChange={(e) => {
                      const nextCat = e.target.value as BatchCheckProductCategory;
                      setSpecCategory(nextCat);
                      if (!editingSpecId) {
                        applyCategoryDefaults(nextCat);
                      }
                    }}
                    className="flex-1 border border-slate-200 rounded px-3 py-2 text-xs text-slate-800 bg-white focus:outline-none focus:border-teal-600"
                  >
                    {availableCategories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => applyCategoryDefaults(specCategory)}
                    className="px-2.5 py-2 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded whitespace-nowrap"
                  >
                    Load {specCategory} Setup
                  </button>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <input
                    type="text"
                    value={newCategoryInput}
                    onChange={(e) => setNewCategoryInput(e.target.value)}
                    placeholder="New category..."
                    className="flex-1 border border-slate-200 rounded px-2 py-1 text-[11px] bg-white"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const val = newCategoryInput.trim();
                      if (!val) return;
                      const next = Array.from(
                        new Set([...availableCategories, val])
                      );
                      await updatePlantOptions({ productCategories: next });
                      setSpecCategory(val);
                      applyCategoryDefaults(val);
                      setNewCategoryInput('');
                      onNotify(`Added product category "${val}".`);
                    }}
                    className="px-2 py-1 text-[11px] font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded whitespace-nowrap"
                  >
                    + Add Category
                  </button>
                </div>
              </div>
            </div>

            {/* Optional Core pH / Aw / Brix Checks Controlled Per Category Setup */}
            <div className="bg-[#F7F8FA] border border-slate-200 rounded-md p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-slate-800">
                  Optional Core Checks for {specCategory} Category
                </span>
                <span className="text-[11px] text-slate-500">
                  pH, Water Activity (Aw), and Brix are NOT compulsory — tick only what applies to this category setup.
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div
                  className={`border rounded p-3 transition-colors ${
                    phEnabled ? 'bg-white border-teal-200' : 'bg-slate-100/70 border-slate-200'
                  }`}
                >
                  <label className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-800 mb-2 cursor-pointer">
                    <span className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={phEnabled}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setPhEnabled(checked);
                          if (!checked) {
                            setPhMin('');
                            setPhMax('');
                          }
                        }}
                        className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                      />
                      <span>Include pH Check</span>
                    </span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                        phEnabled
                          ? 'bg-teal-50 text-teal-800'
                          : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {phEnabled ? 'REQUIRED' : 'NOT USED'}
                    </span>
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        Min pH
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        disabled={!phEnabled}
                        value={phMin}
                        onChange={(e) => setPhMin(e.target.value)}
                        placeholder={phEnabled ? '3.90' : 'Optional / Off'}
                        className="w-full border border-slate-200 bg-white disabled:bg-slate-100 disabled:text-slate-400 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        Max pH
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        disabled={!phEnabled}
                        value={phMax}
                        onChange={(e) => setPhMax(e.target.value)}
                        placeholder={phEnabled ? '4.30' : 'Optional / Off'}
                        className="w-full border border-slate-200 bg-white disabled:bg-slate-100 disabled:text-slate-400 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                      />
                    </div>
                  </div>
                </div>

                <div
                  className={`border rounded p-3 transition-colors ${
                    awEnabled ? 'bg-white border-teal-200' : 'bg-slate-100/70 border-slate-200'
                  }`}
                >
                  <label className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-800 mb-2 cursor-pointer">
                    <span className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={awEnabled}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setAwEnabled(checked);
                          if (!checked) {
                            setAwMin('');
                            setAwMax('');
                          }
                        }}
                        className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                      />
                      <span>Include Water Activity (Aw)</span>
                    </span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                        awEnabled
                          ? 'bg-teal-50 text-teal-800'
                          : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {awEnabled ? 'REQUIRED' : 'NOT USED'}
                    </span>
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        Min Aw
                      </label>
                      <input
                        type="number"
                        step="0.005"
                        min="0"
                        max="1"
                        disabled={!awEnabled}
                        value={awMin}
                        onChange={(e) => setAwMin(e.target.value)}
                        placeholder={awEnabled ? '0.150' : 'Optional / Off'}
                        className="w-full border border-slate-200 bg-white disabled:bg-slate-100 disabled:text-slate-400 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        Max Aw
                      </label>
                      <input
                        type="number"
                        step="0.005"
                        min="0"
                        max="1"
                        disabled={!awEnabled}
                        value={awMax}
                        onChange={(e) => setAwMax(e.target.value)}
                        placeholder={awEnabled ? '0.420' : 'Optional / Off'}
                        className="w-full border border-slate-200 bg-white disabled:bg-slate-100 disabled:text-slate-400 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                      />
                    </div>
                  </div>
                </div>

                <div
                  className={`border rounded p-3 transition-colors ${
                    brixEnabled ? 'bg-white border-teal-200' : 'bg-slate-100/70 border-slate-200'
                  }`}
                >
                  <label className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-800 mb-2 cursor-pointer">
                    <span className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={brixEnabled}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setBrixEnabled(checked);
                          if (!checked) {
                            setBrixMin('');
                            setBrixMax('');
                          }
                        }}
                        className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                      />
                      <span>Include Brix (°Bx)</span>
                    </span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                        brixEnabled
                          ? 'bg-teal-50 text-teal-800'
                          : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {brixEnabled ? 'REQUIRED' : 'NOT USED'}
                    </span>
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        Min Brix
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        disabled={!brixEnabled}
                        value={brixMin}
                        onChange={(e) => setBrixMin(e.target.value)}
                        placeholder={brixEnabled ? '8.5' : 'Optional / Off'}
                        className="w-full border border-slate-200 bg-white disabled:bg-slate-100 disabled:text-slate-400 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        Max Brix
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        disabled={!brixEnabled}
                        value={brixMax}
                        onChange={(e) => setBrixMax(e.target.value)}
                        placeholder={brixEnabled ? '11.0' : 'Optional / Off'}
                        className="w-full border border-slate-200 bg-white disabled:bg-slate-100 disabled:text-slate-400 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Dynamic Additional Parameters Builder */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-slate-800">
                    Additional Required Parameters
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Add category-specific checks (e.g., Viscosity, Moisture %, Specific Gravity, Sieve Mesh, Hot-Fill Temp)
                  </p>
                </div>
                <button
                  type="button"
                  onClick={addParamRow}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Parameter
                </button>
              </div>

              {additionalParamRows.length === 0 ? (
                <div className="text-xs text-slate-500 py-3 px-4 border border-dashed border-slate-200 rounded">
                  No additional parameters configured. Click &ldquo;Add Parameter&rdquo; if this batch requires extra checks beyond pH, Aw, and Brix.
                </div>
              ) : (
                <div className="space-y-2">
                  {additionalParamRows.map((row, idx) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center bg-[#F7F8FA] border border-slate-200 rounded p-2.5"
                    >
                      <div className="md:col-span-3">
                        <input
                          type="text"
                          value={row.name}
                          onChange={(e) =>
                            updateParamRow(idx, 'name', e.target.value)
                          }
                          placeholder="Parameter name (e.g. Viscosity)"
                          className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <input
                          type="text"
                          value={row.unit}
                          onChange={(e) =>
                            updateParamRow(idx, 'unit', e.target.value)
                          }
                          placeholder="Unit (cP, %, °C)"
                          className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <input
                          type="number"
                          step="any"
                          value={row.minTarget}
                          onChange={(e) =>
                            updateParamRow(idx, 'minTarget', e.target.value)
                          }
                          placeholder="Min target"
                          className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <input
                          type="number"
                          step="any"
                          value={row.maxTarget}
                          onChange={(e) =>
                            updateParamRow(idx, 'maxTarget', e.target.value)
                          }
                          placeholder="Max target"
                          className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <input
                          type="text"
                          value={row.targetNote}
                          onChange={(e) =>
                            updateParamRow(idx, 'targetNote', e.target.value)
                          }
                          placeholder="Method / note"
                          className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs"
                        />
                      </div>
                      <div className="md:col-span-1 flex justify-end">
                        <button
                          type="button"
                          onClick={() => removeParamRow(idx)}
                          title="Remove parameter"
                          className="p-1.5 text-slate-400 hover:text-red-700 rounded"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Requirement Notes / Sampling Instructions
              </label>
              <input
                type="text"
                value={requirementNotes}
                onChange={(e) => setRequirementNotes(e.target.value)}
                placeholder="e.g. Pull composite sample after 15-minute hold..."
                className="w-full border border-slate-200 rounded px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-teal-600"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setShowSpecForm(false);
                  setEditingSpecId(null);
                }}
                className="px-3.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingSpec}
                className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded-md"
              >
                {savingSpec
                  ? 'Saving Requirement...'
                  : editingSpecId
                    ? 'Update Requirement'
                    : 'Save Batch Requirement'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Inline Condition Record Entry Form */}
      {showRecordForm && recordFormSpec && (
        <section className="bg-white border border-teal-300 rounded-lg p-5 space-y-5">
          <div className="flex items-center justify-between gap-4 pb-3 border-b border-slate-100">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {editingRecordId
                  ? 'Edit Batch Condition Check'
                  : 'Record Batch Condition Check'}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Record metrics enabled for {recordFormSpec.productCategory} category setup and any additional parameters
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowRecordForm(false);
                setEditingRecordId(null);
              }}
              className="p-1.5 text-slate-400 hover:text-slate-700 rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <form onSubmit={(e) => void handleCreateRecord(e)} className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Target Batch Requirement *
                </label>
                <select
                  value={recordFormSpec.id}
                  onChange={(e) => {
                    setRecordSpecId(e.target.value);
                    setPhReadings(['', '', '']);
                    setAwReadings(['', '', '']);
                    setBrixReadings(['', '', '']);
                    setSpecParamValues({});
                    setRecordFormError(null);
                  }}
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs text-slate-800 bg-white focus:outline-none focus:border-teal-600"
                >
                  {specs.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.batchNumber} ({s.productCategory}) — {s.productName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Sampling Stage
                </label>
                <select
                  value={samplingStage}
                  onChange={(e) => setSamplingStage(e.target.value)}
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs text-slate-800 bg-white focus:outline-none focus:border-teal-600"
                >
                  {SAMPLING_STAGES.map((stage) => (
                    <option key={stage} value={stage}>
                      {stage}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Inspector Name *
                </label>
                <input
                  type="text"
                  value={inspectorName}
                  onChange={(e) => {
                    setRecordFormError(null);
                    setInspectorName(e.target.value);
                  }}
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-teal-600"
                  required
                />
              </div>
            </div>

            {/* Category-Configured Triplicate Metrics (pH, Aw, Brix shown only when enabled for category or optionally expanded) */}
            {(() => {
              const allMetrics = [
                {
                  key: 'ph',
                  label: 'Measured pH',
                  shortName: 'pH',
                  configured:
                    recordFormSpec.phMin !== null || recordFormSpec.phMax !== null,
                  specText: formatRange(recordFormSpec.phMin, recordFormSpec.phMax, 2),
                  evalData: phEval,
                  readings: phReadings,
                  setter: setPhReadings,
                  step: '0.01',
                  minAttr: undefined,
                  maxAttr: undefined,
                  decimals: 2,
                  unitSuffix: '',
                  placeholders: ['4.10', '4.12', '4.15'],
                },
                {
                  key: 'aw',
                  label: 'Measured Aw (Water Activity)',
                  shortName: 'Aw',
                  configured:
                    recordFormSpec.awMin !== null || recordFormSpec.awMax !== null,
                  specText: formatRange(recordFormSpec.awMin, recordFormSpec.awMax, 3),
                  evalData: awEval,
                  readings: awReadings,
                  setter: setAwReadings,
                  step: '0.001',
                  minAttr: '0',
                  maxAttr: '1',
                  decimals: 3,
                  unitSuffix: '',
                  placeholders: ['0.310', '0.320', '0.315'],
                },
                {
                  key: 'brix',
                  label: 'Measured Brix (°Bx)',
                  shortName: 'Brix',
                  configured:
                    recordFormSpec.brixMin !== null || recordFormSpec.brixMax !== null,
                  specText: formatRange(
                    recordFormSpec.brixMin,
                    recordFormSpec.brixMax,
                    1,
                    '°Bx'
                  ),
                  evalData: brixEval,
                  readings: brixReadings,
                  setter: setBrixReadings,
                  step: '0.1',
                  minAttr: undefined,
                  maxAttr: undefined,
                  decimals: 1,
                  unitSuffix: '°',
                  placeholders: ['9.4', '9.6', '9.5'],
                },
              ] as const;

              const visibleMetrics = allMetrics.filter(
                (m) => m.configured || showOptionalMetrics || m.evalData.capturedCount > 0
              );
              const hiddenMetricNames = allMetrics
                .filter((m) => !m.configured)
                .map((m) => m.shortName);

              return (
                <div className="bg-[#F7F8FA] border border-slate-200 rounded-md p-4 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200">
                    <div>
                      <div className="text-xs font-semibold text-slate-900">
                        {visibleMetrics.length > 0
                          ? `Category Triplicate Checks (${recordFormSpec.productCategory})`
                          : `${recordFormSpec.productCategory} Category — Optional Core Metrics Disabled`}
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        {visibleMetrics.length > 0
                          ? 'Only parameters enabled in this category setup require triplicate readings (R1, R2, R3).'
                          : `pH, Aw, and Brix are not required for this ${recordFormSpec.productCategory} setup — enter the configured category parameters below.`}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {hiddenMetricNames.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowOptionalMetrics((v) => !v)}
                          className="px-2.5 py-1 text-[11px] font-medium text-teal-800 bg-white border border-teal-200 hover:bg-teal-50 rounded whitespace-nowrap"
                        >
                          {showOptionalMetrics
                            ? `Hide Optional (${hiddenMetricNames.join('/')})`
                            : `+ Record Optional (${hiddenMetricNames.join('/')})`}
                        </button>
                      )}
                      {activeTriplicateGroups.length > 0 && (
                        <div className="min-w-[200px] space-y-1">
                          <div className="flex items-center justify-between text-[11px] font-mono tabular-nums">
                            <span className="text-slate-600">
                              {completedTriplicateGroups.length}/{activeTriplicateGroups.length}{' '}
                              params ready
                            </span>
                            <span
                              className={`font-semibold ${
                                allActiveGroupsComplete
                                  ? 'text-emerald-700'
                                  : 'text-amber-700'
                              }`}
                            >
                              {totalCapturedReadings}/{totalRequiredReadings} readings
                            </span>
                          </div>
                          <div className="h-1.5 w-full bg-slate-200 rounded-xs overflow-hidden">
                            <div
                              className={`h-full transition-all duration-200 ${
                                allActiveGroupsComplete
                                  ? 'bg-emerald-600'
                                  : 'bg-amber-500'
                              }`}
                              style={{ width: `${triplicateReadinessPct}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {visibleMetrics.length > 0 && (
                    <div
                      className={`grid grid-cols-1 gap-4 ${
                        visibleMetrics.length === 1
                          ? 'lg:grid-cols-1'
                          : visibleMetrics.length === 2
                            ? 'lg:grid-cols-2'
                            : 'lg:grid-cols-3'
                      }`}
                    >
                      {visibleMetrics.map((metric) => {
                        const { evalData } = metric;
                        const cardTone = evalData.hasOutOfSpec
                          ? 'border-red-300 bg-red-50/20'
                          : evalData.isComplete
                            ? 'border-emerald-300 bg-emerald-50/20'
                            : evalData.isActive
                              ? 'border-amber-300 bg-amber-50/20'
                              : 'border-slate-200 bg-white';

                        const counterTone = evalData.hasOutOfSpec
                          ? 'text-red-700'
                          : evalData.isComplete
                            ? 'text-emerald-700'
                            : evalData.isActive
                              ? 'text-amber-700'
                              : 'text-slate-500';

                        const counterLabel = evalData.isComplete
                          ? `3/3 · Avg ${evalData.average!.toFixed(metric.decimals)}${metric.unitSuffix}`
                          : evalData.isActive
                            ? `${evalData.capturedCount}/3 captured`
                            : 'Optional · 0/3';

                        return (
                          <div
                            key={metric.key}
                            className={`border rounded-md p-3.5 transition-colors ${cardTone}`}
                          >
                            <div className="flex items-start justify-between gap-2 text-xs">
                              <div>
                                <div className="font-semibold text-slate-900">
                                  {metric.label}
                                </div>
                                <div className="font-mono text-[11px] text-slate-500 mt-0.5">
                                  {metric.configured
                                    ? `Spec: ${metric.specText}`
                                    : 'Optional (Not required by category)'}
                                </div>
                              </div>
                              <span
                                className={`font-mono text-[11px] font-semibold tabular-nums whitespace-nowrap ${counterTone}`}
                              >
                                {counterLabel}
                              </span>
                            </div>

                            <div
                              className="grid grid-cols-3 gap-1 my-2.5"
                              aria-label={`${metric.label} reading progress: ${evalData.capturedCount} of 3`}
                            >
                              {([0, 1, 2] as const).map((idx) => {
                                const ok = evalData.perReadingOk[idx];
                                const barClass =
                                  ok === false
                                    ? 'bg-red-600'
                                    : ok === true
                                      ? 'bg-emerald-600'
                                      : evalData.isActive
                                        ? 'bg-amber-300'
                                        : 'bg-slate-200';
                                return (
                                  <div
                                    key={idx}
                                    className={`h-1.5 rounded-xs transition-colors ${barClass}`}
                                  />
                                );
                              })}
                            </div>

                            <div className="grid grid-cols-3 gap-2">
                              {([0, 1, 2] as const).map((slotIdx) => {
                                const ok = evalData.perReadingOk[slotIdx];
                                const slotLabelColor =
                                  ok === false
                                    ? 'text-red-700'
                                    : ok === true
                                      ? 'text-emerald-700'
                                      : evalData.isActive
                                        ? 'text-amber-700'
                                        : 'text-slate-500';
                                const inputClass =
                                  ok === false
                                    ? 'border-red-500 bg-red-50/70 text-red-800 focus:border-red-600'
                                    : ok === true
                                      ? 'border-emerald-500 bg-emerald-50/40 text-slate-900 focus:border-emerald-600'
                                      : evalData.isActive
                                        ? 'border-amber-300 bg-white text-slate-900 focus:border-teal-600'
                                        : 'border-slate-200 bg-white text-slate-900 focus:border-teal-600';

                                return (
                                  <div key={slotIdx}>
                                    <label
                                      className={`flex items-center justify-between text-[10px] font-mono font-semibold mb-1 ${slotLabelColor}`}
                                    >
                                      <span>R{slotIdx + 1}</span>
                                      <span>
                                        {ok === false
                                          ? 'Out'
                                          : ok === true
                                            ? 'OK'
                                            : evalData.isActive
                                              ? 'Req'
                                              : '—'}
                                      </span>
                                    </label>
                                    <input
                                      type="number"
                                      step={metric.step}
                                      min={metric.minAttr}
                                      max={metric.maxAttr}
                                      value={metric.readings[slotIdx]}
                                      onChange={(e) =>
                                        updateTriplicateSlot(
                                          metric.setter,
                                          slotIdx,
                                          e.target.value
                                        )
                                      }
                                      placeholder={
                                        !evalData.isRequired && !evalData.isActive
                                          ? 'Optional'
                                          : metric.placeholders[slotIdx]
                                      }
                                      aria-label={`${metric.label} Reading ${slotIdx + 1}`}
                                      className={`w-full border rounded px-2 py-1.5 text-xs font-mono tabular-nums focus:outline-none transition-colors ${inputClass}`}
                                    />
                                  </div>
                                );
                              })}
                            </div>

                            <p className={`mt-2 text-[11px] font-medium ${counterTone}`}>
                              {evalData.hasOutOfSpec
                                ? `${evalData.outOfSpecLabels.join(', ')} outside target tolerance (${evalData.capturedCount}/3 captured)`
                                : evalData.isComplete
                                  ? 'All 3 readings verified within target tolerance'
                                  : evalData.isActive
                                    ? `${evalData.capturedCount} of 3 readings captured — ${3 - evalData.capturedCount} more required`
                                    : 'Optional for this category — enter all 3 readings if measured'}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Spec Additional Parameters */}
            {(recordFormSpec.additionalParams || []).length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-800">
                  Configured Additional Parameters for {recordFormSpec.batchNumber}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {recordFormSpec.additionalParams.map((param) => {
                    const currentVal = specParamValues[param.id] || '';
                    const inBounds = isReadingInRange(
                      currentVal,
                      param.minTarget,
                      param.maxTarget
                    );
                    return (
                      <div
                        key={param.id}
                        className="border border-slate-200 rounded p-3 bg-[#F7F8FA]"
                      >
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="font-medium text-slate-900">
                            {param.name}
                            {param.unit ? ` (${param.unit})` : ''}
                          </span>
                          <span className="font-mono text-[11px] text-slate-500">
                            Target:{' '}
                            {formatRange(
                              param.minTarget,
                              param.maxTarget,
                              2,
                              param.unit ? ` ${param.unit}` : ''
                            )}
                          </span>
                        </div>
                        <input
                          type="text"
                          value={currentVal}
                          onChange={(e) =>
                            setSpecParamValues((prev) => ({
                              ...prev,
                              [param.id]: e.target.value,
                            }))
                          }
                          placeholder={param.targetNote || `Enter ${param.name}`}
                          className={`w-full border rounded px-2.5 py-1.5 text-xs font-mono bg-white focus:outline-none ${
                            inBounds === false
                              ? 'border-red-400 text-red-700'
                              : 'border-slate-200 text-slate-900 focus:border-teal-600'
                          }`}
                        />
                        {inBounds === false && (
                          <p className="mt-1 text-[11px] text-red-700 font-medium">
                            Reading exceeds parameter tolerance
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Ad-Hoc Extra Parameter Readings */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800">
                  Extra Ad-Hoc Parameter Readings (Optional)
                </span>
                <button
                  type="button"
                  onClick={addAdhocReading}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Extra Parameter Reading
                </button>
              </div>
              {adhocReadings.map((row, idx) => (
                <div
                  key={row.paramId}
                  className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center bg-[#F7F8FA] border border-slate-200 rounded p-2.5"
                >
                  <div className="md:col-span-4">
                    <input
                      type="text"
                      value={row.name}
                      onChange={(e) =>
                        setAdhocReadings((prev) =>
                          prev.map((r, i) =>
                            i === idx ? { ...r, name: e.target.value } : r
                          )
                        )
                      }
                      placeholder="Parameter (e.g. Color L* or Salt %)"
                      className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <div className="md:col-span-3">
                    <input
                      type="text"
                      value={row.value}
                      onChange={(e) =>
                        setAdhocReadings((prev) =>
                          prev.map((r, i) =>
                            i === idx ? { ...r, value: e.target.value } : r
                          )
                        )
                      }
                      placeholder="Measured value"
                      className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <input
                      type="text"
                      value={row.unit}
                      onChange={(e) =>
                        setAdhocReadings((prev) =>
                          prev.map((r, i) =>
                            i === idx ? { ...r, unit: e.target.value } : r
                          )
                        )
                      }
                      placeholder="Unit"
                      className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <select
                      value={row.withinSpec ? 'ok' : 'fail'}
                      onChange={(e) =>
                        setAdhocReadings((prev) =>
                          prev.map((r, i) =>
                            i === idx
                              ? { ...r, withinSpec: e.target.value === 'ok' }
                              : r
                          )
                        )
                      }
                      className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 text-xs"
                    >
                      <option value="ok">In Spec</option>
                      <option value="fail">Out of Spec</option>
                    </select>
                  </div>
                  <div className="md:col-span-1 flex justify-end">
                    <button
                      type="button"
                      onClick={() =>
                        setAdhocReadings((prev) =>
                          prev.filter((_, i) => i !== idx)
                        )
                      }
                      className="p-1.5 text-slate-400 hover:text-red-700 rounded"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Condition Evaluation
                </label>
                <select
                  value={conditionStatusChoice}
                  onChange={(e) =>
                    setConditionStatusChoice(
                      e.target.value as BatchCheckConditionStatus | 'Auto'
                    )
                  }
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs text-slate-800 bg-white focus:outline-none focus:border-teal-600"
                >
                  <option value="Auto">
                    Auto-Evaluate Against Batch Spec
                  </option>
                  <option value="In Spec">In Spec</option>
                  <option value="Marginal">Marginal (Monitor)</option>
                  <option value="Out of Spec">Out of Spec (Hold)</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Condition Notes / Corrective Action
                </label>
                <input
                  type="text"
                  value={recordNotes}
                  onChange={(e) => setRecordNotes(e.target.value)}
                  placeholder="Observations, sensory check, or adjustment notes..."
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-teal-600"
                />
              </div>
            </div>

            {recordFormError && (
              <div className="flex items-center gap-2 border border-red-300 bg-red-50/70 text-red-800 rounded px-3 py-2 text-xs font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0 text-red-700" />
                <span>{recordFormError}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setShowRecordForm(false);
                  setEditingRecordId(null);
                }}
                className="px-3.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingRecord}
                className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded-md"
              >
                {savingRecord
                  ? 'Saving Record...'
                  : editingRecordId
                    ? 'Update Condition Record'
                    : 'Save Condition Record'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Batch Requirements Cards + Selected Requirement Detail */}
      <section className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Configured Batch Requirements List */}
        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Batch Requirements ({filteredSpecs.length})
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Select a batch to inspect specifications or log condition readings
              </p>
            </div>
          </div>

          {filteredSpecs.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm font-medium text-slate-800">
                No {categoryFilter === 'All' ? '' : categoryFilter} batch requirements configured
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Create a batch requirement to define pH, Aw, Brix, and custom QC limits.
              </p>
              <button
                type="button"
                onClick={openNewSpecForm}
                className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Batch Requirement
              </button>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filteredSpecs.map((spec) => {
                const isSelected = selectedSpec?.id === spec.id;
                const latest = latestRecordBySpec.get(spec.id);
                const specRecordCount = records.filter(
                  (r) => r.specId === spec.id
                ).length;

                return (
                  <div
                    key={spec.id}
                    className={`p-4 transition-colors ${
                      isSelected ? 'bg-teal-50/50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => setSelectedSpecId(spec.id)}
                        className="text-left min-w-0 flex-1"
                      >
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-mono font-semibold text-slate-900">
                            {spec.batchNumber}
                          </span>
                          <span className="text-slate-300">/</span>
                          <span className="font-medium text-teal-800">
                            {spec.productCategory}
                          </span>
                        </div>
                        <div className="mt-0.5 text-sm font-semibold text-slate-900 truncate">
                          {spec.productName}
                        </div>
                      </button>

                      <div className="text-right shrink-0">
                        {latest ? (
                          <span
                            className={`text-xs font-semibold ${
                              latest.conditionStatus === 'In Spec'
                                ? 'text-emerald-700'
                                : latest.conditionStatus === 'Marginal'
                                  ? 'text-amber-700'
                                  : 'text-red-700'
                            }`}
                          >
                            {latest.conditionStatus}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">
                            No checks yet
                          </span>
                        )}
                        <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                          {specRecordCount} check{specRecordCount === 1 ? '' : 's'}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-2 text-xs font-mono tabular-nums bg-[#F7F8FA] border border-slate-200 rounded p-2">
                      <div>
                        <span className="text-[10px] font-sans text-slate-500 block">
                          pH
                        </span>
                        <span
                          className={
                            spec.phMin === null && spec.phMax === null
                              ? 'text-slate-400 font-sans text-[11px]'
                              : 'text-slate-900'
                          }
                        >
                          {spec.phMin === null && spec.phMax === null
                            ? 'Not req'
                            : formatRange(spec.phMin, spec.phMax, 2)}
                        </span>
                      </div>
                      <div>
                        <span className="text-[10px] font-sans text-slate-500 block">
                          Aw
                        </span>
                        <span
                          className={
                            spec.awMin === null && spec.awMax === null
                              ? 'text-slate-400 font-sans text-[11px]'
                              : 'text-slate-900'
                          }
                        >
                          {spec.awMin === null && spec.awMax === null
                            ? 'Not req'
                            : formatRange(spec.awMin, spec.awMax, 3)}
                        </span>
                      </div>
                      <div>
                        <span className="text-[10px] font-sans text-slate-500 block">
                          Brix
                        </span>
                        <span
                          className={
                            spec.brixMin === null && spec.brixMax === null
                              ? 'text-slate-400 font-sans text-[11px]'
                              : 'text-slate-900'
                          }
                        >
                          {spec.brixMin === null && spec.brixMax === null
                            ? 'Not req'
                            : formatRange(spec.brixMin, spec.brixMax, 1, '°')}
                        </span>
                      </div>
                    </div>

                    <div className="mt-2.5 flex items-center justify-between gap-2 text-xs">
                      <span className="text-slate-500">
                        {(spec.additionalParams || []).length} additional param
                        {(spec.additionalParams || []).length === 1 ? '' : 's'}
                      </span>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => openNewRecordForm(spec)}
                          className="font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
                        >
                          + Log check
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditSpecForm(spec)}
                          className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900"
                        >
                          <Edit3 className="w-3 h-3" />
                          Edit
                        </button>
                        {confirmDeleteSpecId === spec.id ? (
                          <span className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => void handleDeleteSpec(spec)}
                              className="font-medium text-red-700 hover:text-red-800"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteSpecId(null)}
                              className="text-slate-500 hover:text-slate-800"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteSpecId(spec.id)}
                            className="text-slate-400 hover:text-red-700"
                            title="Delete requirement"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Selected Spec Target Card + Condition Records Table */}
        <div className="xl:col-span-7 space-y-6">
          {selectedSpec && (
            <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-4 pb-3 border-b border-slate-100">
                <div>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono font-semibold text-slate-900">
                      {selectedSpec.batchNumber}
                    </span>
                    <span>·</span>
                    <span className="font-semibold text-teal-800">
                      {selectedSpec.productCategory}
                    </span>
                  </div>
                  <h3 className="text-base font-semibold text-slate-900 mt-0.5">
                    {selectedSpec.productName}
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openEditSpecForm(selectedSpec)}
                    className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                  >
                    Edit Spec
                  </button>
                  <button
                    type="button"
                    onClick={() => openNewRecordForm(selectedSpec)}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                  >
                    Record Check
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-[#F7F8FA] border border-slate-200 rounded p-3">
                  <div className="text-[11px] font-medium text-slate-500">
                    pH Target Window
                  </div>
                  <div
                    className={`mt-1 text-sm font-semibold tabular-nums ${
                      selectedSpec.phMin === null && selectedSpec.phMax === null
                        ? 'text-slate-400 text-xs font-normal'
                        : 'font-mono text-slate-900'
                    }`}
                  >
                    {selectedSpec.phMin === null && selectedSpec.phMax === null
                      ? 'Not required for category'
                      : formatRange(selectedSpec.phMin, selectedSpec.phMax, 2)}
                  </div>
                </div>
                <div className="bg-[#F7F8FA] border border-slate-200 rounded p-3">
                  <div className="text-[11px] font-medium text-slate-500">
                    Water Activity (Aw)
                  </div>
                  <div
                    className={`mt-1 text-sm font-semibold tabular-nums ${
                      selectedSpec.awMin === null && selectedSpec.awMax === null
                        ? 'text-slate-400 text-xs font-normal'
                        : 'font-mono text-slate-900'
                    }`}
                  >
                    {selectedSpec.awMin === null && selectedSpec.awMax === null
                      ? 'Not required for category'
                      : formatRange(selectedSpec.awMin, selectedSpec.awMax, 3)}
                  </div>
                </div>
                <div className="bg-[#F7F8FA] border border-slate-200 rounded p-3">
                  <div className="text-[11px] font-medium text-slate-500">
                    Soluble Solids (Brix)
                  </div>
                  <div
                    className={`mt-1 text-sm font-semibold tabular-nums ${
                      selectedSpec.brixMin === null && selectedSpec.brixMax === null
                        ? 'text-slate-400 text-xs font-normal'
                        : 'font-mono text-slate-900'
                    }`}
                  >
                    {selectedSpec.brixMin === null && selectedSpec.brixMax === null
                      ? 'Not required for category'
                      : formatRange(
                          selectedSpec.brixMin,
                          selectedSpec.brixMax,
                          1,
                          '°Bx'
                        )}
                  </div>
                </div>
              </div>

              {(selectedSpec.additionalParams || []).length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-slate-700 mb-2">
                    Additional Batch Parameters
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {selectedSpec.additionalParams.map((param) => (
                      <div
                        key={param.id}
                        className="border border-slate-200 rounded px-3 py-2 flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900 truncate">
                            {param.name}
                          </div>
                          {param.targetNote && (
                            <div className="text-[11px] text-slate-500 truncate">
                              {param.targetNote}
                            </div>
                          )}
                        </div>
                        <div className="font-mono text-slate-800 font-semibold tabular-nums shrink-0">
                          {formatRange(
                            param.minTarget,
                            param.maxTarget,
                            2,
                            param.unit ? ` ${param.unit}` : ''
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selectedSpec.requirementNotes && (
                <p className="text-xs text-slate-600 bg-[#F7F8FA] border border-slate-200 rounded px-3 py-2">
                  {selectedSpec.requirementNotes}
                </p>
              )}
            </div>
          )}

          {/* Condition Records Table */}
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Condition Records ({visibleRecords.length})
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Timestamped category quality &amp; parameter checks
                </p>
              </div>
              <div className="flex items-center gap-1 bg-[#F7F8FA] border border-slate-200 rounded p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setRecordScope('selected')}
                  className={`px-2.5 py-1 rounded font-medium ${
                    recordScope === 'selected'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Selected Batch
                </button>
                <button
                  type="button"
                  onClick={() => setRecordScope('all')}
                  className={`px-2.5 py-1 rounded font-medium ${
                    recordScope === 'all'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  All Records
                </button>
              </div>
            </div>

            {visibleRecords.length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-sm font-medium text-slate-800">
                  No condition records logged yet
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Record configured quality &amp; parameter readings for this batch.
                </p>
              </div>
            ) : (
              (() => {
                const showPhCol = Boolean(
                  (recordScope === 'selected' &&
                    selectedSpec &&
                    (selectedSpec.phMin !== null || selectedSpec.phMax !== null)) ||
                    visibleRecords.some((r) => r.measuredPh !== null)
                );
                const showAwCol = Boolean(
                  (recordScope === 'selected' &&
                    selectedSpec &&
                    (selectedSpec.awMin !== null || selectedSpec.awMax !== null)) ||
                    visibleRecords.some((r) => r.measuredAw !== null)
                );
                const showBrixCol = Boolean(
                  (recordScope === 'selected' &&
                    selectedSpec &&
                    (selectedSpec.brixMin !== null || selectedSpec.brixMax !== null)) ||
                    visibleRecords.some((r) => r.measuredBrix !== null)
                );

                return (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-[#F7F8FA] border-b border-slate-200 text-xs font-medium text-slate-500">
                          <th className="py-2.5 px-4">Timestamp / Stage</th>
                          <th className="py-2.5 px-3">Batch / Type</th>
                          {showPhCol && <th className="py-2.5 px-3 text-right">pH</th>}
                          {showAwCol && <th className="py-2.5 px-3 text-right">Aw</th>}
                          {showBrixCol && <th className="py-2.5 px-3 text-right">Brix</th>}
                          <th className="py-2.5 px-3">Additional Params</th>
                          <th className="py-2.5 px-3">Status</th>
                          <th className="py-2.5 px-4 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {visibleRecords.map((rec) => (
                          <tr key={rec.id} className="hover:bg-slate-50 align-top">
                            <td className="py-3 px-4">
                              <div className="font-mono text-slate-900 whitespace-nowrap">
                                {rec.recordedAt}
                              </div>
                              <div className="text-slate-500 mt-0.5">
                                {rec.samplingStage} · {rec.inspectorName}
                              </div>
                              {rec.notes && (
                                <div className="text-[11px] text-slate-600 mt-1 max-w-xs">
                                  {rec.notes}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-3 whitespace-nowrap">
                              <div className="font-mono font-semibold text-slate-900">
                                {rec.batchNumber}
                              </div>
                              <div className="text-teal-800 font-medium">
                                {rec.productCategory}
                              </div>
                            </td>
                            {showPhCol && (
                              <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900">
                                <div>
                                  {rec.measuredPh !== null
                                    ? rec.measuredPh.toFixed(2)
                                    : '—'}
                                </div>
                                {rec.phReadings && rec.phReadings.length === 3 && (
                                  <div className="text-[10px] text-slate-500 mt-0.5 whitespace-nowrap">
                                    {rec.phReadings.map((v) => v.toFixed(2)).join(' · ')}
                                  </div>
                                )}
                              </td>
                            )}
                            {showAwCol && (
                              <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900">
                                <div>
                                  {rec.measuredAw !== null
                                    ? rec.measuredAw.toFixed(3)
                                    : '—'}
                                </div>
                                {rec.awReadings && rec.awReadings.length === 3 && (
                                  <div className="text-[10px] text-slate-500 mt-0.5 whitespace-nowrap">
                                    {rec.awReadings.map((v) => v.toFixed(3)).join(' · ')}
                                  </div>
                                )}
                              </td>
                            )}
                            {showBrixCol && (
                              <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900">
                                <div>
                                  {rec.measuredBrix !== null
                                    ? `${rec.measuredBrix.toFixed(1)}°`
                                    : '—'}
                                </div>
                                {rec.brixReadings && rec.brixReadings.length === 3 && (
                                  <div className="text-[10px] text-slate-500 mt-0.5 whitespace-nowrap">
                                    {rec.brixReadings.map((v) => v.toFixed(1)).join(' · ')}
                                  </div>
                                )}
                              </td>
                            )}
                        <td className="py-3 px-3">
                          {(rec.additionalReadings || []).length === 0 ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <div className="space-y-1">
                              {rec.additionalReadings.map((ar, i) => (
                                <div
                                  key={`${ar.paramId}-${i}`}
                                  className="flex items-center justify-between gap-2"
                                >
                                  <span className="text-slate-600">
                                    {ar.name}:
                                  </span>
                                  <span
                                    className={`font-mono tabular-nums font-medium ${
                                      ar.withinSpec
                                        ? 'text-slate-900'
                                        : 'text-red-700'
                                    }`}
                                  >
                                    {ar.value}
                                    {ar.unit ? ` ${ar.unit}` : ''}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1 font-semibold ${
                              rec.conditionStatus === 'In Spec'
                                ? 'text-emerald-700'
                                : rec.conditionStatus === 'Marginal'
                                  ? 'text-amber-700'
                                  : 'text-red-700'
                            }`}
                          >
                            {rec.conditionStatus === 'In Spec' ? (
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            ) : (
                              <AlertTriangle className="w-3.5 h-3.5" />
                            )}
                            {rec.conditionStatus}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          {confirmDeleteRecordId === rec.id ? (
                            <span className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void handleDeleteRecord(rec.id)}
                                className="font-medium text-red-700 hover:text-red-800"
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteRecordId(null)}
                                className="text-slate-500 hover:text-slate-800"
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => openEditRecordForm(rec)}
                                className="text-slate-500 hover:text-teal-700"
                                title="Edit condition record"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteRecordId(rec.id)}
                                className="text-slate-400 hover:text-red-700"
                                title="Delete condition record"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
