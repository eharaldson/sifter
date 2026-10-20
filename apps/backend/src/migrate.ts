import { readFileSync } from 'fs';
import { join } from 'path';
import { initializeDatabase, query, closeDatabase, getClient } from './db';
import { logger } from './log';
import { seedStandardSizes } from './shared/size-mapper';
import dotenv from 'dotenv';

dotenv.config();

async function runMigrations() {
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

    logger.info('Running database migrations...');

    // Read and execute migration SQL
    const migrationSQL = readFileSync(join(__dirname, 'migrations.sql'), 'utf-8');
    await query(migrationSQL);

    logger.info('Database migrations completed successfully');
    
    // Seed standard sizes
    logger.info('Seeding standard_sizes table...');
    const client = await getClient();
    
    try {
      const insertedCount = await seedStandardSizes(client);
      logger.info({ insertedCount }, 'Standard sizes seeded successfully');
    } finally {
      client.release();
    }
    
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    process.exit(1);
  } finally {
    await closeDatabase();
  }
}

if (require.main === module) {
  runMigrations();
}
