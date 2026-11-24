import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';
import {
  buildPgPoolConfig,
  getActiveDbConnectionConfig,
  type StoredDbConnectionConfig,
} from './connectionConfig.ts';

export type KettlerDrizzleDb = NodePgDatabase<typeof schema>;

declare global {
  var _postgresPool: Pool | undefined;
  var _drizzleDb: KettlerDrizzleDb | undefined;
}

export const createPool = (overrideConfig?: StoredDbConnectionConfig): Pool => {
  if (!global._postgresPool || overrideConfig) {
    const activeConfig = overrideConfig ?? getActiveDbConnectionConfig();
    const nextPool = new Pool(buildPgPoolConfig(activeConfig));
    nextPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
    if (overrideConfig && global._postgresPool) {
      const oldPool = global._postgresPool;
      void oldPool.end().catch((err) => {
        console.warn('Closed previous SQL pool after reconfiguration:', err);
      });
    }
    global._postgresPool = nextPool;
    global._drizzleDb = drizzle(nextPool, { schema });
  }
  return global._postgresPool;
};

export function getActiveDb(): KettlerDrizzleDb {
  if (!global._drizzleDb || !global._postgresPool) {
    createPool();
  }
  return global._drizzleDb!;
}

export function reconfigureDbPool(overrideConfig?: StoredDbConnectionConfig): KettlerDrizzleDb {
  const cfg = overrideConfig ?? getActiveDbConnectionConfig();
  createPool(cfg);
  return getActiveDb();
}

export const db: KettlerDrizzleDb = new Proxy({} as KettlerDrizzleDb, {
  get(_target, prop, receiver) {
    const active = getActiveDb();
    const value = Reflect.get(active, prop, receiver);
    return typeof value === 'function' ? value.bind(active) : value;
  },
});
