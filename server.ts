import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth, type AuthRequest } from './src/middleware/auth.ts';
import {
  authenticateSqlUser,
  getSqlAuthStats,
  getSqlUserSummary,
  registerSqlUser,
  updateSqlUserPassword,
  verifySqlSessionToken,
} from './src/lib/sqlAuth.ts';
import {
  clearOverrideDbConnectionConfig,
  ensureRemoteSqlSchemaApplied,
  getActiveDbConnectionConfig,
  getPublicDbConnectionConfig,
  saveOverrideDbConnectionConfig,
  testSqlConnection,
  validateRemoteIpDbInput,
} from './src/db/connectionConfig.ts';
import { reconfigureDbPool } from './src/db/index.ts';
import {
  listBatchesOrdered,
  listFinishedGoodsOrdered,
  listFormulasOrdered,
  listProductionLinesOrdered,
  listRawMaterialsOrdered,
  listSensorsOrdered,
} from './src/services/sqlService.ts';
import {
  ForbiddenError,
  ValidationError,
  adjustRawMaterialLotDb,
  allocateMaterialLotDb,
  approveFormulaVersionDb,
  closeProductionBatchDb,
  createBatchCheckRecordDb,
  createFormulaVersionDb,
  createSensorMaintenanceLogDb,
  createWorkOrderDb,
  deleteBatchCheckRecordDb,
  deleteBatchCheckSpecDb,
  deleteProcessCheckDb,
  deleteProductionLineDb,
  deleteRawMaterialLotDb,
  deleteSensorMaintenanceLogDb,
  deleteThermalSensorDb,
  executeQcDecisionDb,
  getActorContextDb,
  getBatchAuditLogsDb,
  getBatchCategoryCompletionDb,
  getBatchYieldTrendsDb,
  getFinishedGoodGenealogyDb,
  getSensorMaintenanceLogsDb,
  getWorkspaceSnapshot,
  importWmsFinishedGoodsDb,
  importWmsRawMaterialsDb,
  ingestSensorReadingsDb,
  issueMaterialLotDb,
  receiveRawMaterialLotDb,
  recordCustomerShipmentDb,
  recordProcessCheckDb,
  releaseWorkOrderDb,
  replenishRawMaterialLotDb,
  reportBatchOutputDb,
  runAvailabilityCheckDb,
  startQcReviewDb,
  updateBatchCheckRecordDb,
  updateBatchHeaderDb,
  updateCategoryParameterPresetsDb,
  updateFormulaProcessParametersDb,
  updateIssuedMaterialLotDb,
  updatePlantOptionsDb,
  updateProcessCheckDb,
  updateProductionLineStatusDb,
  updateRolePermissionsDb,
  updateSensorConfigDb,
  updateThermalSensorDb,
  updateUserRoleDb,
  updateWmsConfigDb,
  upsertBatchCheckSpecDb,
  upsertProductionLineDb,
  upsertThermalSensorDb,
} from './src/db/repository.ts';

async function resolveActor(req: AuthRequest) {
  return getActorContextDb(req.user!.uid, req.user!.email, req.user!.name);
}

function handleRouteError(res: express.Response, error: unknown, fallback: string) {
  if (error instanceof ForbiddenError) {
    res.status(403).json({ error: error.message });
    return;
  }
  if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  const msg = error instanceof Error ? error.message : fallback;
  const isValidation =
    msg.includes('requires') ||
    msg.includes('required') ||
    msg.includes('must be read') ||
    msg.includes('reason code') ||
    msg.includes('Step 5') ||
    msg.includes('not found');
  res.status(isValidation ? 400 : 500).json({ error: msg });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  app.use(express.json({ limit: '2mb' }));

  // --- Pure SQL Authentication & Desktop SQL IP Config Routes ---

  async function canManageDbSettings(req: express.Request): Promise<boolean> {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split('Bearer ')[1];
      const principal = verifySqlSessionToken(token);
      if (principal) {
        const actor = await getActorContextDb(principal.uid, principal.email, principal.name);
        return actor.role === 'admin' || actor.role === 'manager';
      }
    }
    const stats = await getSqlAuthStats();
    if (stats.sqlUsersCount === 0) return true;
    const remote = req.socket?.remoteAddress || req.ip || '';
    return (
      remote === '127.0.0.1' ||
      remote === '::1' ||
      remote === '::ffff:127.0.0.1'
    );
  }

  app.get('/api/auth/status', async (_req, res) => {
    try {
      const stats = await getSqlAuthStats();
      res.json({
        authMode: 'sql',
        sqlUsersCount: stats.sqlUsersCount,
        hasPasswordedUsers: stats.hasPasswordedUsers,
        legacySsoAvailable: false,
        dbConfig: getPublicDbConnectionConfig(),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unable to read auth status';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      const result = await authenticateSqlUser(String(email || ''), String(password || ''));
      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Authentication failed';
      res.status(401).json({ error: msg });
    }
  });

  app.post('/api/auth/register', async (req, res) => {
    try {
      const { email, password, displayName, role } = req.body || {};
      const result = await registerSqlUser({
        email: String(email || ''),
        password: String(password || ''),
        displayName: typeof displayName === 'string' ? displayName : undefined,
        role,
      });
      res.status(201).json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Registration failed';
      res.status(400).json({ error: msg });
    }
  });

  app.get('/api/auth/me', requireAuth, async (req: AuthRequest, res) => {
    try {
      const user = await getSqlUserSummary(req.user!.uid);
      if (!user) {
        return res.status(404).json({ error: 'SQL user account not found.' });
      }
      res.json({ user });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to load user summary';
      res.status(500).json({ error: msg });
    }
  });

  app.patch('/api/auth/password', requireAuth, async (req: AuthRequest, res) => {
    try {
      const { newPassword, currentPassword } = req.body || {};
      await updateSqlUserPassword(
        req.user!.uid,
        String(newPassword || ''),
        typeof currentPassword === 'string' ? currentPassword : undefined
      );
      res.json({ ok: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to update password';
      res.status(400).json({ error: msg });
    }
  });

  app.get('/api/system/db-config', async (req, res) => {
    try {
      if (!(await canManageDbSettings(req))) {
        return res.status(403).json({
          error: 'Admin or Manager sign-in is required to view SQL server connection settings.',
        });
      }
      res.json({ config: getPublicDbConnectionConfig() });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to read SQL config';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/system/db-test', async (req, res) => {
    try {
      if (!(await canManageDbSettings(req))) {
        return res.status(403).json({
          ok: false,
          message: 'Admin or Manager sign-in is required to test SQL connections.',
        });
      }
      const existing = getActiveDbConnectionConfig();
      const candidate = validateRemoteIpDbInput(req.body || {}, existing.password);
      const testResult = await testSqlConnection(candidate);
      res.json(testResult);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Invalid SQL connection settings';
      res.status(400).json({ ok: false, message: msg });
    }
  });

  app.post('/api/system/db-config', async (req, res) => {
    try {
      if (!(await canManageDbSettings(req))) {
        return res.status(403).json({
          error: 'Admin or Manager sign-in is required to modify SQL server settings.',
        });
      }
      const existing = getActiveDbConnectionConfig();
      const candidate = validateRemoteIpDbInput(req.body || {}, existing.password);
      const testResult = await testSqlConnection(candidate);
      if (!testResult.ok) {
        return res.status(400).json({ error: testResult.message, testResult });
      }
      if (req.body?.initializeSchema !== false) {
        await ensureRemoteSqlSchemaApplied(candidate);
      }
      saveOverrideDbConnectionConfig(candidate);
      reconfigureDbPool(candidate);
      const postTest = await testSqlConnection(candidate);
      res.json({
        config: getPublicDbConnectionConfig(),
        testResult: postTest,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to save SQL configuration';
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/system/db-reset-env', async (req, res) => {
    try {
      if (!(await canManageDbSettings(req))) {
        return res.status(403).json({
          error: 'Admin or Manager sign-in is required to reset SQL server settings.',
        });
      }
      clearOverrideDbConnectionConfig();
      reconfigureDbPool();
      res.json({ config: getPublicDbConnectionConfig() });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to reset SQL configuration';
      res.status(500).json({ error: msg });
    }
  });

  // --- Authenticated SQL REST API Routes (backed by sqlService.ts) ---

  app.get('/api/workspace', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user!.uid;
      const email = req.user!.email || 'operator@plant.local';
      const displayName = req.user!.name || email;
      const snapshot = await getWorkspaceSnapshot(uid, email, displayName);
      res.json(snapshot);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to load workspace';
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/formulas', requireAuth, async (req: AuthRequest, res) => {
    try {
      const rows = await listFormulasOrdered(req.user!.uid);
      res.json({ formulas: rows });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to fetch formulas from SQL');
    }
  });

  app.get('/api/raw-materials', requireAuth, async (req: AuthRequest, res) => {
    try {
      const rows = await listRawMaterialsOrdered(req.user!.uid);
      res.json({ rawMaterials: rows });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to fetch raw materials from SQL');
    }
  });

  app.get('/api/batches', requireAuth, async (req: AuthRequest, res) => {
    try {
      const rows = await listBatchesOrdered(req.user!.uid);
      res.json({ batches: rows });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to fetch batches from SQL');
    }
  });

  app.get('/api/finished-goods', requireAuth, async (req: AuthRequest, res) => {
    try {
      const rows = await listFinishedGoodsOrdered(req.user!.uid);
      res.json({ finishedGoods: rows });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to fetch finished goods from SQL');
    }
  });

  app.get('/api/sensors', requireAuth, async (req: AuthRequest, res) => {
    try {
      const rows = await listSensorsOrdered(req.user!.uid);
      res.json({ sensors: rows });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to fetch sensors from SQL');
    }
  });

  app.get('/api/production-lines', requireAuth, async (req: AuthRequest, res) => {
    try {
      const rows = await listProductionLinesOrdered(req.user!.uid);
      res.json({ productionLines: rows });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to fetch production lines from SQL');
    }
  });

  app.get('/api/analytics/yield-trends', requireAuth, async (req: AuthRequest, res) => {
    try {
      const line = typeof req.query.line === 'string' ? req.query.line : undefined;
      const trends = await getBatchYieldTrendsDb(req.user!.uid, line);
      res.json(trends);
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to load yield trend analytics';
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/analytics/category-completion', requireAuth, async (req: AuthRequest, res) => {
    try {
      const breakdown = await getBatchCategoryCompletionDb(req.user!.uid);
      res.json(breakdown);
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? error.message
          : 'Failed to load category completion analytics';
      res.status(500).json({ error: msg });
    }
  });

  app.patch('/api/profile/role', requireAuth, async (req: AuthRequest, res) => {
    try {
      const profile = await updateUserRoleDb(req.user!.uid, req.body.role);
      res.json(profile);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to update role';
      res.status(500).json({ error: msg });
    }
  });

  app.patch('/api/profile/plant-options', requireAuth, async (req: AuthRequest, res) => {
    try {
      const profile = await updatePlantOptionsDb(req.user!.uid, req.body);
      res.json({ profile });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to update plant options';
      res.status(500).json({ error: msg });
    }
  });

  app.patch('/api/profile/role-permissions', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const profile = await updateRolePermissionsDb(
        req.user!.uid,
        req.body?.rolePermissions,
        actor
      );
      res.json({ profile });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to update role permissions');
    }
  });

  app.patch('/api/profile/category-parameter-presets', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const profile = await updateCategoryParameterPresetsDb(
        req.user!.uid,
        req.body?.categoryParameterPresets,
        actor
      );
      res.json({ profile });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to update category parameter templates');
    }
  });

  app.patch('/api/sensors/config', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const profile = await updateSensorConfigDb(req.user!.uid, req.body, actor);
      res.json({ profile });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to update sensor adapter settings');
    }
  });

  app.patch('/api/profile/wms-config', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const profile = await updateWmsConfigDb(req.user!.uid, req.body, actor);
      res.json({ profile });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to update WMS connector settings');
    }
  });

  app.post('/api/wms/import-raw-materials', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const mode = req.body?.mode === 'add' ? 'add' : 'set';
      const result = await importWmsRawMaterialsDb(
        req.user!.uid,
        req.body?.items,
        actor,
        mode
      );
      res.json(result);
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to import raw material stock');
    }
  });

  app.post('/api/wms/import-finished-goods', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const result = await importWmsFinishedGoodsDb(req.user!.uid, req.body?.items, actor);
      res.json(result);
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to import finished goods lots');
    }
  });

  app.post('/api/formulas', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const { archiveFormulaId, ...payload } = req.body;
      const id = await createFormulaVersionDb(req.user!.uid, payload, archiveFormulaId, actor);
      res.status(201).json({ id });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to create formula version');
    }
  });

  app.patch('/api/formulas/:id/process-parameters', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const formula = await updateFormulaProcessParametersDb(
        req.user!.uid,
        String(req.params.id),
        req.body.processParameters,
        actor,
        req.body.category
      );
      res.json({ formula });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to update recipe process parameters');
    }
  });

  app.post('/api/formulas/:id/approve', requireAuth, async (req: AuthRequest, res) => {
    try {
      await approveFormulaVersionDb(
        req.user!.uid,
        String(req.params.id),
        req.body.previousApprovedId
      );
      res.json({ ok: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to approve formula';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/raw-materials', requireAuth, async (req: AuthRequest, res) => {
    try {
      const id = await receiveRawMaterialLotDb(req.user!.uid, req.body);
      res.status(201).json({ id });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to receive raw lot';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/raw-materials/:id/replenish', requireAuth, async (req: AuthRequest, res) => {
    try {
      await replenishRawMaterialLotDb(
        req.user!.uid,
        String(req.params.id),
        Number(req.body.addQty) || 0
      );
      res.json({ ok: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to replenish lot';
      res.status(500).json({ error: msg });
    }
  });

  app.patch('/api/raw-materials/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      const lot = await adjustRawMaterialLotDb(
        req.user!.uid,
        String(req.params.id),
        req.body
      );
      res.json({ lot });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to adjust raw lot';
      res.status(500).json({ error: msg });
    }
  });

  app.delete('/api/raw-materials/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      await deleteRawMaterialLotDb(req.user!.uid, String(req.params.id));
      res.json({ ok: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to delete raw lot';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/batches', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const id = await createWorkOrderDb(req.user!.uid, req.body, actor);
      res.status(201).json({ id });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to create job order');
    }
  });

  app.patch('/api/batches/:id/header', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const batch = await updateBatchHeaderDb(
        req.user!.uid,
        String(req.params.id),
        req.body,
        actor
      );
      res.json({ batch });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to update batch header');
    }
  });

  app.post('/api/batches/:id/check-availability', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const shortageCount = await runAvailabilityCheckDb(
        req.user!.uid,
        String(req.params.id),
        actor
      );
      res.json({ shortageCount });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed availability check');
    }
  });

  app.post('/api/batches/:id/release', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const lotNumber = await releaseWorkOrderDb(req.user!.uid, String(req.params.id), actor);
      res.json({ lotNumber });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to release job order');
    }
  });

  app.post('/api/batches/:id/allocate-material', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      await allocateMaterialLotDb(req.user!.uid, String(req.params.id), req.body, actor);
      res.json({ ok: true });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to allocate raw material lot');
    }
  });

  app.post('/api/batches/:id/issue-material', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      await issueMaterialLotDb(req.user!.uid, String(req.params.id), req.body, actor);
      res.json({ ok: true });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to issue material lot');
    }
  });

  app.patch(
    '/api/batches/:id/issued-materials/:materialCode',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const actor = await resolveActor(req);
        await updateIssuedMaterialLotDb(
          req.user!.uid,
          String(req.params.id),
          String(req.params.materialCode),
          req.body,
          actor
        );
        res.json({ ok: true });
      } catch (error: unknown) {
        handleRouteError(res, error, 'Failed to update issued material lot');
      }
    }
  );

  app.post('/api/batches/:id/process-checks', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      await recordProcessCheckDb(req.user!.uid, String(req.params.id), req.body, actor);
      res.json({ ok: true });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to record process check');
    }
  });

  app.post('/api/batches/:id/sensor-readings', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const result = await ingestSensorReadingsDb(
        req.user!.uid,
        String(req.params.id),
        req.body,
        actor
      );
      res.json(result);
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to ingest sensor readings');
    }
  });

  app.patch(
    '/api/batches/:id/process-checks/:checkId',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const actor = await resolveActor(req);
        await updateProcessCheckDb(
          req.user!.uid,
          String(req.params.id),
          String(req.params.checkId),
          req.body,
          actor
        );
        res.json({ ok: true });
      } catch (error: unknown) {
        handleRouteError(res, error, 'Failed to update process reading');
      }
    }
  );

  app.delete(
    '/api/batches/:id/process-checks/:checkId',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const actor = await resolveActor(req);
        const override =
          req.body && typeof req.body === 'object'
            ? {
                authorizedOverride: Boolean(req.body.authorizedOverride),
                overrideReason:
                  typeof req.body.overrideReason === 'string'
                    ? req.body.overrideReason
                    : undefined,
              }
            : undefined;
        await deleteProcessCheckDb(
          req.user!.uid,
          String(req.params.id),
          String(req.params.checkId),
          override,
          actor
        );
        res.json({ ok: true });
      } catch (error: unknown) {
        handleRouteError(res, error, 'Failed to delete process reading');
      }
    }
  );

  app.post('/api/batches/:id/report-output', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      await reportBatchOutputDb(req.user!.uid, String(req.params.id), req.body, actor);
      res.json({ ok: true });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to report batch output');
    }
  });

  app.post('/api/batches/:id/qc-review', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      await startQcReviewDb(req.user!.uid, String(req.params.id), actor);
      res.json({ ok: true });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to move batch to QC review');
    }
  });

  app.post('/api/batches/:id/qc-decision', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const finishedGoodId = await executeQcDecisionDb(
        req.user!.uid,
        String(req.params.id),
        req.body,
        actor
      );
      res.json({ finishedGoodId });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to record QC decision');
    }
  });

  app.post('/api/batches/:id/close', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      await closeProductionBatchDb(req.user!.uid, String(req.params.id), actor);
      res.json({ ok: true });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to close batch');
    }
  });

  app.get('/api/batches/:id/audit-logs', requireAuth, async (req: AuthRequest, res) => {
    try {
      const logs = await getBatchAuditLogsDb(req.user!.uid, String(req.params.id));
      res.json({ logs });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to load batch audit logs');
    }
  });

  app.get('/api/finished-goods/:id/genealogy', requireAuth, async (req: AuthRequest, res) => {
    try {
      const genealogy = await getFinishedGoodGenealogyDb(
        req.user!.uid,
        String(req.params.id)
      );
      res.json(genealogy);
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to load backward lot genealogy');
    }
  });

  app.post('/api/finished-goods/:id/shipments', requireAuth, async (req: AuthRequest, res) => {
    try {
      await recordCustomerShipmentDb(req.user!.uid, String(req.params.id), req.body);
      res.json({ ok: true });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to record shipment');
    }
  });

  app.post('/api/sensors', requireAuth, async (req: AuthRequest, res) => {
    try {
      const sensor = await upsertThermalSensorDb(req.user!.uid, req.body);
      res.status(201).json({ sensor });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to save thermal probe';
      res.status(500).json({ error: msg });
    }
  });

  app.patch('/api/sensors/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      await updateThermalSensorDb(req.user!.uid, String(req.params.id), req.body);
      res.json({ ok: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to update sensor';
      res.status(500).json({ error: msg });
    }
  });

  app.delete('/api/sensors/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      await deleteThermalSensorDb(req.user!.uid, String(req.params.id));
      res.json({ ok: true });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to delete thermal probe';
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/sensors/maintenance-logs', requireAuth, async (req: AuthRequest, res) => {
    try {
      const sensorId =
        typeof req.query.sensorId === 'string' ? req.query.sensorId : undefined;
      const logs = await getSensorMaintenanceLogsDb(req.user!.uid, sensorId);
      res.json({ logs });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to load sensor maintenance logs';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/sensors/:id/maintenance-logs', requireAuth, async (req: AuthRequest, res) => {
    try {
      const log = await createSensorMaintenanceLogDb(
        req.user!.uid,
        String(req.params.id),
        req.body
      );
      res.status(201).json({ log });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to record sensor maintenance log';
      res.status(500).json({ error: msg });
    }
  });

  app.delete(
    '/api/sensors/maintenance-logs/:logId',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        await deleteSensorMaintenanceLogDb(req.user!.uid, String(req.params.logId));
        res.json({ ok: true });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Failed to remove maintenance log';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post('/api/batch-checks/specs', requireAuth, async (req: AuthRequest, res) => {
    try {
      const actor = await resolveActor(req);
      const spec = await upsertBatchCheckSpecDb(req.user!.uid, req.body, actor);
      res.status(201).json({ spec });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to save batch requirement');
    }
  });

  app.delete('/api/batch-checks/specs/:id', requireAuth, async (req: AuthRequest, res) => {
    try {
      await deleteBatchCheckSpecDb(req.user!.uid, String(req.params.id));
      res.json({ ok: true });
    } catch (error: unknown) {
      handleRouteError(res, error, 'Failed to delete batch requirement');
    }
  });

  app.post(
    '/api/batch-checks/specs/:specId/records',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const actor = await resolveActor(req);
        const record = await createBatchCheckRecordDb(
          req.user!.uid,
          String(req.params.specId),
          req.body,
          actor
        );
        res.status(201).json({ record });
      } catch (error: unknown) {
        handleRouteError(res, error, 'Failed to record batch condition');
      }
    }
  );

  app.patch(
    '/api/batch-checks/records/:recordId',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const actor = await resolveActor(req);
        const record = await updateBatchCheckRecordDb(
          req.user!.uid,
          String(req.params.recordId),
          req.body,
          actor
        );
        res.json({ record });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Failed to update batch record';
        const status =
          msg.includes('required') ||
          msg.includes('requires') ||
          msg.includes('Record at least') ||
          msg.includes('not found')
            ? 400
            : 500;
        res.status(status).json({ error: msg });
      }
    }
  );

  app.delete(
    '/api/batch-checks/records/:recordId',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const actor = await resolveActor(req);
        await deleteBatchCheckRecordDb(req.user!.uid, String(req.params.recordId), actor);
        res.json({ ok: true });
      } catch (error: unknown) {
        handleRouteError(res, error, 'Failed to remove batch record');
      }
    }
  );

  app.post('/api/production-lines', requireAuth, async (req: AuthRequest, res) => {
    try {
      const line = await upsertProductionLineDb(req.user!.uid, req.body);
      res.status(201).json({ line });
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? error.message
          : 'Failed to save production line setting';
      res.status(500).json({ error: msg });
    }
  });

  app.patch(
    '/api/production-lines/:id/status',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        const line = await updateProductionLineStatusDb(
          req.user!.uid,
          String(req.params.id),
          req.body.status
        );
        res.json({ line });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Failed to update line status';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.delete(
    '/api/production-lines/:id',
    requireAuth,
    async (req: AuthRequest, res) => {
      try {
        await deleteProductionLineDb(req.user!.uid, String(req.params.id));
        res.json({ ok: true });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Failed to remove production line';
        res.status(500).json({ error: msg });
      }
    }
  );

  // --- Vite Dev Middleware or Static Production Build ---
  if (process.env.NODE_ENV !== 'production') {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: hmrDisabled ? false : { server: httpServer },
        hmr: hmrDisabled ? false : { server: httpServer },
      },
      appType: 'spa',
    });

    if (hmrDisabled) {
      app.get('/@vite/client', (_req, res) => {
        res.type('application/javascript').send(`
const sheetsMap = new Map();
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url) { return url; }
export class ErrorOverlay {}
`);
      });
    }

    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Manufacturing Execution System standalone server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
