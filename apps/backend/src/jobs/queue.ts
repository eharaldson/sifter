import { Queue, Job } from 'bullmq';
import Redis from 'ioredis';
import { logger } from '../log';

// Redis connection - lazy initialization
let redis: Redis | null = null;
let isRedisAvailable = false;

async function getRedisConnection(): Promise<Redis | null> {
  if (!process.env.REDIS_URL) return null;
  if (redis === null) {
    try {
      redis = new Redis(process.env.REDIS_URL, {
        enableReadyCheck: false,
        maxRetriesPerRequest: null, // Required by BullMQ for blocking operations
        lazyConnect: false, // Connect immediately
        connectTimeout: 5000,
        commandTimeout: 5000,
      });
      
      redis.on('connect', () => {
        isRedisAvailable = true;
        logger.info('Redis connection established for job queue');
      });
      
      redis.on('error', (error) => {
        isRedisAvailable = false;
        logger.warn(error.message);
        logger.warn({ error: error.message }, 'Redis connection failed - job queue disabled');
      });
      
      // Wait for connection to be established
      await redis.ping();
      isRedisAvailable = true;
      
    } catch (error) {
      logger.warn({ error }, 'Failed to initialize Redis connection - job queue disabled');
      isRedisAvailable = false;
      redis = null;
      return null;
    }
  }
  
  return isRedisAvailable ? redis : null;
}

// Job types
export interface EmbeddingJobData {
  productId: number;
  type: 'text' | 'image' | 'both';
  priority?: number;
}

export interface BatchEmbeddingJobData {
  productIds: number[];
  type: 'text' | 'image' | 'both';
  priority?: number;
  batchSize?: number;
}

// Queue configuration - lazy initialization
let embeddingQueue: Queue | null = null;

async function getEmbeddingQueue(): Promise<Queue | null> {
  if (embeddingQueue === null) {
    const redisConnection = await getRedisConnection();
    if (!redisConnection) {
      logger.warn('Embedding queue unavailable: Redis connection not established');
      return null;
    }
    
    try {
      embeddingQueue = new Queue('embedding-generation', {
        connection: redisConnection,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 50,
          attempts: 3,
          backoff: {
            type: 'exponential' as const,
            delay: 2000,
          },
        },
      });
      logger.info('Embedding queue created successfully (embedding-generation)');
    } catch (error) {
      logger.warn({ 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.substring(0, 400) : undefined
      }, 'Failed to create embedding queue');
      return null;
    }
  }
  
  return embeddingQueue;
}

// Job priorities
export const JobPriority = {
  LOW: 1,
  NORMAL: 5,
  HIGH: 10,
  CRITICAL: 20,
} as const;

// Queue management functions
export async function enqueueEmbeddingJob(
  productId: number,
  type: 'text' | 'image' | 'both' = 'both',
  priority: number = JobPriority.NORMAL
): Promise<Job<EmbeddingJobData> | null> {
  const queue = await getEmbeddingQueue();
  if (!queue) {
    logger.warn({ productId, type }, 'Skipping embedding job - Redis not available or queue not initialized');
    return null;
  }

  const jobData: EmbeddingJobData = {
    productId,
    type,
    priority,
  };

  try {
    const job = await queue.add(
      'generate-embeddings',
      jobData,
      {
        priority,
        jobId: `embedding-${productId}-${type}-${Date.now()}`,
        delay: 0,
      }
    );

    return job;
  } catch (error) {
    logger.warn({ 
      productId, 
      type, 
      priority,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.substring(0, 400) : undefined
    }, 'Failed to enqueue embedding job');
    return null;
  }
}

export async function enqueueEmbeddingJobs(
  jobs: Array<{ productId: number; type: 'text' | 'image' | 'both'; priority?: number }>
): Promise<Job<EmbeddingJobData>[]> {
  const queue = await getEmbeddingQueue();
  if (!queue) {
    logger.warn({ jobCount: jobs.length }, 'Skipping bulk embedding jobs - Redis not available or queue not initialized');
    return [];
  }

  const jobData = jobs.map((job) => ({
    name: 'generate-embeddings',
    data: job as EmbeddingJobData,
    opts: {
      priority: job.priority || JobPriority.NORMAL,
      jobId: `embedding-${job.productId}-${job.type}-${Date.now()}`,
      delay: 0,
    },
  }));

  try {
    const addedJobs = await queue.addBulk(jobData);

    return addedJobs;
  } catch (error) {
    logger.warn({ 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.substring(0, 400) : undefined,
      count: jobs.length, 
      type: jobs[0].type 
    }, 'Failed to enqueue bulk embedding jobs');
    return [];
  }
}

export async function enqueueBatchEmbeddingJobs(
  productIds: number[],
  type: 'text' | 'image' | 'both' = 'both',
  priority: number = JobPriority.NORMAL,
  batchSize: number = 50
): Promise<Job<BatchEmbeddingJobData>[]> {
  const queue = await getEmbeddingQueue();
  if (!queue) {
    logger.warn({ productCount: productIds.length }, 'Skipping batch embedding jobs - Redis not available or queue not initialized');
    return [];
  }

  if (productIds.length === 0) {
    return [];
  }

  // Split product IDs into batches
  const batches: number[][] = [];
  for (let i = 0; i < productIds.length; i += batchSize) {
    batches.push(productIds.slice(i, i + batchSize));
  }

  logger.info({
    totalProducts: productIds.length,
    batchCount: batches.length,
    batchSize,
    type,
    priority
  }, 'Creating batch embedding jobs');

  const jobData = batches.map((batch, index) => ({
    name: 'generate-batch-embeddings',
    data: {
      productIds: batch,
      type,
      priority,
      batchSize
    } as BatchEmbeddingJobData,
    opts: {
      priority,
      jobId: `batch-embedding-${type}-${Date.now()}-${index}`,
      delay: index * 1000, // Stagger batches by 1 second
    },
  }));

  try {
    const addedJobs = await queue.addBulk(jobData);

    logger.info({
      totalProducts: productIds.length,
      batchCount: batches.length,
      jobsEnqueued: addedJobs.length,
      type
    }, 'Batch embedding jobs enqueued successfully');

    return addedJobs;
  } catch (error) {
    logger.warn({ 
      error, 
      totalProducts: productIds.length, 
      batchCount: batches.length, 
      type 
    }, 'Failed to enqueue batch embedding jobs');
    return [];
  }
}

// Export queue getter for debugging purposes
export async function getEmbeddingQueueForDebug(): Promise<Queue | null> {
  return getEmbeddingQueue();
}

// Queue monitoring
export async function getQueueStats() {
  const queue = await getEmbeddingQueue();
  if (!queue) {
    return {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      available: false,
    };
  }

  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaiting(),
      queue.getActive(),
      queue.getCompleted(),
      queue.getFailed(),
      queue.getDelayed(),
    ]);

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      delayed: delayed.length,
      available: true,
    };
  } catch (error) {
    logger.warn({ error }, 'Failed to get queue stats');
    return {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      available: false,
    };
  }
}

export async function waitForJobsToComplete(timeoutMs: number = 30000): Promise<boolean> {
  const queue = await getEmbeddingQueue();
  if (!queue) {
    return true; // No queue means no jobs to wait for
  }

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const stats = await getQueueStats();
    if (stats.active === 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

// Clean up old jobs
export async function cleanQueue() {
  const queue = await getEmbeddingQueue();
  if (!queue) {
    logger.debug('Skipping queue cleanup - Redis not available');
    return;
  }

  try {
    await queue.clean(24 * 60 * 60 * 1000, 100, 'completed');
    await queue.clean(7 * 24 * 60 * 60 * 1000, 50, 'failed');
    
    logger.info('Queue cleanup completed');
  } catch (error) {
    logger.warn({ error }, 'Failed to clean queue');
  }
}

// Graceful shutdown
export async function closeQueue(): Promise<void> {
  if (embeddingQueue) {
    await embeddingQueue.close();
    embeddingQueue = null;
  }
  
  if (redis) {
    try {
      await redis.ping();
      await redis.quit();
    } catch (error) {
      // Ignore errors during shutdown
    }
    redis = null;
    isRedisAvailable = false;
  }
  
  logger.info('Queue connections closed');
}

// Health check
export async function isQueueHealthy(): Promise<boolean> {
  const redisConnection = await getRedisConnection();
  if (!redisConnection) {
    return false;
  }

  try {
    await redisConnection.ping();
    return true;
  } catch (error) {
    return false;
  }
}
