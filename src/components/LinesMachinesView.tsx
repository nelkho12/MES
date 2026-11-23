import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Droplets,
  Edit3,
  PauseCircle,
  Plus,
  Search,
  Sliders,
  Thermometer,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import type {
  BatchCheckProductCategory,
  LineOperationalStatus,
  MachineCategory,
  MachineParameterSetting,
  ProductionBatch,
  ProductionLineMachine,
  ThermalSensor,
} from '../types';
import {
  deleteProductionLine,
  deleteThermalSensor,
  saveProductionLine,
  saveThermalSensor,
  updatePlantOptions,
  updateProductionLineStatus,
} from '../services/mesService';

interface LinesMachinesViewProps {
  lines: ProductionLineMachine[];
  sensors: ThermalSensor[];
  batches: ProductionBatch[];
  productCategories?: string[];
  operationalStatuses?: string[];
  sensorMasterEnabled?: boolean;
  onOpenSensorSettings?: () => void;
  onOpenBatch: (batchId: string) => void;
  onNotify: (msg: string) => void;
}

const DEFAULT_STATUS_OPTIONS: LineOperationalStatus[] = [
  'Active',
  'Standby',
  'CIP Cleaning',
  'Maintenance',
];

const DEFAULT_PRODUCT_CATEGORIES: BatchCheckProductCategory[] = [
  'Sauce',
  'Syrup',
  'Powder',
];

const MACHINE_CATEGORIES: MachineCategory[] = [
  'Thermal Kettle',
  'Pasteurizer / Beverage',
  'Filling & Sealing',
  'Dry Blending / Powder',
  'Cooling / Retort',
];

const SENSOR_ZONES = [
  'Hot Processing Floor',
  'Thermal Sterilization',
  'Cold Storage Wing',
  'Packaging & Cooling',
  'Dry Blending Suite',
];

interface EditableSettingRow {
  id: string;
  parameterName: string;
  setpoint: string;
  minLimit: string;
  maxLimit: string;
  unit: string;
  notes: string;
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function formatBounds(
  min: number | null,
  max: number | null,
  unit: string
): string {
  if (min === null && max === null) return 'Nominal';
  const suffix = unit ? ` ${unit}` : '';
  if (min !== null && max !== null) return `${min}–${max}${suffix}`;
  if (min !== null) return `>= ${min}${suffix}`;
  return `<= ${max}${suffix}`;
}

function renderStatusLabel(status: LineOperationalStatus) {
  const lower = status.toLowerCase();
  if (lower === 'active' || lower === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
        <CheckCircle2 className="w-3.5 h-3.5" />
        {status}
      </span>
    );
  }
  if (lower.includes('cip') || lower.includes('clean') || lower.includes('sanit')) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700">
        <Droplets className="w-3.5 h-3.5" />
        {status}
      </span>
    );
  }
  if (
    lower.includes('maint') ||
    lower.includes('fault') ||
    lower.includes('offline') ||
    lower.includes('hold')
  ) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700">
        <Wrench className="w-3.5 h-3.5" />
        {status}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600">
      <PauseCircle className="w-3.5 h-3.5" />
      {status}
    </span>
  );
}

export function LinesMachinesView({
  lines,
  sensors,
  batches,
  productCategories = DEFAULT_PRODUCT_CATEGORIES,
  operationalStatuses = DEFAULT_STATUS_OPTIONS,
  sensorMasterEnabled = false,
  onOpenSensorSettings,
  onOpenBatch,
  onNotify,
}: LinesMachinesViewProps) {
  const availableCategories = useMemo(() => {
    const merged = new Set<string>(
      productCategories.length > 0 ? productCategories : DEFAULT_PRODUCT_CATEGORIES
    );
    for (const l of lines) {
      for (const c of l.supportedProductTypes || []) {
        if (c) merged.add(c);
      }
    }
    return Array.from(merged);
  }, [productCategories, lines]);

  const availableStatuses = useMemo(() => {
    const merged = new Set<string>(
      operationalStatuses.length > 0
        ? operationalStatuses
        : DEFAULT_STATUS_OPTIONS
    );
    for (const l of lines) {
      if (l.status) merged.add(l.status);
    }
    return Array.from(merged);
  }, [operationalStatuses, lines]);

  const [statusFilter, setStatusFilter] = useState<'All' | LineOperationalStatus>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLineId, setSelectedLineId] = useState<string>(lines[0]?.id || '');

  // Inline master-list editors (Product Categories, Operational Statuses, Thermal Probes)
  const [showCategoriesManager, setShowCategoriesManager] = useState(false);
  const [newCategoryDraft, setNewCategoryDraft] = useState('');
  const [editingCategoryIndex, setEditingCategoryIndex] = useState<number | null>(null);
  const [editingCategoryDraft, setEditingCategoryDraft] = useState('');

  const [showStatusesManager, setShowStatusesManager] = useState(false);
  const [newStatusDraft, setNewStatusDraft] = useState('');
  const [editingStatusIndex, setEditingStatusIndex] = useState<number | null>(null);
  const [editingStatusDraft, setEditingStatusDraft] = useState('');

  // Thermal Probe editor state
  const [showProbeRegistry, setShowProbeRegistry] = useState(false);
  const [showProbeEditor, setShowProbeEditor] = useState(false);
  const [editingProbeId, setEditingProbeId] = useState<string | null>(null);
  const [probeCode, setProbeCode] = useState('');
  const [probeName, setProbeName] = useState('');
  const [probeZone, setProbeZone] = useState('Hot Processing Floor');
  const [probeEquipmentType, setProbeEquipmentType] = useState('Pt100 RTD Probe');
  const [probeLinkedLine, setProbeLinkedLine] = useState('');
  const [probeCurrentTemp, setProbeCurrentTemp] = useState('85.0');
  const [probeTargetTemp, setProbeTargetTemp] = useState('85.0');
  const [probeMinSafe, setProbeMinSafe] = useState('82.0');
  const [probeMaxSafe, setProbeMaxSafe] = useState('88.0');
  const [probeHumidity, setProbeHumidity] = useState('60');
  const [probeNote, setProbeNote] = useState('');
  const [assignProbeToSelectedLine, setAssignProbeToSelectedLine] = useState(false);
  const [savingProbe, setSavingProbe] = useState(false);
  const [confirmDeleteProbeId, setConfirmDeleteProbeId] = useState<string | null>(null);

  // Line / Machine editor state
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [lineCode, setLineCode] = useState('');
  const [lineName, setLineName] = useState('');
  const [machineName, setMachineName] = useState('');
  const [machineModel, setMachineModel] = useState('');
  const [category, setCategory] = useState<MachineCategory>('Thermal Kettle');
  const [supportedProductTypes, setSupportedProductTypes] = useState<
    BatchCheckProductCategory[]
  >(['Sauce']);
  const [inlineNewCategory, setInlineNewCategory] = useState('');
  const [status, setStatus] = useState<LineOperationalStatus>('Active');
  const [inlineNewStatus, setInlineNewStatus] = useState('');
  const [batchCapacity, setBatchCapacity] = useState('1000');
  const [capacityUnit, setCapacityUnit] = useState('kg');
  const [targetTempC, setTargetTempC] = useState('');
  const [agitatorRpm, setAgitatorRpm] = useState('');
  const [pressureBar, setPressureBar] = useState('');
  const [fillerSpeed, setFillerSpeed] = useState('');
  const [cleaningIntervalHours, setCleaningIntervalHours] = useState('8');
  const [defaultCrew, setDefaultCrew] = useState('');
  const [linkedSensorCode, setLinkedSensorCode] = useState('');
  const [customSettings, setCustomSettings] = useState<EditableSettingRow[]>([]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [updatingFieldId, setUpdatingFieldId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const filteredLines = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return lines.filter((line) => {
      if (statusFilter !== 'All' && line.status !== statusFilter) return false;
      if (!q) return true;
      return (
        line.lineCode.toLowerCase().includes(q) ||
        line.lineName.toLowerCase().includes(q) ||
        line.machineName.toLowerCase().includes(q) ||
        line.machineModel.toLowerCase().includes(q) ||
        line.category.toLowerCase().includes(q)
      );
    });
  }, [lines, statusFilter, searchQuery]);

  useEffect(() => {
    if (filteredLines.length === 0) {
      if (selectedLineId !== '') setSelectedLineId('');
      return;
    }
    if (!filteredLines.some((l) => l.id === selectedLineId)) {
      setSelectedLineId(filteredLines[0].id);
    }
  }, [filteredLines, selectedLineId]);

  const selectedLine = useMemo(
    () => lines.find((l) => l.id === selectedLineId) || filteredLines[0] || null,
    [lines, filteredLines, selectedLineId]
  );

  const sensorByCode = useMemo(
    () => new Map(sensors.map((s) => [s.sensorCode, s])),
    [sensors]
  );

  const lineBatches = useMemo(() => {
    if (!selectedLine) return [];
    return batches.filter((b) => b.lineName === selectedLine.lineName);
  }, [batches, selectedLine]);

  const kpis = useMemo(() => {
    const activeCount = lines.filter(
      (l) => l.status.toLowerCase() === 'active'
    ).length;
    const maintenanceOrCip = lines.filter(
      (l) =>
        l.status.toLowerCase().includes('maint') ||
        l.status.toLowerCase().includes('cip')
    ).length;
    const activeThroughput = lines
      .filter((l) => l.status.toLowerCase() === 'active')
      .reduce((sum, l) => sum + (l.fillerSpeedUnitsPerMin || 0), 0);
    return {
      activeCount,
      maintenanceOrCip,
      activeThroughput,
      probeCount: sensors.length,
    };
  }, [lines, sensors]);

  // --- Plant Catalog Editors (Product Categories & Operational Statuses) ---

  async function saveCategoryList(nextList: string[], message: string) {
    try {
      await updatePlantOptions({ productCategories: nextList });
      onNotify(message);
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to save product categories.'
      );
    }
  }

  async function handleAddCategory(nameRaw: string) {
    const val = nameRaw.trim();
    if (!val) return;
    if (availableCategories.some((c) => c.toLowerCase() === val.toLowerCase())) {
      onNotify(`Category "${val}" already exists.`);
      return;
    }
    const next = [...availableCategories, val];
    await saveCategoryList(next, `Added product category "${val}".`);
    setNewCategoryDraft('');
  }

  async function handleRenameCategory(idx: number) {
    const trimmed = editingCategoryDraft.trim();
    if (!trimmed) return;
    const oldVal = availableCategories[idx];
    const next = availableCategories.map((c, i) => (i === idx ? trimmed : c));
    await saveCategoryList(next, `Renamed category "${oldVal}" to "${trimmed}".`);
    setEditingCategoryIndex(null);
    setEditingCategoryDraft('');
  }

  async function handleRemoveCategory(cat: string) {
    if (availableCategories.length <= 1) {
      onNotify('At least one product category must remain.');
      return;
    }
    const next = availableCategories.filter((c) => c !== cat);
    await saveCategoryList(next, `Removed product category "${cat}".`);
  }

  async function saveStatusList(nextList: string[], message: string) {
    try {
      await updatePlantOptions({ operationalStatuses: nextList });
      onNotify(message);
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to save operational statuses.'
      );
    }
  }

  async function handleAddStatus(nameRaw: string) {
    const val = nameRaw.trim();
    if (!val) return;
    if (availableStatuses.some((s) => s.toLowerCase() === val.toLowerCase())) {
      onNotify(`Status "${val}" already exists.`);
      return;
    }
    const next = [...availableStatuses, val];
    await saveStatusList(next, `Added operational status "${val}".`);
    setNewStatusDraft('');
  }

  async function handleRenameStatus(idx: number) {
    const trimmed = editingStatusDraft.trim();
    if (!trimmed) return;
    const oldVal = availableStatuses[idx];
    const next = availableStatuses.map((s, i) => (i === idx ? trimmed : s));
    await saveStatusList(next, `Renamed status "${oldVal}" to "${trimmed}".`);
    setEditingStatusIndex(null);
    setEditingStatusDraft('');
  }

  async function handleRemoveStatus(st: string) {
    if (availableStatuses.length <= 1) {
      onNotify('At least one operational status must remain.');
      return;
    }
    const next = availableStatuses.filter((s) => s !== st);
    await saveStatusList(next, `Removed operational status "${st}".`);
  }

  // --- Thermal Probe CRUD ---

  function openNewProbeEditor(defaultLineName = '', assignToSelected = false) {
    const nextIdx = sensors.length + 1;
    setEditingProbeId(null);
    setProbeCode(`TMP-PRB-0${nextIdx}`);
    setProbeName('');
    setProbeZone('Hot Processing Floor');
    setProbeEquipmentType('Pt100 RTD Probe');
    setProbeLinkedLine(defaultLineName);
    setProbeCurrentTemp('85.0');
    setProbeTargetTemp('85.0');
    setProbeMinSafe('82.0');
    setProbeMaxSafe('88.0');
    setProbeHumidity('60');
    setProbeNote('');
    setAssignProbeToSelectedLine(assignToSelected);
    setShowProbeEditor(true);
  }

  function openEditProbeEditor(sensor: ThermalSensor) {
    setEditingProbeId(sensor.id);
    setProbeCode(sensor.sensorCode);
    setProbeName(sensor.name);
    setProbeZone(sensor.zone);
    setProbeEquipmentType(sensor.equipmentType);
    setProbeLinkedLine(sensor.linkedLine || '');
    setProbeCurrentTemp(String(sensor.currentTempC));
    setProbeTargetTemp(String(sensor.targetTempC));
    setProbeMinSafe(String(sensor.minSafeTempC));
    setProbeMaxSafe(String(sensor.maxSafeTempC));
    setProbeHumidity(String(sensor.humidityPct));
    setProbeNote(sensor.yieldImpactNote || '');
    setAssignProbeToSelectedLine(false);
    setShowProbeEditor(true);
  }

  async function handleSaveProbe(e: React.FormEvent) {
    e.preventDefault();
    if (!probeCode.trim() || !probeName.trim()) {
      onNotify('Thermal probe code and name are required.');
      return;
    }

    setSavingProbe(true);
    try {
      const saved = await saveThermalSensor({
        id: editingProbeId || undefined,
        sensorCode: probeCode.trim(),
        name: probeName.trim(),
        zone: probeZone.trim(),
        equipmentType: probeEquipmentType.trim(),
        linkedLine: probeLinkedLine.trim(),
        currentTempC: Number(probeCurrentTemp),
        targetTempC: Number(probeTargetTemp),
        minSafeTempC: Number(probeMinSafe),
        maxSafeTempC: Number(probeMaxSafe),
        humidityPct: Number(probeHumidity) || 60,
        yieldImpactNote: probeNote.trim(),
      });

      if (assignProbeToSelectedLine && selectedLine) {
        await persistLinePatch(selectedLine, { linkedSensorCode: saved.sensorCode });
      }
      if (showEditor && assignProbeToSelectedLine) {
        setLinkedSensorCode(saved.sensorCode);
      }

      setShowProbeEditor(false);
      setEditingProbeId(null);
      onNotify(`Saved thermal probe ${saved.sensorCode} (${saved.name}).`);
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to save thermal probe.'
      );
    } finally {
      setSavingProbe(false);
    }
  }

  async function handleDeleteProbe(sensor: ThermalSensor) {
    try {
      await deleteThermalSensor(sensor.id);
      setConfirmDeleteProbeId(null);
      onNotify(`Removed thermal probe ${sensor.sensorCode}.`);
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to delete thermal probe.'
      );
    }
  }

  // --- Line / Machine CRUD & Inline Updates ---

  async function persistLinePatch(
    line: ProductionLineMachine,
    patch: Partial<{
      supportedProductTypes: string[];
      status: string;
      linkedSensorCode: string;
    }>
  ) {
    setUpdatingFieldId(line.id);
    try {
      await saveProductionLine({
        id: line.id,
        lineCode: line.lineCode,
        lineName: line.lineName,
        machineName: line.machineName,
        machineModel: line.machineModel,
        category: line.category,
        supportedProductTypes:
          patch.supportedProductTypes ?? line.supportedProductTypes ?? [],
        status: patch.status ?? line.status,
        batchCapacity: line.batchCapacity,
        capacityUnit: line.capacityUnit,
        targetTempC: line.targetTempC,
        agitatorRpm: line.agitatorRpm,
        pressureBar: line.pressureBar,
        fillerSpeedUnitsPerMin: line.fillerSpeedUnitsPerMin,
        cleaningIntervalHours: line.cleaningIntervalHours,
        defaultCrew: line.defaultCrew,
        linkedSensorCode:
          patch.linkedSensorCode !== undefined
            ? patch.linkedSensorCode
            : line.linkedSensorCode,
        customSettings: line.customSettings || [],
        notes: line.notes || '',
      });
    } finally {
      setUpdatingFieldId(null);
    }
  }

  async function handleInlineToggleLineCategory(
    line: ProductionLineMachine,
    cat: string
  ) {
    const existing = line.supportedProductTypes || [];
    const next = existing.includes(cat)
      ? existing.filter((c) => c !== cat)
      : [...existing, cat];
    try {
      await persistLinePatch(line, { supportedProductTypes: next });
      onNotify(`Updated supported categories for ${line.lineName}.`);
    } catch (error) {
      onNotify(
        error instanceof Error
          ? error.message
          : 'Unable to update product categories.'
      );
    }
  }

  async function handleInlineProbeChange(
    line: ProductionLineMachine,
    nextCode: string
  ) {
    try {
      await persistLinePatch(line, { linkedSensorCode: nextCode });
      onNotify(
        nextCode
          ? `Linked ${nextCode} to ${line.lineName}.`
          : `Cleared linked thermal probe on ${line.lineName}.`
      );
    } catch (error) {
      onNotify(
        error instanceof Error
          ? error.message
          : 'Unable to update linked thermal probe.'
      );
    }
  }

  function openNewLineForm() {
    const nextNum = lines.length + 1;
    setEditingId(null);
    setLineCode(`LINE-0${nextNum}`);
    setLineName('');
    setMachineName('');
    setMachineModel('');
    setCategory('Thermal Kettle');
    setSupportedProductTypes([availableCategories[0] || 'Sauce']);
    setStatus(availableStatuses[0] || 'Active');
    setBatchCapacity('1000');
    setCapacityUnit('kg');
    setTargetTempC('85.0');
    setAgitatorRpm('60');
    setPressureBar('1.5');
    setFillerSpeed('50');
    setCleaningIntervalHours('8');
    setDefaultCrew('Shift A · Thermal Crew');
    setLinkedSensorCode('');
    setCustomSettings([
      {
        id: `mset-${Date.now().toString(36)}`,
        parameterName: 'Jacket Steam Pressure',
        setpoint: '2.0',
        minLimit: '1.6',
        maxLimit: '2.4',
        unit: 'bar',
        notes: 'Standard operating steam manifold pressure',
      },
    ]);
    setNotes('');
    setShowEditor(true);
  }

  function openEditLineForm(line: ProductionLineMachine) {
    setEditingId(line.id);
    setLineCode(line.lineCode);
    setLineName(line.lineName);
    setMachineName(line.machineName);
    setMachineModel(line.machineModel || '');
    setCategory(line.category);
    setSupportedProductTypes(
      line.supportedProductTypes?.length ? line.supportedProductTypes : []
    );
    setStatus(line.status);
    setBatchCapacity(String(line.batchCapacity));
    setCapacityUnit(line.capacityUnit || 'kg');
    setTargetTempC(line.targetTempC !== null ? String(line.targetTempC) : '');
    setAgitatorRpm(line.agitatorRpm !== null ? String(line.agitatorRpm) : '');
    setPressureBar(line.pressureBar !== null ? String(line.pressureBar) : '');
    setFillerSpeed(
      line.fillerSpeedUnitsPerMin !== null
        ? String(line.fillerSpeedUnitsPerMin)
        : ''
    );
    setCleaningIntervalHours(String(line.cleaningIntervalHours || 8));
    setDefaultCrew(line.defaultCrew || '');
    setLinkedSensorCode(line.linkedSensorCode || '');
    setCustomSettings(
      (line.customSettings || []).map((s) => ({
        id: s.id,
        parameterName: s.parameterName,
        setpoint: s.setpoint,
        minLimit: s.minLimit !== null ? String(s.minLimit) : '',
        maxLimit: s.maxLimit !== null ? String(s.maxLimit) : '',
        unit: s.unit,
        notes: s.notes || '',
      }))
    );
    setNotes(line.notes || '');
    setShowEditor(true);
  }

  function toggleProductType(type: BatchCheckProductCategory) {
    setSupportedProductTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  }

  function addCustomSettingRow() {
    setCustomSettings((prev) => [
      ...prev,
      {
        id: `mset-${Date.now().toString(36)}-${prev.length + 1}`,
        parameterName: '',
        setpoint: '',
        minLimit: '',
        maxLimit: '',
        unit: '',
        notes: '',
      },
    ]);
  }

  function updateCustomSettingRow(
    idx: number,
    field: keyof EditableSettingRow,
    val: string
  ) {
    setCustomSettings((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, [field]: val } : row))
    );
  }

  async function handleSaveLine(e: React.FormEvent) {
    e.preventDefault();
    if (!lineCode.trim() || !lineName.trim() || !machineName.trim()) {
      onNotify('Line code, line name, and machine name are required.');
      return;
    }

    setSaving(true);
    try {
      const sanitizedParams: MachineParameterSetting[] = customSettings
        .filter((r) => r.parameterName.trim().length > 0)
        .map((r) => ({
          id: r.id,
          parameterName: r.parameterName.trim(),
          setpoint: r.setpoint.trim(),
          minLimit: parseOptionalNumber(r.minLimit),
          maxLimit: parseOptionalNumber(r.maxLimit),
          unit: r.unit.trim(),
          notes: r.notes.trim(),
        }));

      const saved = await saveProductionLine({
        id: editingId || undefined,
        lineCode: lineCode.trim(),
        lineName: lineName.trim(),
        machineName: machineName.trim(),
        machineModel: machineModel.trim(),
        category,
        supportedProductTypes,
        status,
        batchCapacity: Math.max(1, Number(batchCapacity) || 500),
        capacityUnit: capacityUnit.trim() || 'kg',
        targetTempC: parseOptionalNumber(targetTempC),
        agitatorRpm: parseOptionalNumber(agitatorRpm),
        pressureBar: parseOptionalNumber(pressureBar),
        fillerSpeedUnitsPerMin: parseOptionalNumber(fillerSpeed),
        cleaningIntervalHours: Math.max(1, Number(cleaningIntervalHours) || 8),
        defaultCrew: defaultCrew.trim(),
        linkedSensorCode: linkedSensorCode.trim(),
        customSettings: sanitizedParams,
        notes: notes.trim(),
      });

      setSelectedLineId(saved.id);
      setShowEditor(false);
      setEditingId(null);
      onNotify(`Saved settings for ${saved.lineCode} (${saved.lineName}).`);
    } catch (error) {
      onNotify(
        error instanceof Error
          ? error.message
          : 'Unable to save production line settings.'
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleQuickStatusChange(
    line: ProductionLineMachine,
    nextStatus: LineOperationalStatus
  ) {
    if (line.status === nextStatus) return;
    setUpdatingFieldId(line.id);
    try {
      await updateProductionLineStatus(line.id, nextStatus);
      onNotify(`${line.lineName} status set to ${nextStatus}.`);
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to change line status.'
      );
    } finally {
      setUpdatingFieldId(null);
    }
  }

  async function handleDeleteLine(line: ProductionLineMachine) {
    try {
      await deleteProductionLine(line.id);
      setConfirmDeleteId(null);
      onNotify(`Removed ${line.lineCode} (${line.lineName}).`);
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to delete line setting.'
      );
    }
  }

  const selectedProbe = selectedLine?.linkedSensorCode
    ? sensorByCode.get(selectedLine.linkedSensorCode)
    : undefined;

  return (
    <div className="space-y-6">
      {/* 4-Column High-Density KPI Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">
            Active Production Lines
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {kpis.activeCount}/{lines.length}
            </span>
            <span className="text-xs font-medium text-emerald-700">
              Ready for scheduling
            </span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">
            Active Line Throughput
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {kpis.activeThroughput.toLocaleString()}
            </span>
            <span className="text-xs text-slate-500">units / min rated</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">
            CIP Cleaning / Maintenance
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span
              className={`font-mono text-2xl font-semibold tabular-nums ${
                kpis.maintenanceOrCip > 0 ? 'text-amber-700' : 'text-slate-900'
              }`}
            >
              {kpis.maintenanceOrCip}
            </span>
            <span className="text-xs text-slate-500">
              {kpis.maintenanceOrCip === 0
                ? 'No downtime flags'
                : 'Lines offline / sanitizing'}
            </span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">
            Configured Thermal Probes
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-semibold text-slate-900 tabular-nums">
              {kpis.probeCount}
            </span>
            <button
              type="button"
              onClick={() => setShowProbeRegistry((v) => !v)}
              className="text-xs font-medium text-teal-700 hover:text-teal-800 whitespace-nowrap"
            >
              {showProbeRegistry ? 'Hide probes' : 'Manage probes'}
            </button>
          </div>
        </div>
      </section>

      {/* Filter & Primary Action Toolbar */}
      <section className="bg-white border border-slate-200 rounded-lg px-5 py-3.5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {(['All', ...availableStatuses] as const).map((st) => {
              const active = statusFilter === st;
              return (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-teal-50 text-teal-800 border border-teal-200'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50 border border-transparent'
                  }`}
                >
                  {st}
                </button>
              );
            })}
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter line, machine, or model..."
              className="border border-slate-200 rounded-md pl-8 pr-3 py-1.5 text-xs text-slate-800 w-56 focus:outline-none focus:border-teal-600"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onOpenSensorSettings && (
            <button
              type="button"
              onClick={onOpenSensorSettings}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded-md whitespace-nowrap"
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>Sensor Adapter: {sensorMasterEnabled ? 'ON' : 'OFF'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowProbeRegistry((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
          >
            <Thermometer className="w-3.5 h-3.5" />
            Thermal Probes ({sensors.length})
          </button>
          <button
            type="button"
            onClick={openNewLineForm}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Line / Machine
          </button>
        </div>
      </section>

      {/* Thermal Probe Registry & Editor */}
      {(showProbeRegistry || showProbeEditor) && (
        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-slate-100">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Thermal Probes Configuration ({sensors.length})
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Create, edit, or reassign temperature probes and safe HACCP threshold bands
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  openNewProbeEditor(selectedLine?.lineName || '', false)
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
              >
                <Plus className="w-3.5 h-3.5" />
                New Thermal Probe
              </button>
              {showProbeRegistry && !showProbeEditor && (
                <button
                  type="button"
                  onClick={() => setShowProbeRegistry(false)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {showProbeEditor && (
            <form
              onSubmit={(e) => void handleSaveProbe(e)}
              className="bg-[#F7F8FA] border border-teal-300 rounded-md p-4 space-y-4"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">
                  {editingProbeId
                    ? `Edit Thermal Probe (${probeCode})`
                    : 'Add New Thermal Probe'}
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    setShowProbeEditor(false);
                    setEditingProbeId(null);
                  }}
                  className="p-1 text-slate-400 hover:text-slate-700 rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Probe Code *
                  </label>
                  <input
                    type="text"
                    value={probeCode}
                    onChange={(e) => setProbeCode(e.target.value)}
                    placeholder="TMP-KTL-07"
                    className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Probe Name *
                  </label>
                  <input
                    type="text"
                    value={probeName}
                    onChange={(e) => setProbeName(e.target.value)}
                    placeholder="Kettle Jacket Core RTD"
                    className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Floor Zone
                  </label>
                  <select
                    value={probeZone}
                    onChange={(e) => setProbeZone(e.target.value)}
                    className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs"
                  >
                    {SENSOR_ZONES.map((z) => (
                      <option key={z} value={z}>
                        {z}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Assigned Production Line
                  </label>
                  <select
                    value={probeLinkedLine}
                    onChange={(e) => setProbeLinkedLine(e.target.value)}
                    className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs"
                  >
                    <option value="">General / Facility</option>
                    {lines.map((l) => (
                      <option key={l.id} value={l.lineName}>
                        {l.lineName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Probe Type
                  </label>
                  <input
                    type="text"
                    value={probeEquipmentType}
                    onChange={(e) => setProbeEquipmentType(e.target.value)}
                    className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Current (°C)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={probeCurrentTemp}
                    onChange={(e) => setProbeCurrentTemp(e.target.value)}
                    className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Target (°C)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={probeTargetTemp}
                    onChange={(e) => setProbeTargetTemp(e.target.value)}
                    className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Min Safe (°C)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={probeMinSafe}
                    onChange={(e) => setProbeMinSafe(e.target.value)}
                    className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Max Safe (°C)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={probeMaxSafe}
                    onChange={(e) => setProbeMaxSafe(e.target.value)}
                    className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Humidity (%)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={probeHumidity}
                    onChange={(e) => setProbeHumidity(e.target.value)}
                    className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Calibration / Yield Impact Note
                  </label>
                  <input
                    type="text"
                    value={probeNote}
                    onChange={(e) => setProbeNote(e.target.value)}
                    placeholder="Optional probe placement or thermal drift note..."
                    className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowProbeEditor(false);
                      setEditingProbeId(null);
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 bg-white rounded"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingProbe}
                    className="px-3.5 py-1.5 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded"
                  >
                    {savingProbe ? 'Saving Probe...' : 'Save Thermal Probe'}
                  </button>
                </div>
              </div>
            </form>
          )}

          {showProbeRegistry && (
            <div className="overflow-x-auto border border-slate-200 rounded">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                    <th className="py-2 px-3">Probe Code</th>
                    <th className="py-2 px-3">Name &amp; Type</th>
                    <th className="py-2 px-3">Zone / Line</th>
                    <th className="py-2 px-3 text-right">Current</th>
                    <th className="py-2 px-3 text-right">Target</th>
                    <th className="py-2 px-3 text-right">Safe Band</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sensors.map((sensor) => (
                    <tr key={sensor.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3 font-mono font-semibold text-slate-900 whitespace-nowrap">
                        {sensor.sensorCode}
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="font-medium text-slate-900">{sensor.name}</div>
                        <div className="text-[11px] text-slate-500">
                          {sensor.equipmentType}
                        </div>
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="text-slate-800">{sensor.zone}</div>
                        <div className="text-[11px] text-slate-500">
                          {sensor.linkedLine || 'Unlinked'}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                        {sensor.currentTempC.toFixed(1)}°C
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                        {sensor.targetTempC.toFixed(1)}°C
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        {sensor.minSafeTempC.toFixed(1)}–{sensor.maxSafeTempC.toFixed(1)}°C
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span
                          className={`font-semibold ${
                            sensor.status === 'Excursion'
                              ? 'text-red-700'
                              : sensor.status === 'Warning'
                                ? 'text-amber-700'
                                : 'text-emerald-700'
                          }`}
                        >
                          {sensor.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => openEditProbeEditor(sensor)}
                            className="font-medium text-teal-700 hover:text-teal-800"
                          >
                            Edit
                          </button>
                          {confirmDeleteProbeId === sensor.id ? (
                            <span className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => void handleDeleteProbe(sensor)}
                                className="font-semibold text-red-700"
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteProbeId(null)}
                                className="text-slate-500"
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteProbeId(sensor.id)}
                              className="text-slate-400 hover:text-red-700"
                              title="Delete probe"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Create / Edit Machine Settings Panel */}
      {showEditor && (
        <section className="bg-white border border-teal-300 rounded-lg p-5 space-y-5">
          <div className="flex items-center justify-between gap-4 pb-3 border-b border-slate-100">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {editingId
                  ? 'Edit Production Line & Machine Settings'
                  : 'Configure New Production Line / Machine'}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Define vessel capacity, operating setpoints, product categories, operational status, and thermal probe link
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowEditor(false);
                setEditingId(null);
              }}
              className="p-1.5 text-slate-400 hover:text-slate-700 rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <form onSubmit={(e) => void handleSaveLine(e)} className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Line Code *
                </label>
                <input
                  type="text"
                  value={lineCode}
                  onChange={(e) => setLineCode(e.target.value)}
                  placeholder="LINE-05"
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:border-teal-600"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Production Line Name *
                </label>
                <input
                  type="text"
                  value={lineName}
                  onChange={(e) => setLineName(e.target.value)}
                  placeholder="Kettle Line 5"
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-teal-600"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Primary Machine Name *
                </label>
                <input
                  type="text"
                  value={machineName}
                  onChange={(e) => setMachineName(e.target.value)}
                  placeholder="1200L Vacuum Kettle"
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-teal-600"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Equipment Model / Asset Tag
                </label>
                <input
                  type="text"
                  value={machineModel}
                  onChange={(e) => setMachineModel(e.target.value)}
                  placeholder="KTL-1200V"
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:border-teal-600"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Equipment Category
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as MachineCategory)}
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs bg-white text-slate-800 focus:outline-none focus:border-teal-600"
                >
                  {MACHINE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Operational Status
                </label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs bg-white text-slate-800 focus:outline-none focus:border-teal-600"
                >
                  {availableStatuses.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <input
                    type="text"
                    value={inlineNewStatus}
                    onChange={(e) => setInlineNewStatus(e.target.value)}
                    placeholder="Add custom status..."
                    className="flex-1 border border-slate-200 rounded px-2 py-1 text-[11px] bg-white"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const val = inlineNewStatus.trim();
                      if (!val) return;
                      await handleAddStatus(val);
                      setStatus(val);
                      setInlineNewStatus('');
                    }}
                    className="px-2 py-1 text-[11px] font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded whitespace-nowrap"
                  >
                    + Status
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Default Assigned Crew
                </label>
                <input
                  type="text"
                  value={defaultCrew}
                  onChange={(e) => setDefaultCrew(e.target.value)}
                  placeholder="Shift A · Thermal Crew"
                  className="w-full border border-slate-200 rounded px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-teal-600"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Linked Thermal Probe
                </label>
                <div className="flex items-center gap-1.5">
                  <select
                    value={linkedSensorCode}
                    onChange={(e) => setLinkedSensorCode(e.target.value)}
                    className="flex-1 border border-slate-200 rounded px-3 py-2 text-xs bg-white text-slate-800 focus:outline-none focus:border-teal-600"
                  >
                    <option value="">None / Ambient Suite</option>
                    {sensors.map((s) => (
                      <option key={s.id} value={s.sensorCode}>
                        {s.sensorCode} — {s.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => openNewProbeEditor(lineName, true)}
                    className="px-2.5 py-2 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded whitespace-nowrap"
                  >
                    + Probe
                  </button>
                </div>
              </div>
            </div>

            {/* Editable Supported Product Categories */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                <span className="text-xs font-medium text-slate-700">
                  Supported Product Categories
                </span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={inlineNewCategory}
                    onChange={(e) => setInlineNewCategory(e.target.value)}
                    placeholder="Add category (e.g. Beverage)..."
                    className="border border-slate-200 rounded px-2.5 py-1 text-[11px] bg-white w-48"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const val = inlineNewCategory.trim();
                      if (!val) return;
                      await handleAddCategory(val);
                      setSupportedProductTypes((prev) =>
                        prev.includes(val) ? prev : [...prev, val]
                      );
                      setInlineNewCategory('');
                    }}
                    className="px-2.5 py-1 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded whitespace-nowrap"
                  >
                    + Add Category
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {availableCategories.map((type) => {
                  const checked = supportedProductTypes.includes(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => toggleProductType(type)}
                      className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors ${
                        checked
                          ? 'bg-teal-50 border-teal-300 text-teal-800'
                          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {checked ? '✓ ' : ''}
                      {type}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Machine Operating Setpoints */}
            <div className="grid grid-cols-2 md:grid-cols-7 gap-3 bg-[#F7F8FA] border border-slate-200 rounded-md p-4">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Batch Capacity *
                </label>
                <input
                  type="number"
                  min={1}
                  step="any"
                  value={batchCapacity}
                  onChange={(e) => setBatchCapacity(e.target.value)}
                  className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                  required
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Capacity Unit
                </label>
                <input
                  type="text"
                  value={capacityUnit}
                  onChange={(e) => setCapacityUnit(e.target.value)}
                  placeholder="jars / kg / packs"
                  className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Target Temp (°C)
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={targetTempC}
                  onChange={(e) => setTargetTempC(e.target.value)}
                  placeholder="92.0"
                  className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Agitator (RPM)
                </label>
                <input
                  type="number"
                  min={0}
                  value={agitatorRpm}
                  onChange={(e) => setAgitatorRpm(e.target.value)}
                  placeholder="48"
                  className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Pressure (bar)
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={pressureBar}
                  onChange={(e) => setPressureBar(e.target.value)}
                  placeholder="1.8"
                  className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Speed (units/min)
                </label>
                <input
                  type="number"
                  min={0}
                  value={fillerSpeed}
                  onChange={(e) => setFillerSpeed(e.target.value)}
                  placeholder="45"
                  className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  CIP Interval (hrs)
                </label>
                <input
                  type="number"
                  min={1}
                  value={cleaningIntervalHours}
                  onChange={(e) => setCleaningIntervalHours(e.target.value)}
                  className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono tabular-nums"
                />
              </div>
            </div>

            {/* Dynamic Custom Machine Parameters */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-slate-800">
                    Machine Parameter Settings &amp; Limits
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Configure PLC setpoints, manifold pressures, vacuum levels, sieve mesh, or torque limits
                  </p>
                </div>
                <button
                  type="button"
                  onClick={addCustomSettingRow}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Parameter
                </button>
              </div>

              {customSettings.length === 0 ? (
                <div className="text-xs text-slate-500 py-3 px-4 border border-dashed border-slate-200 rounded">
                  No custom machine parameters added.
                </div>
              ) : (
                <div className="space-y-2">
                  {customSettings.map((row, idx) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center bg-[#F7F8FA] border border-slate-200 rounded p-2.5"
                    >
                      <div className="md:col-span-3">
                        <input
                          type="text"
                          value={row.parameterName}
                          onChange={(e) =>
                            updateCustomSettingRow(idx, 'parameterName', e.target.value)
                          }
                          placeholder="Parameter name"
                          className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <input
                          type="text"
                          value={row.setpoint}
                          onChange={(e) =>
                            updateCustomSettingRow(idx, 'setpoint', e.target.value)
                          }
                          placeholder="Setpoint"
                          className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="md:col-span-1">
                        <input
                          type="text"
                          value={row.unit}
                          onChange={(e) =>
                            updateCustomSettingRow(idx, 'unit', e.target.value)
                          }
                          placeholder="Unit"
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 text-xs"
                        />
                      </div>
                      <div className="md:col-span-1">
                        <input
                          type="number"
                          step="any"
                          value={row.minLimit}
                          onChange={(e) =>
                            updateCustomSettingRow(idx, 'minLimit', e.target.value)
                          }
                          placeholder="Min"
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="md:col-span-1">
                        <input
                          type="number"
                          step="any"
                          value={row.maxLimit}
                          onChange={(e) =>
                            updateCustomSettingRow(idx, 'maxLimit', e.target.value)
                          }
                          placeholder="Max"
                          className="w-full border border-slate-200 bg-white rounded px-2 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="md:col-span-3">
                        <input
                          type="text"
                          value={row.notes}
                          onChange={(e) =>
                            updateCustomSettingRow(idx, 'notes', e.target.value)
                          }
                          placeholder="Operator / PLC notes"
                          className="w-full border border-slate-200 bg-white rounded px-2.5 py-1.5 text-xs"
                        />
                      </div>
                      <div className="md:col-span-1 flex justify-end">
                        <button
                          type="button"
                          onClick={() =>
                            setCustomSettings((prev) =>
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
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Line &amp; Sanitization Notes
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Sanitation SOP, changeover instructions, or equipment remarks..."
                className="w-full border border-slate-200 rounded px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-teal-600"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setShowEditor(false);
                  setEditingId(null);
                }}
                className="px-3.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded-md"
              >
                {saving
                  ? 'Saving Settings...'
                  : editingId
                    ? 'Update Line & Machine'
                    : 'Save Line & Machine'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Master-Detail Split: Lines List + Selected Machine Setting Sheet */}
      <section className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left List */}
        <div className="xl:col-span-5 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h2 className="text-base font-semibold text-slate-900">
              Plant Lines &amp; Equipment ({filteredLines.length})
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Select a line to edit product categories, operational status, or thermal probe
            </p>
          </div>

          {filteredLines.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm font-medium text-slate-800">
                No production lines match the current filter
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Clear filters or add a new production line and machine configuration.
              </p>
              <button
                type="button"
                onClick={openNewLineForm}
                className="mt-4 inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Line / Machine
              </button>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filteredLines.map((line) => {
                const isSelected = selectedLine?.id === line.id;
                const linkedSensor = line.linkedSensorCode
                  ? sensorByCode.get(line.linkedSensorCode)
                  : undefined;
                return (
                  <div
                    key={line.id}
                    className={`p-4 transition-colors ${
                      isSelected ? 'bg-teal-50/50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => setSelectedLineId(line.id)}
                        className="text-left min-w-0 flex-1"
                      >
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <span className="font-mono font-semibold text-slate-900">
                            {line.lineCode}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{line.category}</span>
                        </div>
                        <div className="mt-0.5 text-sm font-semibold text-slate-900 truncate">
                          {line.lineName}
                        </div>
                        <div className="text-xs text-slate-600 truncate mt-0.5">
                          {line.machineName}
                          {line.machineModel ? ` (${line.machineModel})` : ''}
                        </div>
                      </button>

                      <div className="text-right shrink-0">
                        {renderStatusLabel(line.status)}
                        <div className="mt-1 font-mono text-[11px] text-slate-500 tabular-nums">
                          {line.batchCapacity.toLocaleString()} {line.capacityUnit}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 pt-2.5 border-t border-slate-100">
                      <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums">
                        <span>
                          {line.fillerSpeedUnitsPerMin !== null
                            ? `${line.fillerSpeedUnitsPerMin} u/min`
                            : 'Batch mode'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {line.targetTempC !== null
                            ? `${line.targetTempC.toFixed(1)}°C`
                            : 'Ambient'}
                        </span>
                        {linkedSensor && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span
                              className={
                                linkedSensor.status === 'Excursion'
                                  ? 'text-red-700 font-semibold'
                                  : 'text-slate-700'
                              }
                            >
                              {linkedSensor.sensorCode}{' '}
                              {linkedSensor.currentTempC.toFixed(1)}°C
                            </span>
                          </>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => openEditLineForm(line)}
                          className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900"
                        >
                          <Edit3 className="w-3 h-3" />
                          Edit
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Detail Panel */}
        <div className="xl:col-span-7 space-y-6">
          {selectedLine ? (
            <>
              <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-100">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="font-mono font-semibold text-slate-900">
                        {selectedLine.lineCode}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{selectedLine.category}</span>
                      {selectedLine.machineModel && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">
                            {selectedLine.machineModel}
                          </span>
                        </>
                      )}
                    </div>
                    <h3 className="text-lg font-semibold text-slate-900 mt-0.5">
                      {selectedLine.lineName} — {selectedLine.machineName}
                    </h3>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>
                        Default Crew:{' '}
                        <strong className="text-slate-800">
                          {selectedLine.defaultCrew || 'Unassigned'}
                        </strong>
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => openEditLineForm(selectedLine)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded"
                    >
                      <Sliders className="w-3.5 h-3.5" />
                      Edit All Settings
                    </button>
                    {confirmDeleteId === selectedLine.id ? (
                      <div className="inline-flex items-center gap-2 border border-red-200 bg-red-50 px-2.5 py-1.5 rounded text-xs">
                        <button
                          type="button"
                          onClick={() => void handleDeleteLine(selectedLine)}
                          className="font-semibold text-red-700 hover:text-red-800"
                        >
                          Confirm Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="text-slate-600 hover:text-slate-900"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(selectedLine.id)}
                        className="p-1.5 text-slate-400 hover:text-red-700 border border-slate-200 rounded"
                        title="Delete line configuration"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Inline Editable 1: Product Categories */}
                <div className="bg-[#F7F8FA] border border-slate-200 rounded-md p-3.5 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-800">
                      Product Categories (Click to assign / unassign)
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowCategoriesManager((v) => !v)}
                      className="text-xs font-medium text-teal-700 hover:text-teal-800"
                    >
                      {showCategoriesManager ? 'Done Editing' : 'Edit Categories'}
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {availableCategories.map((cat) => {
                      const active = (
                        selectedLine.supportedProductTypes || []
                      ).includes(cat);
                      return (
                        <button
                          key={cat}
                          type="button"
                          disabled={updatingFieldId === selectedLine.id}
                          onClick={() =>
                            void handleInlineToggleLineCategory(selectedLine, cat)
                          }
                          className={`px-3 py-1 text-xs font-medium rounded border transition-colors ${
                            active
                              ? 'bg-teal-700 border-teal-700 text-white'
                              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          {active ? '✓ ' : '+ '}
                          {cat}
                        </button>
                      );
                    })}
                  </div>

                  {showCategoriesManager && (
                    <div className="pt-2.5 border-t border-slate-200 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={newCategoryDraft}
                          onChange={(e) => setNewCategoryDraft(e.target.value)}
                          placeholder="New category name..."
                          className="border border-slate-200 bg-white rounded px-2.5 py-1 text-xs w-48"
                        />
                        <button
                          type="button"
                          onClick={() => void handleAddCategory(newCategoryDraft)}
                          className="px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                        >
                          + Add Category
                        </button>
                      </div>
                      <div className="space-y-1">
                        {availableCategories.map((cat, idx) => (
                          <div
                            key={`${cat}-${idx}`}
                            className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded px-2.5 py-1.5 text-xs"
                          >
                            {editingCategoryIndex === idx ? (
                              <div className="flex items-center gap-1.5 flex-1">
                                <input
                                  type="text"
                                  value={editingCategoryDraft}
                                  onChange={(e) =>
                                    setEditingCategoryDraft(e.target.value)
                                  }
                                  className="border border-slate-200 rounded px-2 py-0.5 text-xs flex-1"
                                />
                                <button
                                  type="button"
                                  onClick={() => void handleRenameCategory(idx)}
                                  className="font-medium text-teal-700"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingCategoryIndex(null)}
                                  className="text-slate-500"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <>
                                <span className="font-medium text-slate-800">
                                  {cat}
                                </span>
                                <div className="flex items-center gap-3">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingCategoryIndex(idx);
                                      setEditingCategoryDraft(cat);
                                    }}
                                    className="text-slate-600 hover:text-slate-900"
                                  >
                                    Rename
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleRemoveCategory(cat)}
                                    className="text-red-700 hover:text-red-800"
                                  >
                                    Remove
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Inline Editable 2: Operational Status */}
                <div className="bg-[#F7F8FA] border border-slate-200 rounded-md p-3.5 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-semibold text-slate-800">
                        Operational Status:
                      </span>
                      {renderStatusLabel(selectedLine.status)}
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowStatusesManager((v) => !v)}
                      className="text-xs font-medium text-teal-700 hover:text-teal-800"
                    >
                      {showStatusesManager ? 'Done Editing' : 'Edit Statuses'}
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {availableStatuses.map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        disabled={updatingFieldId === selectedLine.id}
                        onClick={() =>
                          void handleQuickStatusChange(selectedLine, opt)
                        }
                        className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                          selectedLine.status === opt
                            ? 'bg-slate-900 text-white'
                            : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>

                  {showStatusesManager && (
                    <div className="pt-2.5 border-t border-slate-200 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={newStatusDraft}
                          onChange={(e) => setNewStatusDraft(e.target.value)}
                          placeholder="New status (e.g. Calibration)..."
                          className="border border-slate-200 bg-white rounded px-2.5 py-1 text-xs w-52"
                        />
                        <button
                          type="button"
                          onClick={() => void handleAddStatus(newStatusDraft)}
                          className="px-2.5 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                        >
                          + Add Status
                        </button>
                      </div>
                      <div className="space-y-1">
                        {availableStatuses.map((st, idx) => (
                          <div
                            key={`${st}-${idx}`}
                            className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded px-2.5 py-1.5 text-xs"
                          >
                            {editingStatusIndex === idx ? (
                              <div className="flex items-center gap-1.5 flex-1">
                                <input
                                  type="text"
                                  value={editingStatusDraft}
                                  onChange={(e) =>
                                    setEditingStatusDraft(e.target.value)
                                  }
                                  className="border border-slate-200 rounded px-2 py-0.5 text-xs flex-1"
                                />
                                <button
                                  type="button"
                                  onClick={() => void handleRenameStatus(idx)}
                                  className="font-medium text-teal-700"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingStatusIndex(null)}
                                  className="text-slate-500"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <>
                                <span className="font-medium text-slate-800">
                                  {st}
                                </span>
                                <div className="flex items-center gap-3">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingStatusIndex(idx);
                                      setEditingStatusDraft(st);
                                    }}
                                    className="text-slate-600 hover:text-slate-900"
                                  >
                                    Rename
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleRemoveStatus(st)}
                                    className="text-red-700 hover:text-red-800"
                                  >
                                    Remove
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Inline Editable 3: Thermal Probe */}
                <div className="bg-[#F7F8FA] border border-slate-200 rounded-md p-3.5 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-800">
                      Linked Thermal Probe
                    </span>
                    <div className="flex items-center gap-3">
                      {selectedProbe && (
                        <button
                          type="button"
                          onClick={() => openEditProbeEditor(selectedProbe)}
                          className="text-xs font-medium text-teal-700 hover:text-teal-800"
                        >
                          Edit Probe
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          openNewProbeEditor(selectedLine.lineName, true)
                        }
                        className="text-xs font-medium text-slate-700 hover:text-slate-900"
                      >
                        + New Probe
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <select
                      value={selectedLine.linkedSensorCode || ''}
                      disabled={updatingFieldId === selectedLine.id}
                      onChange={(e) =>
                        void handleInlineProbeChange(selectedLine, e.target.value)
                      }
                      className="flex-1 min-w-[220px] border border-slate-200 bg-white rounded px-3 py-1.5 text-xs text-slate-800 focus:outline-none focus:border-teal-600"
                    >
                      <option value="">None / Ambient Suite</option>
                      {sensors.map((s) => (
                        <option key={s.id} value={s.sensorCode}>
                          {s.sensorCode} — {s.name} ({s.currentTempC.toFixed(1)}°C)
                        </option>
                      ))}
                    </select>

                    {selectedProbe && (
                      <div className="text-xs font-mono tabular-nums text-slate-700">
                        Live:{' '}
                        <strong
                          className={
                            selectedProbe.status === 'Excursion'
                              ? 'text-red-700'
                              : selectedProbe.status === 'Warning'
                                ? 'text-amber-700'
                                : 'text-emerald-700'
                          }
                        >
                          {selectedProbe.currentTempC.toFixed(1)}°C
                        </strong>{' '}
                        <span className="text-slate-500">
                          (Safe {selectedProbe.minSafeTempC.toFixed(1)}–
                          {selectedProbe.maxSafeTempC.toFixed(1)}°C)
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {selectedLine.status.toLowerCase().includes('maint') && (
                  <div className="flex items-center gap-2 text-xs text-red-800 bg-red-50 border border-red-200 rounded px-3.5 py-2.5">
                    <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" />
                    <span>
                      Line flagged in {selectedLine.status} mode — verify mechanical clearance and calibration before releasing job orders.
                    </span>
                  </div>
                )}

                {/* Core Machine Telemetry & Capacity Setpoints */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div className="bg-[#F7F8FA] border border-slate-200 rounded p-3">
                    <div className="text-[11px] font-medium text-slate-500">
                      Standard Batch Capacity
                    </div>
                    <div className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
                      {selectedLine.batchCapacity.toLocaleString()}{' '}
                      {selectedLine.capacityUnit}
                    </div>
                  </div>
                  <div className="bg-[#F7F8FA] border border-slate-200 rounded p-3">
                    <div className="text-[11px] font-medium text-slate-500">
                      Target Operating Temp
                    </div>
                    <div className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
                      {selectedLine.targetTempC !== null
                        ? `${selectedLine.targetTempC.toFixed(1)} °C`
                        : 'Ambient'}
                    </div>
                  </div>
                  <div className="bg-[#F7F8FA] border border-slate-200 rounded p-3">
                    <div className="text-[11px] font-medium text-slate-500">
                      Agitator / Mixer Speed
                    </div>
                    <div className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
                      {selectedLine.agitatorRpm !== null
                        ? `${selectedLine.agitatorRpm} RPM`
                        : '—'}
                    </div>
                  </div>
                  <div className="bg-[#F7F8FA] border border-slate-200 rounded p-3">
                    <div className="text-[11px] font-medium text-slate-500">
                      Operating Pressure
                    </div>
                    <div className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
                      {selectedLine.pressureBar !== null
                        ? `${selectedLine.pressureBar.toFixed(1)} bar`
                        : '0.0 bar'}
                    </div>
                  </div>
                  <div className="bg-[#F7F8FA] border border-slate-200 rounded p-3">
                    <div className="text-[11px] font-medium text-slate-500">
                      Rated Line Speed
                    </div>
                    <div className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
                      {selectedLine.fillerSpeedUnitsPerMin !== null
                        ? `${selectedLine.fillerSpeedUnitsPerMin} units/min`
                        : 'Batch'}
                    </div>
                  </div>
                  <div className="bg-[#F7F8FA] border border-slate-200 rounded p-3">
                    <div className="text-[11px] font-medium text-slate-500">
                      CIP / Sanitization Cycle
                    </div>
                    <div className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums">
                      Every {selectedLine.cleaningIntervalHours} hrs
                    </div>
                  </div>
                </div>

                {/* Custom Machine Parameters Table */}
                <div>
                  <div className="text-xs font-semibold text-slate-800 mb-2">
                    Machine Parameter Settings ({selectedLine.customSettings?.length || 0})
                  </div>
                  {(selectedLine.customSettings || []).length === 0 ? (
                    <div className="text-xs text-slate-500 border border-dashed border-slate-200 rounded p-4">
                      No custom PLC or mechanical parameters defined. Click &ldquo;Edit All Settings&rdquo; to add parameter tolerances.
                    </div>
                  ) : (
                    <div className="border border-slate-200 rounded overflow-hidden">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                            <th className="py-2 px-3">Parameter</th>
                            <th className="py-2 px-3 text-right">Setpoint</th>
                            <th className="py-2 px-3 text-right">Safe Band</th>
                            <th className="py-2 px-3">Notes</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {selectedLine.customSettings.map((param) => (
                            <tr key={param.id} className="hover:bg-slate-50">
                              <td className="py-2.5 px-3 font-medium text-slate-900">
                                {param.parameterName}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono font-semibold text-teal-800 tabular-nums whitespace-nowrap">
                                {param.setpoint || '—'}
                                {param.unit ? ` ${param.unit}` : ''}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono text-slate-600 tabular-nums whitespace-nowrap">
                                {formatBounds(
                                  param.minLimit,
                                  param.maxLimit,
                                  param.unit
                                )}
                              </td>
                              <td className="py-2.5 px-3 text-slate-600">
                                {param.notes || '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {selectedLine.notes && (
                  <p className="text-xs text-slate-600 bg-[#F7F8FA] border border-slate-200 rounded px-3.5 py-2.5">
                    {selectedLine.notes}
                  </p>
                )}
              </div>

              {/* Batches Scheduled on Selected Line */}
              <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      Batches Assigned to {selectedLine.lineName} ({lineBatches.length})
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Job orders executed or queued on this production line
                    </p>
                  </div>
                </div>

                {lineBatches.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500">
                    No production batches currently scheduled on {selectedLine.lineName}.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                          <th className="py-2.5 px-4">Batch #</th>
                          <th className="py-2.5 px-3">Product</th>
                          <th className="py-2.5 px-3 text-right">Planned</th>
                          <th className="py-2.5 px-3 text-right">Yield %</th>
                          <th className="py-2.5 px-3">Status</th>
                          <th className="py-2.5 px-4 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {lineBatches.map((batch) => (
                          <tr key={batch.id} className="hover:bg-slate-50">
                            <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">
                              {batch.batchNumber}
                            </td>
                            <td className="py-2.5 px-3 text-slate-800">
                              {batch.productName}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-800">
                              {batch.plannedQty.toLocaleString()} {batch.outputUnit}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                              {batch.yieldPct > 0
                                ? `${batch.yieldPct.toFixed(1)}%`
                                : '—'}
                            </td>
                            <td className="py-2.5 px-3 font-medium text-slate-700">
                              {batch.status}
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => onOpenBatch(batch.id)}
                                className="inline-flex items-center gap-1 font-medium text-teal-700 hover:text-teal-800"
                              >
                                Open
                                <ArrowRight className="w-3 h-3" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="bg-white border border-slate-200 rounded-lg p-8 text-center text-xs text-slate-500">
              Select a production line on the left or create a new line configuration.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
