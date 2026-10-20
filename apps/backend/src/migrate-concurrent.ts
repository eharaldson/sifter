import { readFileSync } from 'fs';
import { join } from 'path';
import { initializeDatabase, query, closeDatabase } from './db';
import { logger } from './log';
import dotenv from 'dotenv';

dotenv.config();

async function runConcurrentMigrations() {
  try {
    // Initialize database connection
    initializeDatabase({
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
      database: process.env.DATABASE_NAME || 'find_db',
      user: process.env.DATABASE_USER || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      ssl: process.env.DATABASE_SSL === 'true',
    });

    logger.info('Running concurrent database migrations (vector indices)...');

    // Read and execute concurrent migration SQL
    const concurrentMigrationSQL = readFileSync(join(__dirname, 'migrations-concurrent.sql'), 'utf-8');
    
    // Split the SQL file by statements and execute them one by one
    // This is important for concurrent index creation as each CREATE INDEX CONCURRENTLY
    // must be run in its own transaction
    const statements = concurrentMigrationSQL
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

    for (const statement of statements) {
      if (statement.includes('CREATE INDEX CONCURRENTLY')) {
        logger.info(`Executing: ${statement.substring(0, 80)}...`);
        try {
          await query(statement);
          logger.info('✓ Index created successfully');
        } catch (error: any) {
          // Check if the error is because the index already exists
          if (error.message?.includes('already exists')) {
            logger.info('✓ Index already exists, skipping');
          } else {
            logger.error({ error, statement }, 'Failed to create index');
            throw error;
          }
        }
      }
    }

    logger.info('Concurrent database migrations completed successfully');
    logger.info('All vector indices have been created');
  } catch (error) {
    logger.error({ error }, 'Concurrent migration failed');
    process.exit(1);
  } finally {
    await closeDatabase();
  }
}

if (require.main === module) {
  runConcurrentMigrations();
}

export { runConcurrentMigrations };
