import { useMemo, useState } from 'react';
import {
  CopyPlus,
  Edit3,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sliders,
  Trash2,
  X,
} from 'lucide-react';
import type {
  BomIngredient,
  CategoryParameterPresetMap,
  FormulaBOM,
  RecipeProcessParameter,
  RolePermissionMatrix,
  UnitOfMeasure,
  UserRole,
} from '../types';
import {
  buildCategoryProcessParameters,
  buildDefaultCategoryParameterPresets,
  buildDefaultRecipeProcessParameters,
} from '../data/seedData';
import {
  approveFormulaVersion,
  createFormulaVersion,
  updateCategoryParameterPresets,
  updateFormulaProcessParameters,
  updatePlantOptions,
} from '../services/mesService';
import { hasFeaturePermission } from '../services/permissions';
import { formatCurrency } from '../utils/units';

interface FormulasViewProps {
  ownerId: string;
  userRole: UserRole;
  rolePermissions?: RolePermissionMatrix;
  productCategories?: string[];
  categoryParameterPresets?: CategoryParameterPresetMap;
  formulas: FormulaBOM[];
  onNotify: (msg: string) => void;
}

const PARAMETER_KEY_OPTIONS: { key: string; label: string; defaultUnit: string }[] = [
  { key: 'temperature', label: 'temperature', defaultUnit: '°C' },
  { key: 'ph', label: 'ph', defaultUnit: 'pH' },
  { key: 'brix', label: 'brix', defaultUnit: '%' },
  { key: 'viscosity', label: 'viscosity', defaultUnit: 'cP' },
  { key: 'weight', label: 'weight', defaultUnit: 'kg' },
  { key: 'time', label: 'time', defaultUnit: 'min' },
  { key: 'speed', label: 'speed', defaultUnit: 'RPM' },
  { key: 'pressure', label: 'pressure', defaultUnit: 'bar' },
  { key: 'aw', label: 'aw', defaultUnit: 'aW' },
  { key: 'moisture', label: 'moisture', defaultUnit: '%' },
  { key: 'torque', label: 'torque', defaultUnit: 'Nm' },
  { key: 'custom', label: 'custom', defaultUnit: 'units' },
];

function incrementVersion(ver: string): string {
  const match = ver.match(/^v?(\d+)\.(\d+)$/i);
  if (!match) return `${ver}.1`;
  return `v${match[1]}.${Number(match[2]) + 1}`;
}

function makeNewParam(index: number): RecipeProcessParameter {
  return {
    id: `pp-${Date.now().toString(36)}-${index}`,
    key: 'temperature',
    name: `Custom Parameter ${index + 1}`,
    unit: '°C',
    target: 0,
    min: 0,
    max: 100,
  };
}

export function FormulasView({
  ownerId,
  userRole,
  rolePermissions,
  productCategories = ['Sauce', 'Syrup', 'Powder'],
  categoryParameterPresets,
  formulas,
  onNotify,
}: FormulasViewProps) {
  const availableCategories = useMemo(() => {
    const merged = new Set<string>(
      productCategories.length > 0 ? productCategories : ['Sauce', 'Syrup', 'Powder']
    );
    for (const f of formulas) {
      if (f.category?.trim()) merged.add(f.category.trim());
    }
    return Array.from(merged);
  }, [productCategories, formulas]);

  const resolvedPresets = useMemo<CategoryParameterPresetMap>(() => {
    const base = buildDefaultCategoryParameterPresets(availableCategories);
    if (!categoryParameterPresets) return base;
    return {
      ...base,
      ...categoryParameterPresets,
    };
  }, [availableCategories, categoryParameterPresets]);

  function getParamsForCategory(cat: string): RecipeProcessParameter[] {
    const clean = (cat || availableCategories[0] || 'Sauce').trim();
    const found = resolvedPresets[clean] || buildCategoryProcessParameters(clean);
    return found.map((p) => ({ ...p }));
  }

  const [selectedId, setSelectedId] = useState<string>(formulas[0]?.id || '');
  const [categoryFilter, setCategoryFilter] = useState<string>('All');
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [supersedingId, setSupersedingId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // Category Preset Templates drawer state (BOM Setting page)
  const [showCategoryTemplateEditor, setShowCategoryTemplateEditor] = useState(false);
  const [templateCategory, setTemplateCategory] = useState<string>(
    availableCategories[0] || 'Sauce'
  );
  const [templateDraftParams, setTemplateDraftParams] = useState<RecipeProcessParameter[]>(() =>
    getParamsForCategory(availableCategories[0] || 'Sauce')
  );
  const [newPresetCategoryName, setNewPresetCategoryName] = useState('');

  // Version creator form state
  const [sku, setSku] = useState('SKU-PES-350');
  const [productName, setProductName] = useState('Genovese Basil & Pine Nut Pesto');
  const [formulaCategory, setFormulaCategory] = useState<string>(
    availableCategories[0] || 'Sauce'
  );
  const [packSize, setPackSize] = useState('350g Glass Jar');
  const [shelfLifeDays, setShelfLifeDays] = useState('240');
  const [standardBatchSize, setStandardBatchSize] = useState('800');
  const [outputUnit, setOutputUnit] = useState('jars');
  const [version, setVersion] = useState('v1.0');
  const [isConfidentialOem, setIsConfidentialOem] = useState(false);
  const [oemCustomer, setOemCustomer] = useState('');
  const [laborCost, setLaborCost] = useState('410');
  const [overheadCost, setOverheadCost] = useState('290');
  const [ingredients, setIngredients] = useState<BomIngredient[]>([
    {
      materialCode: 'ING-BAS-03',
      materialName: 'Sweet Basil & Garlic Aromatics',
      anonymizedCode: 'COMP-P1',
      category: 'Ingredient',
      quantityPerBatch: 24,
      unit: 'kg',
      tolerancePct: 1.5,
    },
    {
      materialCode: 'ING-OIL-02',
      materialName: 'Extra Virgin Olive Oil',
      anonymizedCode: 'COMP-P2',
      category: 'Ingredient',
      quantityPerBatch: 110,
      unit: 'L',
      tolerancePct: 1.0,
    },
  ]);
  const [modalParams, setModalParams] = useState<RecipeProcessParameter[]>(() =>
    getParamsForCategory(availableCategories[0] || 'Sauce')
  );

  // Inline recipe category + process parameter spec editor
  const [editingParamsFormulaId, setEditingParamsFormulaId] = useState<string | null>(null);
  const [draftFormulaCategory, setDraftFormulaCategory] = useState<string>('Sauce');
  const [draftParams, setDraftParams] = useState<RecipeProcessParameter[]>([]);

  const canManageFormulas = hasFeaturePermission(
    rolePermissions,
    userRole,
    'manageFormulasBom'
  );
  const canViewConfidentialOem = hasFeaturePermission(
    rolePermissions,
    userRole,
    'viewConfidentialOem'
  );

  const visibleFormulas = useMemo(() => {
    if (categoryFilter === 'All') return formulas;
    return formulas.filter(
      (f) => (f.category || 'Sauce').toLowerCase() === categoryFilter.toLowerCase()
    );
  }, [formulas, categoryFilter]);

  const selectedFormula = useMemo(
    () =>
      visibleFormulas.find((f) => f.id === selectedId) ||
      visibleFormulas[0] ||
      formulas.find((f) => f.id === selectedId) ||
      formulas[0] ||
      null,
    [visibleFormulas, formulas, selectedId]
  );

  const selectedProcessParams = useMemo(() => {
    if (!selectedFormula) return [];
    if (selectedFormula.processParameters && selectedFormula.processParameters.length > 0) {
      return selectedFormula.processParameters;
    }
    return buildDefaultRecipeProcessParameters(
      `${selectedFormula.sku} ${selectedFormula.productName}`,
      selectedFormula.category || ''
    );
  }, [selectedFormula]);

  const isMasked = Boolean(
    !canViewConfidentialOem && selectedFormula?.isConfidentialOem
  );

  function openNewVersionFromExisting(base: FormulaBOM) {
    const baseCategory = base.category || availableCategories[0] || 'Sauce';
    setSupersedingId(base.approvalStatus === 'Approved' ? base.id : undefined);
    setSku(base.sku);
    setProductName(base.productName);
    setFormulaCategory(baseCategory);
    setPackSize(base.packSize);
    setShelfLifeDays(String(base.shelfLifeDays));
    setStandardBatchSize(String(base.standardBatchSize));
    setOutputUnit(base.outputUnit);
    setVersion(incrementVersion(base.version));
    setIsConfidentialOem(base.isConfidentialOem);
    setOemCustomer(base.oemCustomer);
    setLaborCost(String(base.laborCostPerBatch));
    setOverheadCost(String(base.overheadCostPerBatch));
    setIngredients(base.ingredients.map((i) => ({ ...i })));
    setModalParams(
      (base.processParameters && base.processParameters.length > 0
        ? base.processParameters
        : getParamsForCategory(baseCategory)
      ).map((p) => ({ ...p }))
    );
    setShowVersionModal(true);
  }

  function openBrandNewFormula() {
    const defaultCat = availableCategories[0] || 'Sauce';
    setSupersedingId(undefined);
    setSku('SKU-PES-350');
    setProductName('Genovese Basil & Pine Nut Pesto');
    setFormulaCategory(defaultCat);
    setPackSize('350g Glass Jar');
    setShelfLifeDays('240');
    setStandardBatchSize('800');
    setOutputUnit('jars');
    setVersion('v1.0');
    setIsConfidentialOem(false);
    setOemCustomer('');
    setLaborCost('410');
    setOverheadCost('290');
    setIngredients([
      {
        materialCode: 'ING-BAS-03',
        materialName: 'Sweet Basil & Garlic Aromatics',
        anonymizedCode: 'COMP-P1',
        category: 'Ingredient',
        quantityPerBatch: 24,
        unit: 'kg',
        tolerancePct: 1.5,
      },
      {
        materialCode: 'ING-OIL-02',
        materialName: 'Extra Virgin Olive Oil',
        anonymizedCode: 'COMP-P2',
        category: 'Ingredient',
        quantityPerBatch: 110,
        unit: 'L',
        tolerancePct: 1.0,
      },
    ]);
    setModalParams(getParamsForCategory(defaultCat));
    setShowVersionModal(true);
  }

  function handleSelectTemplateCategory(nextCat: string) {
    setTemplateCategory(nextCat);
    setTemplateDraftParams(getParamsForCategory(nextCat));
  }

  async function handleAddPresetCategory() {
    const clean = newPresetCategoryName.trim().slice(0, 40);
    if (!clean) return;
    if (availableCategories.some((c) => c.toLowerCase() === clean.toLowerCase())) {
      handleSelectTemplateCategory(
        availableCategories.find((c) => c.toLowerCase() === clean.toLowerCase()) || clean
      );
      setNewPresetCategoryName('');
      return;
    }
    setBusy(true);
    try {
      const nextList = [...availableCategories, clean];
      await updatePlantOptions({ productCategories: nextList });
      setNewPresetCategoryName('');
      setTemplateCategory(clean);
      setTemplateDraftParams(buildCategoryProcessParameters(clean));
      onNotify(`Added preset category "${clean}" for BOM & parameter templates.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to add preset category.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveCategoryTemplate() {
    setBusy(true);
    try {
      const nextMap: CategoryParameterPresetMap = {
        ...resolvedPresets,
        [templateCategory]: templateDraftParams.map((p) => ({ ...p })),
      };
      await updateCategoryParameterPresets(nextMap);
      onNotify(
        `Saved ${templateDraftParams.length} parameter(s) to preset category "${templateCategory}".`
      );
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Unable to save category parameter template.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveVersion(approvalStatus: 'Draft' | 'Approved') {
    setBusy(true);
    try {
      const baseRouting = selectedFormula?.routingSteps || [
        {
          stepNumber: 1,
          name: 'Cold Blending & Standardization',
          targetDurationMin: 20,
          targetTempC: 12,
          minTempC: 6,
          maxTempC: 18,
          targetBrix: null,
          targetPh: 4.5,
          targetWeightG: null,
          equipment: 'Kettle Line 1',
        },
        {
          stepNumber: 2,
          name: 'Filling & Vacuum Capping',
          targetDurationMin: 25,
          targetTempC: 15,
          minTempC: 10,
          maxTempC: 22,
          targetBrix: null,
          targetPh: 4.5,
          targetWeightG: 355,
          equipment: 'Rotary Filler A',
        },
      ];

      const newId = await createFormulaVersion(
        ownerId,
        {
          sku,
          productName,
          category: formulaCategory,
          packSize,
          shelfLifeDays: Number(shelfLifeDays) || 180,
          standardBatchSize: Number(standardBatchSize) || 500,
          outputUnit,
          version,
          approvalStatus,
          isConfidentialOem,
          oemCustomer,
          laborCostPerBatch: Number(laborCost) || 0,
          overheadCostPerBatch: Number(overheadCost) || 0,
          ingredients,
          routingSteps: baseRouting,
          processParameters: modalParams,
        },
        supersedingId
      );
      setSelectedId(newId);
      setShowVersionModal(false);
      onNotify(
        `Saved ${sku} ${version} [${formulaCategory}] (${approvalStatus}). Previous versions preserved immutably.`
      );
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Unable to save formula version.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveInlineProcessParams() {
    if (!selectedFormula) return;
    if (draftParams.length === 0) {
      onNotify('Keep at least one process parameter before saving.');
      return;
    }
    setBusy(true);
    try {
      await updateFormulaProcessParameters(
        selectedFormula.id,
        draftParams,
        draftFormulaCategory
      );
      setEditingParamsFormulaId(null);
      onNotify(
        `Saved category "${draftFormulaCategory}" & ${draftParams.length} parameter(s) for ${selectedFormula.sku} ${selectedFormula.version}.`
      );
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Unable to save recipe parameters.');
    } finally {
      setBusy(false);
    }
  }

  async function handleApproveDraft(formula: FormulaBOM) {
    const prevApproved = formulas.find(
      (f) => f.sku === formula.sku && f.approvalStatus === 'Approved' && f.id !== formula.id
    );
    setBusy(true);
    try {
      await approveFormulaVersion(formula.id, prevApproved?.id);
      onNotify(
        `Approved ${formula.sku} ${formula.version}${
          prevApproved ? ` and archived ${prevApproved.version}` : ''
        }.`
      );
    } finally {
      setBusy(false);
    }
  }

  function renderEditableParamTable(
    paramsList: RecipeProcessParameter[],
    setParamsList: (next: RecipeProcessParameter[]) => void,
    borderTone = 'border-teal-200'
  ) {
    return (
      <div className={`overflow-x-auto border ${borderTone} rounded-md bg-white`}>
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
              <th className="py-2 px-2.5 min-w-[140px]">Parameter Name</th>
              <th className="py-2 px-2 min-w-[110px]">Key</th>
              <th className="py-2 px-2 w-20">Unit</th>
              <th className="py-2 px-2 text-right w-24">Min</th>
              <th className="py-2 px-2 text-right w-24">Target</th>
              <th className="py-2 px-2 text-right w-24">Max</th>
              <th className="py-2 px-2 text-center w-10">Del</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {paramsList.map((param, idx) => (
              <tr key={param.id || idx}>
                <td className="py-1.5 px-2.5">
                  <input
                    type="text"
                    value={param.name}
                    onChange={(e) => {
                      const next = [...paramsList];
                      next[idx] = { ...param, name: e.target.value };
                      setParamsList(next);
                    }}
                    className="w-full border border-slate-200 rounded px-2 py-1 text-xs font-medium text-slate-900"
                    placeholder="Parameter Name"
                  />
                </td>
                <td className="py-1.5 px-2">
                  <select
                    value={
                      PARAMETER_KEY_OPTIONS.some((k) => k.key === param.key)
                        ? param.key
                        : 'custom'
                    }
                    onChange={(e) => {
                      const chosenKey = e.target.value;
                      const match = PARAMETER_KEY_OPTIONS.find((k) => k.key === chosenKey);
                      const next = [...paramsList];
                      next[idx] = {
                        ...param,
                        key: chosenKey === 'custom' ? param.key || 'custom_param' : chosenKey,
                        unit: param.unit || match?.defaultUnit || '',
                      };
                      setParamsList(next);
                    }}
                    className="w-full border border-slate-200 rounded px-1.5 py-1 text-xs font-mono bg-white"
                  >
                    {PARAMETER_KEY_OPTIONS.map((opt) => (
                      <option key={opt.key} value={opt.key}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1.5 px-2">
                  <input
                    type="text"
                    value={param.unit}
                    onChange={(e) => {
                      const next = [...paramsList];
                      next[idx] = { ...param, unit: e.target.value };
                      setParamsList(next);
                    }}
                    className="w-full border border-slate-200 rounded px-2 py-1 text-xs font-mono"
                    placeholder="Unit"
                  />
                </td>
                <td className="py-1.5 px-2 text-right">
                  <input
                    type="number"
                    step="any"
                    value={param.min ?? ''}
                    onChange={(e) => {
                      const next = [...paramsList];
                      next[idx] = {
                        ...param,
                        min: e.target.value === '' ? null : Number(e.target.value),
                      };
                      setParamsList(next);
                    }}
                    className="w-20 border border-slate-200 rounded px-2 py-1 text-xs font-mono text-right"
                  />
                </td>
                <td className="py-1.5 px-2 text-right">
                  <input
                    type="number"
                    step="any"
                    value={param.target ?? ''}
                    onChange={(e) => {
                      const next = [...paramsList];
                      next[idx] = {
                        ...param,
                        target: e.target.value === '' ? null : Number(e.target.value),
                      };
                      setParamsList(next);
                    }}
                    className="w-20 border border-slate-200 rounded px-2 py-1 text-xs font-mono text-right font-semibold text-teal-800"
                  />
                </td>
                <td className="py-1.5 px-2 text-right">
                  <input
                    type="number"
                    step="any"
                    value={param.max ?? ''}
                    onChange={(e) => {
                      const next = [...paramsList];
                      next[idx] = {
                        ...param,
                        max: e.target.value === '' ? null : Number(e.target.value),
                      };
                      setParamsList(next);
                    }}
                    className="w-20 border border-slate-200 rounded px-2 py-1 text-xs font-mono text-right"
                  />
                </td>
                <td className="py-1.5 px-2 text-center">
                  <button
                    type="button"
                    disabled={paramsList.length <= 1}
                    onClick={() =>
                      setParamsList(paramsList.filter((_, i) => i !== idx))
                    }
                    className="p-1 text-slate-400 hover:text-red-600 disabled:opacity-30"
                    title="Remove parameter"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="p-2 bg-[#F7F8FA] border-t border-slate-200 flex justify-between items-center">
          <span className="text-[11px] text-slate-500">
            All parameter fields (Name, Key, Unit, Min, Target, Max) are editable.
          </span>
          <button
            type="button"
            onClick={() =>
              setParamsList([...paramsList, makeNewParam(paramsList.length)])
            }
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-teal-800 bg-white border border-teal-300 hover:bg-teal-50 rounded"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Parameter
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-slate-600">
            Immutable recipe versioning ensures historical batch records always trace to the exact
            BOM, preset category, and editable parameter targets approved at production time.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCategoryTemplateEditor((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md border whitespace-nowrap ${
              showCategoryTemplateEditor
                ? 'bg-teal-50 border-teal-600 text-teal-800'
                : 'bg-white border-slate-300 text-slate-700 hover:border-teal-600'
            }`}
          >
            <Sliders className="w-4 h-4 text-teal-700" />
            Category Parameter Presets
          </button>
          {canManageFormulas && (
            <button
              type="button"
              onClick={openBrandNewFormula}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              New Product Formula
            </button>
          )}
        </div>
      </div>

      {/* Category Parameter Templates Editor (Requirement 3 & 4) */}
      {showCategoryTemplateEditor && (
        <div className="bg-white border border-teal-200 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <Layers className="w-4 h-4 text-teal-700" />
                BOM Preset Categories &amp; Editable Parameter Templates
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Choose a preset category below to edit every parameter (Name, Key, Unit, Min, Target, Max) applied when BOM formulas select that category.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canManageFormulas && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={newPresetCategoryName}
                    onChange={(e) => setNewPresetCategoryName(e.target.value)}
                    placeholder="New category (e.g. Dressing)"
                    className="border border-slate-200 rounded px-2.5 py-1.5 text-xs"
                  />
                  <button
                    type="button"
                    disabled={busy || !newPresetCategoryName.trim()}
                    onClick={() => void handleAddPresetCategory()}
                    className="px-2.5 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded hover:bg-teal-100 disabled:opacity-50"
                  >
                    + Add Category
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => setShowCategoryTemplateEditor(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-slate-600">Select Preset Category:</span>
            {availableCategories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => handleSelectTemplateCategory(cat)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors ${
                  templateCategory === cat
                    ? 'bg-teal-700 text-white border-teal-700'
                    : 'bg-[#F7F8FA] text-slate-700 border-slate-200 hover:border-teal-500'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {canManageFormulas ? (
            <>
              {renderEditableParamTable(templateDraftParams, setTemplateDraftParams)}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setTemplateDraftParams(buildCategoryProcessParameters(templateCategory))
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded hover:bg-slate-50"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Restore &ldquo;{templateCategory}&rdquo; Factory Defaults
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSaveCategoryTemplate()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save &ldquo;{templateCategory}&rdquo; Parameter Preset
                </button>
              </div>
            </>
          ) : (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
              Active role ({userRole}) has read-only BOM view. Enable &ldquo;Manage BOM, Categories &amp; Parameters&rdquo; in Role Permissions to edit category parameter presets.
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left List of Formula Versions with Preset Category filter */}
        <div className="xl:col-span-4 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 space-y-2">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Product Master &amp; Versions</span>
              <span>Status</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {['All', ...availableCategories].map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-2 py-0.5 text-[11px] font-medium rounded border ${
                    categoryFilter === cat
                      ? 'bg-teal-700 text-white border-teal-700'
                      : 'bg-[#F7F8FA] text-slate-600 border-slate-200 hover:border-teal-500'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
          <div className="divide-y divide-slate-100">
            {visibleFormulas.map((f) => {
              const active = selectedFormula?.id === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setSelectedId(f.id)}
                  className={`w-full text-left px-4 py-3.5 transition-colors flex items-start justify-between gap-3 ${
                    active ? 'bg-teal-50/70' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-semibold text-slate-900">{f.sku}</span>
                      <span className="font-mono text-slate-500">{f.version}</span>
                      <span className="px-1.5 py-0.2 bg-slate-100 text-slate-700 rounded text-[10px] font-semibold">
                        {f.category || 'Sauce'}
                      </span>
                      {f.isConfidentialOem && <Lock className="w-3 h-3 text-amber-700" />}
                    </div>
                    <div className="mt-0.5 text-sm font-medium text-slate-900 truncate">
                      {f.productName}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {f.packSize} · Batch {f.standardBatchSize} {f.outputUnit}
                    </div>
                  </div>
                  <span
                    className={`text-xs font-medium shrink-0 ${
                      f.approvalStatus === 'Approved'
                        ? 'text-emerald-700'
                        : f.approvalStatus === 'Draft'
                          ? 'text-amber-700'
                          : 'text-slate-400'
                    }`}
                  >
                    {f.approvalStatus}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Detail Panel */}
        <div className="xl:col-span-8 bg-white border border-slate-200 rounded-lg overflow-hidden">
          {!selectedFormula ? (
            <div className="p-10 text-center text-sm text-slate-500">
              Select a formula version to inspect its BOM, preset category, and parameters.
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              <div className="p-5 flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono font-semibold text-slate-900">
                      {selectedFormula.sku}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono">{selectedFormula.version}</span>
                    <span aria-hidden="true">·</span>
                    <span className="px-2 py-0.5 rounded bg-teal-50 text-teal-800 border border-teal-200 font-semibold">
                      Category: {selectedFormula.category || 'Sauce'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span
                      className={
                        selectedFormula.approvalStatus === 'Approved'
                          ? 'text-emerald-700 font-medium'
                          : 'text-slate-600'
                      }
                    >
                      {selectedFormula.approvalStatus}
                    </span>
                  </div>
                  <h2 className="mt-1 text-lg font-semibold text-slate-900">
                    {selectedFormula.productName}
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-600">
                    Pack: {selectedFormula.packSize} · Shelf life: {selectedFormula.shelfLifeDays}{' '}
                    days · Standard batch: {selectedFormula.standardBatchSize}{' '}
                    {selectedFormula.outputUnit}
                  </p>
                </div>

                {canManageFormulas && (
                  <div className="flex items-center gap-2">
                    {selectedFormula.approvalStatus === 'Draft' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleApproveDraft(selectedFormula)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-md whitespace-nowrap"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        Approve Version
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openNewVersionFromExisting(selectedFormula)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 text-slate-700 hover:bg-slate-50 rounded-md whitespace-nowrap"
                    >
                      <CopyPlus className="w-3.5 h-3.5" />
                      Create New Version
                    </button>
                  </div>
                )}
              </div>

              {isMasked && (
                <div className="px-5 py-3 bg-amber-50/70 text-xs text-amber-900 flex items-center gap-2">
                  <Lock className="w-4 h-4 text-amber-700 shrink-0" />
                  <span>
                    OEM Confidentiality Active ({selectedFormula.oemCustomer}): Active role
                    displays weigh codes and target tolerances only — proprietary ingredients are
                    redacted.
                  </span>
                </div>
              )}

              {/* BOM Table */}
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Bill of Materials (Per {selectedFormula.standardBatchSize}{' '}
                    {selectedFormula.outputUnit})
                  </h3>
                  <span className="font-mono text-xs text-slate-500">
                    Labor {formatCurrency(selectedFormula.laborCostPerBatch)} · Overhead{' '}
                    {formatCurrency(selectedFormula.overheadCostPerBatch)}
                  </span>
                </div>

                <div className="overflow-x-auto border border-slate-200 rounded-md">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                        <th className="py-2 px-3">Code</th>
                        <th className="py-2 px-3">Ingredient / Packaging</th>
                        <th className="py-2 px-3">Category</th>
                        <th className="py-2 px-3 text-right">Target Qty</th>
                        <th className="py-2 px-3 text-right">Weigh Tolerance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedFormula.ingredients.map((ing) => (
                        <tr key={ing.materialCode}>
                          <td className="py-2.5 px-3 font-mono font-semibold text-slate-900">
                            {isMasked ? ing.anonymizedCode : ing.materialCode}
                          </td>
                          <td className="py-2.5 px-3 text-slate-800">
                            {isMasked
                              ? `Confidential Weigh Component (${ing.anonymizedCode})`
                              : ing.materialName}
                          </td>
                          <td className="py-2.5 px-3 text-slate-500">{ing.category}</td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums font-medium text-slate-900">
                            {ing.quantityPerBatch} {ing.unit}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                            ±{ing.tolerancePct}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Recipe Process Parameter Specs (Preset Category + All Editable Parameters) */}
              <div className="p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      EBR Process Parameter Targets (Preset Category:{' '}
                      <span className="text-teal-800">
                        {editingParamsFormulaId === selectedFormula.id
                          ? draftFormulaCategory
                          : selectedFormula.category || 'Sauce'}
                      </span>
                      )
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Choose a preset category or customize every parameter (Name, Key, Unit, Min, Target, Max) enforced during Step 5 execution.
                    </p>
                  </div>
                  {canManageFormulas && (
                    editingParamsFormulaId === selectedFormula.id ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingParamsFormulaId(null)}
                          className="px-2.5 py-1 text-xs text-slate-600 border border-slate-200 rounded"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleSaveInlineProcessParams()}
                          className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded"
                        >
                          <Save className="w-3.5 h-3.5" />
                          Save Category &amp; Parameters
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setDraftFormulaCategory(
                            selectedFormula.category || availableCategories[0] || 'Sauce'
                          );
                          setDraftParams(selectedProcessParams.map((p) => ({ ...p })));
                          setEditingParamsFormulaId(selectedFormula.id);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-slate-300 text-slate-700 hover:bg-slate-50 rounded"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        Edit Category &amp; Parameters
                      </button>
                    )
                  )}
                </div>

                {editingParamsFormulaId === selectedFormula.id ? (
                  <div className="space-y-3">
                    <div className="p-3 bg-[#F7F8FA] border border-slate-200 rounded-md flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="text-xs font-semibold text-slate-700">
                          Preset Category:
                        </label>
                        <select
                          value={draftFormulaCategory}
                          onChange={(e) => {
                            const nextCat = e.target.value;
                            setDraftFormulaCategory(nextCat);
                            setDraftParams(getParamsForCategory(nextCat));
                          }}
                          className="border border-slate-300 rounded px-2.5 py-1.5 text-xs font-semibold bg-white"
                        >
                          {availableCategories.map((cat) => (
                            <option key={cat} value={cat}>
                              {cat}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setDraftParams(getParamsForCategory(draftFormulaCategory))
                        }
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded hover:bg-teal-100"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Load &ldquo;{draftFormulaCategory}&rdquo; Preset Parameters
                      </button>
                    </div>
                    {renderEditableParamTable(draftParams, setDraftParams)}
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-slate-200 rounded-md">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                          <th className="py-2 px-3">Parameter</th>
                          <th className="py-2 px-3">Key</th>
                          <th className="py-2 px-3 text-right">Min</th>
                          <th className="py-2 px-3 text-right">Target</th>
                          <th className="py-2 px-3 text-right">Max</th>
                          <th className="py-2 px-3">Unit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {selectedProcessParams.map((param) => (
                          <tr key={param.id}>
                            <td className="py-2 px-3 font-medium text-slate-900">{param.name}</td>
                            <td className="py-2 px-3 font-mono text-slate-500">{param.key}</td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-700">
                              {param.min !== null ? param.min : '—'}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums font-semibold text-teal-800">
                              {param.target !== null ? param.target : '—'}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-700">
                              {param.max !== null ? param.max : '—'}
                            </td>
                            <td className="py-2 px-3 font-mono text-slate-600">{param.unit}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Routing Steps Table */}
              <div className="p-5 space-y-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  Process Routing &amp; HACCP Target Settings
                </h3>
                <div className="overflow-x-auto border border-slate-200 rounded-md">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#F7F8FA] border-b border-slate-200 text-slate-500 font-medium">
                        <th className="py-2 px-3">Step</th>
                        <th className="py-2 px-3">Equipment</th>
                        <th className="py-2 px-3 text-right">Duration</th>
                        <th className="py-2 px-3 text-right">Target Temp</th>
                        <th className="py-2 px-3 text-right">Brix / pH</th>
                        <th className="py-2 px-3 text-right">Fill Weight</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedFormula.routingSteps.map((step) => (
                        <tr key={step.stepNumber}>
                          <td className="py-2.5 px-3 font-medium text-slate-900">
                            {step.stepNumber}. {step.name}
                          </td>
                          <td className="py-2.5 px-3 text-slate-600">{step.equipment}</td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                            {step.targetDurationMin} min
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                            {step.targetTempC !== null
                              ? `${step.targetTempC}°C (${step.minTempC}–${step.maxTempC})`
                              : '—'}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                            {step.targetBrix !== null ? `${step.targetBrix}°Bx` : '—'} /{' '}
                            {step.targetPh !== null ? step.targetPh : '—'}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                            {step.targetWeightG !== null ? `${step.targetWeightG}g` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create New Formula / Version Modal (with Preset Category & Full Parameter Editor) */}
      {showVersionModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-3xl w-full max-h-[92vh] overflow-y-auto p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                {supersedingId
                  ? `Create New Recipe Version (${version})`
                  : 'Create Product Formula / BOM'}
              </h3>
              <button
                type="button"
                onClick={() => setShowVersionModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Preset Category
                </label>
                <select
                  value={formulaCategory}
                  onChange={(e) => {
                    const nextCat = e.target.value;
                    setFormulaCategory(nextCat);
                    setModalParams(getParamsForCategory(nextCat));
                  }}
                  className="w-full border border-teal-300 bg-teal-50/40 rounded px-2.5 py-1.5 text-sm font-semibold text-slate-900"
                >
                  {availableCategories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">SKU</label>
                <input
                  type="text"
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Version</label>
                <input
                  type="text"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Pack Size</label>
                <input
                  type="text"
                  value={packSize}
                  onChange={(e) => setPackSize(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Product Name</label>
              <input
                type="text"
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Batch Size</label>
                <input
                  type="number"
                  value={standardBatchSize}
                  onChange={(e) => setStandardBatchSize(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Unit</label>
                <input
                  type="text"
                  value={outputUnit}
                  onChange={(e) => setOutputUnit(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Shelf Life (d)
                </label>
                <input
                  type="number"
                  value={shelfLifeDays}
                  onChange={(e) => setShelfLifeDays(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Labor ($)</label>
                <input
                  type="number"
                  value={laborCost}
                  onChange={(e) => setLaborCost(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Overhead ($)</label>
                <input
                  type="number"
                  value={overheadCost}
                  onChange={(e) => setOverheadCost(e.target.value)}
                  className="w-full border border-slate-200 rounded px-2.5 py-1.5 text-sm font-mono"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-1">
              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={isConfidentialOem}
                  onChange={(e) => setIsConfidentialOem(e.target.checked)}
                  className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
                />
                OEM Confidential Mode (hide recipe names from roles without OEM access)
              </label>
              {isConfidentialOem && (
                <input
                  type="text"
                  value={oemCustomer}
                  onChange={(e) => setOemCustomer(e.target.value)}
                  placeholder="OEM Customer Name"
                  className="border border-slate-200 rounded px-2.5 py-1 text-xs"
                />
              )}
            </div>

            {/* Editable BOM Ingredients */}
            <div className="space-y-2 pt-2 border-t border-slate-200">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800">BOM Ingredients</span>
                <button
                  type="button"
                  onClick={() =>
                    setIngredients((prev) => [
                      ...prev,
                      {
                        materialCode: `ING-NEW-0${prev.length + 1}`,
                        materialName: 'New Ingredient',
                        anonymizedCode: `COMP-0${prev.length + 1}`,
                        category: 'Ingredient',
                        quantityPerBatch: 10,
                        unit: 'kg',
                        tolerancePct: 1.5,
                      },
                    ])
                  }
                  className="text-xs font-medium text-teal-700 hover:text-teal-800"
                >
                  + Add BOM Line
                </button>
              </div>
              {ingredients.map((ing, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                  <input
                    type="text"
                    value={ing.materialCode}
                    onChange={(e) => {
                      const next = [...ingredients];
                      next[idx] = { ...ing, materialCode: e.target.value };
                      setIngredients(next);
                    }}
                    className="col-span-3 border border-slate-200 rounded px-2 py-1 text-xs font-mono"
                    placeholder="Code"
                  />
                  <input
                    type="text"
                    value={ing.materialName}
                    onChange={(e) => {
                      const next = [...ingredients];
                      next[idx] = { ...ing, materialName: e.target.value };
                      setIngredients(next);
                    }}
                    className="col-span-4 border border-slate-200 rounded px-2 py-1 text-xs"
                    placeholder="Material name"
                  />
                  <input
                    type="number"
                    step="0.1"
                    value={ing.quantityPerBatch}
                    onChange={(e) => {
                      const next = [...ingredients];
                      next[idx] = { ...ing, quantityPerBatch: Number(e.target.value) };
                      setIngredients(next);
                    }}
                    className="col-span-2 border border-slate-200 rounded px-2 py-1 text-xs font-mono text-right"
                  />
                  <select
                    value={ing.unit}
                    onChange={(e) => {
                      const next = [...ingredients];
                      next[idx] = { ...ing, unit: e.target.value as UnitOfMeasure };
                      setIngredients(next);
                    }}
                    className="col-span-2 border border-slate-200 rounded px-1.5 py-1 text-xs font-mono bg-white"
                  >
                    <option value="kg">kg</option>
                    <option value="g">g</option>
                    <option value="L">L</option>
                    <option value="ml">ml</option>
                    <option value="pcs">pcs</option>
                  </select>
                  <button
                    type="button"
                    onClick={() =>
                      setIngredients((prev) => prev.filter((_, i) => i !== idx))
                    }
                    className="col-span-1 text-xs text-slate-400 hover:text-red-600 text-center"
                  >
                    <X className="w-3.5 h-3.5 mx-auto" />
                  </button>
                </div>
              ))}
            </div>

            {/* Editable Process Parameters upon Selected Preset Category */}
            <div className="space-y-2 pt-2 border-t border-slate-200">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-800">
                  Category Process Parameters ({formulaCategory}) — All Editable
                </span>
                <button
                  type="button"
                  onClick={() => setModalParams(getParamsForCategory(formulaCategory))}
                  className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-800"
                >
                  <RefreshCw className="w-3 h-3" />
                  Reset to {formulaCategory} Preset
                </button>
              </div>
              {renderEditableParamTable(modalParams, setModalParams, 'border-slate-200')}
            </div>

            <div className="pt-3 flex items-center justify-end gap-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowVersionModal(false)}
                className="px-4 py-2 text-xs font-medium text-slate-600"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSaveVersion('Draft')}
                className="px-3.5 py-2 text-xs font-medium border border-slate-300 text-slate-700 hover:bg-slate-50 rounded-md"
              >
                Save as Draft
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSaveVersion('Approved')}
                className="px-4 py-2 text-xs font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md"
              >
                Save &amp; Approve Version
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
