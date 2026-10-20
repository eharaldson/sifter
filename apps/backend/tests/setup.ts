import { beforeAll, afterAll } from 'vitest';
import { initializeDatabase, closeDatabase, query } from '../src/db';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

beforeAll(async () => {
  // Initialize test database
  initializeDatabase({
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    database: process.env.DATABASE_NAME || 'find_test_db',
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    ssl: process.env.DATABASE_SSL === 'true',
  });

  // Run migrations for test database
  try {
    await query('CREATE EXTENSION IF NOT EXISTS vector');
    await query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  } catch (error) {
    console.warn('Extensions may already exist:', error);
  }
});

afterAll(async () => {
  await closeDatabase();
});
