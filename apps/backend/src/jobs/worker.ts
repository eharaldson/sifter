import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import { 
  processProductEmbeddings,
  initializeTextEmbeddingService,
  cleanupTextEmbeddingService,
  initializeImageEmbeddingService,
  cleanupImageEmbeddingService
} from '../embeddings';
import { logger } from '../log';
import { initializeDatabase, getPoolStats } from '../db';
import { EmbeddingJobData } from './queue';

// Load environment variables
dotenv.config();

// Initialize database connection for worker
// Worker is primarily write-heavy (updating embeddings), but needs some reads
const dbConfig = {
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '5432'),
  database: process.env.DATABASE_NAME || 'find_db',
  user: process.env.DATABASE_USER || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'password',
  ssl: process.env.DATABASE_SSL === 'true',
};

logger.info({
  host: dbConfig.host,
  port: dbConfig.port,
  database: dbConfig.database,
  user: dbConfig.user,
  ssl: dbConfig.ssl,
}, '🔧 Worker: Initializing database connection');

initializeDatabase({
  write: {
    ...dbConfig,
    max: parseInt(process.env.DATABASE_WRITE_POOL_SIZE || '5'),
  },
  read: {
    ...dbConfig,
    host: process.env.DATABASE_READ_HOST || dbConfig.host,
    max: parseInt(process.env.DATABASE_READ_POOL_SIZE || '3'), // Worker needs fewer reads
  },
});

const poolStats = getPoolStats();
logger.info({
  writePool: poolStats.write,
  readPool: poolStats.read,
}, '✅ Worker: Database pools initialized');

// Redis connection for worker
if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required for the embedding worker');
logger.info('Connecting to Redis...');

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: false,  // Connect immediately
  connectTimeout: 10000,  // 10 second timeout
  retryStrategy: (times) => {
    if (times > 3) {
      logger.error('Redis connection failed after 3 retries');
      return null; // Stop retrying
    }
    return Math.min(times * 200, 2000); // Exponential backoff
  }
});

logger.info({
  configured: Boolean(process.env.REDIS_URL),
}, 'Redis connection initialized for worker');

// DEBUG: Check queue state (read-only, doesn't modify anything)
(async () => {
  try {
    const waitingCount = await redis.llen('bull:embedding-generation:wait');
    const activeCount = await redis.llen('bull:embedding-generation:active');
    const stalledCount = await redis.zcard('bull:embedding-generation:stalled');
    const delayedCount = await redis.zcard('bull:embedding-generation:delayed');
    
    logger.info({
      waiting: waitingCount,
      active: activeCount,
      stalled: stalledCount,
      delayed: delayedCount
    }, '🔍 DEBUG: Queue state at worker startup');
    
    // Check if there are any stalled jobs
    if (stalledCount > 0) {
      const stalledJobs = await redis.zrange('bull:embedding-generation:stalled', 0, 5);
      logger.info({ stalledJobs }, '🔍 DEBUG: Sample stalled job IDs');
    }
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : error }, 'Failed to check queue state');
  }
})();

// Worker configuration
const workerConfig = {
  connection: redis,
  concurrency: parseInt(process.env.EMBEDDING_WORKER_CONCURRENCY || '5'), // Process 5 jobs concurrently
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

// Job processor function
async function processEmbeddingJob(job: Job<EmbeddingJobData>): Promise<void> {
  logger.info({
    jobId: job.id,
    productId: job.data?.productId,
    type: job.data?.type,
    attemptsMade: job.attemptsMade
  }, '🔍 Job received by worker');

  const { productId, type } = job.data;
  const startTime = Date.now();

  try {
    // Process the embeddings
    const result = await processProductEmbeddings(productId, type);

    // Update job progress
    await job.updateProgress(100);
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : 'No stack trace';
    
    logger.error({
      jobId: job.id,
      productId,
      type,
      duration,
      attempt: job.attemptsMade + 1,
      error: errorMessage,
      stack: errorStack,
    }, '❌ Embedding job failed with error');

    // Re-throw to trigger retry mechanism
    throw error;
  }
}

// Create and start worker
export const embeddingWorker = new Worker(
  'embedding-generation',
  processEmbeddingJob,
  workerConfig
);

// Worker event handlers
embeddingWorker.on('ready', () => {
});

embeddingWorker.on('active', (job: Job<EmbeddingJobData>) => {
});

embeddingWorker.on('completed', (job: Job<EmbeddingJobData>) => {
});

embeddingWorker.on('failed', (job: Job<EmbeddingJobData> | undefined, error: Error) => {
  if (job) {
    logger.error({
      jobId: job.id,
      productId: job.data.productId,
      type: job.data.type,
      attempt: job.attemptsMade,
      maxAttempts: job.opts.attempts,
      error: error.message,
      stack: error.stack,
    }, '💥 Embedding job failed with error');
  } else {
    logger.error({ error: error.message, stack: error.stack }, '💥 Worker error without job context');
  }
});

embeddingWorker.on('stalled', (jobId: string) => {
  logger.warn({ jobId }, 'Embedding job stalled');
});

embeddingWorker.on('error', (error: Error) => {
  logger.error({ error: error.message }, 'Embedding worker error');
});

// Graceful shutdown
export async function stopWorker(): Promise<void> {
  logger.info('Stopping embedding worker...');
  await embeddingWorker.close();
  await redis.quit();
  logger.info('Embedding worker stopped');
}

// Worker health check
export function isWorkerHealthy(): boolean {
  return !embeddingWorker.closing;
}

// Start worker if this file is run directly
if (require.main === module) {
  logger.info('Starting embedding worker...');
  
  // Initialize embedding services for the worker
  Promise.all([
    initializeTextEmbeddingService(),
    initializeImageEmbeddingService()
  ]).then(() => {
    logger.info('Text and image embedding services initialized for worker');
  }).catch((error) => {
    logger.error('Failed to initialize embedding services for worker:', error);
    process.exit(1);
  });
  
  // Handle graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    await Promise.all([
      cleanupTextEmbeddingService(),
      cleanupImageEmbeddingService()
    ]);
    await stopWorker();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    await Promise.all([
      cleanupTextEmbeddingService(),
      cleanupImageEmbeddingService()
    ]);
    await stopWorker();
    process.exit(0);
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'Uncaught exception in worker');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.fatal({ reason, promise }, 'Unhandled rejection in worker');
    process.exit(1);
  });
}
