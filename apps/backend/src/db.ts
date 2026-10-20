import { Pool, PoolClient, PoolConfig } from 'pg';
import { logger } from './log';

// Separate read and write pools for better scaling
let writePool: Pool;
let readPool: Pool;

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

export interface DatabasePoolConfig {
  // Write pool config (primary database)
  write: DatabaseConfig;
  // Read pool config (optional - defaults to write config if not provided)
  read?: DatabaseConfig;
}

/**
 * Initialize database with separate read and write pools
 * 
 * For Supabase, you can use the same host for both pools initially.
 * The separation allows:
 * 1. Different connection limits (more reads than writes typically)
 * 2. Easy migration to read replicas later
 * 3. Better resource isolation
 */
export function initializeDatabase(config: DatabaseConfig | DatabasePoolConfig): void {
  // Handle both legacy single config and new pool config
  const isPoolConfig = 'write' in config;
  const writeConfig = isPoolConfig ? config.write : config;
  const readConfig = isPoolConfig && config.read ? config.read : writeConfig;

  // Initialize write pool (smaller - writes are less frequent)
  writePool = createPool(writeConfig, 'write', {
    maxConnections: writeConfig.max || 5,
    connectionTimeout: writeConfig.connectionTimeoutMillis || 5000,
    idleTimeout: writeConfig.idleTimeoutMillis || 30000,
  });

  // Initialize read pool (larger - reads are more frequent)
  readPool = createPool(readConfig, 'read', {
    maxConnections: readConfig.max || 15,
    connectionTimeout: readConfig.connectionTimeoutMillis || 2000,
    idleTimeout: readConfig.idleTimeoutMillis || 30000,
  });

  logger.info({
    writePool: {
      host: writeConfig.host,
      port: writeConfig.port,
      database: writeConfig.database,
      maxConnections: writeConfig.max || 5,
    },
    readPool: {
      host: readConfig.host,
      port: readConfig.port,
      database: readConfig.database,
      maxConnections: readConfig.max || 15,
    },
    ssl: !!writeConfig.ssl,
  }, 'Database pools initialized (read/write separation enabled)');
}

function createPool(
  config: DatabaseConfig,
  poolName: string,
  options: { maxConnections: number; connectionTimeout: number; idleTimeout: number }
): Pool {
  const poolConfig: PoolConfig = {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: options.maxConnections,
    idleTimeoutMillis: options.idleTimeout,
    connectionTimeoutMillis: options.connectionTimeout,
    statement_timeout: 30000,  // 30 second query timeout to prevent hanging queries
  };

  // Enable SSL for Supabase/cloud connections
  if (config.ssl) {
    poolConfig.ssl = typeof config.ssl === 'boolean'
      ? { rejectUnauthorized: false }  // Supabase requires SSL but uses self-signed certs
      : config.ssl;
  }

  const pool = new Pool(poolConfig);

  pool.on('error', (err) => {
    logger.error({ err, pool: poolName }, `Unexpected error on idle ${poolName} client`);
  });

  pool.on('connect', () => {
    logger.debug({ 
      pool: poolName,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    }, `Database ${poolName} client connected`);
  });

  return pool;
}

/**
 * Get a client from the write pool (for INSERT, UPDATE, DELETE, transactions)
 */
export async function getWriteClient(): Promise<PoolClient> {
  if (!writePool) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }

  try {
    const client = await writePool.connect();
    return client;
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : String(error),
      pool: 'write',
      poolState: {
        totalCount: writePool.totalCount,
        idleCount: writePool.idleCount,
        waitingCount: writePool.waitingCount,
      },
      note: 'Failed to acquire write connection from pool',
    }, 'Database write pool error');
    throw error;
  }
}

/**
 * Get a client from the read pool (for SELECT queries)
 */
export async function getReadClient(): Promise<PoolClient> {
  if (!readPool) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  
  try {
    const client = await readPool.connect();
    return client;
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : String(error),
      pool: 'read',
      poolState: {
        totalCount: readPool.totalCount,
        idleCount: readPool.idleCount,
        waitingCount: readPool.waitingCount,
      },
      note: 'Failed to acquire read connection from pool',
    }, 'Database read pool error');
    throw error;
  }
}

/**
 * Get a client (defaults to write pool for backward compatibility)
 * @deprecated Use getReadClient() or getWriteClient() for explicit control
 */
export async function getClient(): Promise<PoolClient> {
  return getWriteClient();
}

/**
 * Determine if a query is read-only based on its SQL
 */
function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  // Read-only if it starts with SELECT, WITH (for CTEs that are reads), or EXPLAIN
  return (
    trimmed.startsWith('SELECT') ||
    trimmed.startsWith('WITH') ||
    trimmed.startsWith('EXPLAIN')
  ) && !trimmed.includes('FOR UPDATE') && !trimmed.includes('FOR SHARE');
}

/**
 * Execute a query with automatic pool selection based on query type
 * - SELECT queries use the read pool
 * - INSERT, UPDATE, DELETE use the write pool
 */
export async function query(text: string, params?: any[]): Promise<any> {
  const isRead = isReadOnlyQuery(text);
  const client = isRead ? await getReadClient() : await getWriteClient();
  
  try {
    const start = Date.now();
    const result = await client.query(text, params);
    const duration = Date.now() - start;
    
    logger.debug({ 
      query: text.substring(0, 100),
      duration, 
      rows: result.rowCount,
      pool: isRead ? 'read' : 'write',
    }, 'Database query executed');
    
    return result;
  } finally {
    client.release();
  }
}

/**
 * Execute a read-only query (explicitly uses read pool)
 */
export async function readQuery(text: string, params?: any[]): Promise<any> {
  const client = await getReadClient();
  
  try {
    const start = Date.now();
    const result = await client.query(text, params);
    const duration = Date.now() - start;

    logger.debug({
      query: text.substring(0, 100),
      duration,
      rows: result.rowCount,
      pool: 'read',
    }, 'Database read query executed');

    return result;
  } finally {
    client.release();
  }
}

/**
 * Execute a write query (explicitly uses write pool)
 */
export async function writeQuery(text: string, params?: any[]): Promise<any> {
  const client = await getWriteClient();
  
  try {
    const start = Date.now();
    const result = await client.query(text, params);
    const duration = Date.now() - start;

    logger.debug({
      query: text.substring(0, 100),
      duration,
      rows: result.rowCount,
      pool: 'write',
    }, 'Database write query executed');

    return result;
  } finally {
    client.release();
  }
}

/**
 * Execute a transaction (always uses write pool)
 */
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getWriteClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get current pool statistics (useful for monitoring)
 */
export function getPoolStats(): {
  read: { total: number; idle: number; waiting: number };
  write: { total: number; idle: number; waiting: number };
} {
  return {
    read: {
      total: readPool?.totalCount ?? 0,
      idle: readPool?.idleCount ?? 0,
      waiting: readPool?.waitingCount ?? 0,
    },
    write: {
      total: writePool?.totalCount ?? 0,
      idle: writePool?.idleCount ?? 0,
      waiting: writePool?.waitingCount ?? 0,
    },
  };
}

/**
 * Close all database pools
 */
export async function closeDatabase(): Promise<void> {
  const closePromises: Promise<void>[] = [];

  if (writePool) {
    closePromises.push(writePool.end());
  }
  if (readPool && readPool !== writePool) {
    closePromises.push(readPool.end());
  }

  await Promise.all(closePromises);
  logger.info('Database pools closed');
}
