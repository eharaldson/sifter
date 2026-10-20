import { logger } from '../log';
import { query } from '../db';

// Background job types
export interface BackgroundJob {
  id: number;
  job_type: string;
  payload: Record<string, any>;
  priority: number;
  scheduled_at: Date;
  started_at?: Date;
  completed_at?: Date;
  failed_at?: Date;
  error_message?: string;
  retry_count: number;
  max_retries: number;
  created_at: Date;
  updated_at: Date;
}

// MV refresh configuration
const MV_REFRESH_CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 30000, // 30 seconds
  BATCH_DELAY_MS: 30000, // 30 seconds between batches
  CONCURRENT_REFRESHES: 2, // Max concurrent MV refreshes
  VIEWS_TO_REFRESH: [
    'product_search_mv',
    'offer_aggregates_mv',
    'brand_stats_mv',
    'category_stats_mv'
  ]
};

/**
 * Create background jobs table if it doesn't exist
 */
export async function ensureBackgroundJobsTable(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS background_jobs (
        id SERIAL PRIMARY KEY,
        job_type VARCHAR(100) NOT NULL,
        payload JSONB DEFAULT '{}',
        priority INTEGER DEFAULT 1,
        scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
        started_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE,
        failed_at TIMESTAMP WITH TIME ZONE,
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_background_jobs_type_scheduled 
      ON background_jobs (job_type, scheduled_at) 
      WHERE completed_at IS NULL AND failed_at IS NULL;
      
      CREATE INDEX IF NOT EXISTS idx_background_jobs_priority 
      ON background_jobs (priority DESC, scheduled_at ASC) 
      WHERE completed_at IS NULL AND failed_at IS NULL;
    `);
    
    logger.debug('Background jobs table ensured');
    
  } catch (error) {
    logger.error({ error }, 'Failed to create background jobs table');
    throw error;
  }
}

/**
 * Refresh a single materialized view
 */
async function refreshMaterializedView(viewName: string): Promise<void> {
  const startTime = Date.now();
  
  try {
    logger.info({ view: viewName }, 'Starting materialized view refresh');
    
    // Use CONCURRENTLY to avoid blocking reads
    await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${viewName}`);
    
    const duration = Date.now() - startTime;
    logger.info({ 
      view: viewName, 
      duration 
    }, 'Materialized view refresh completed');
    
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    logger.error({ 
      view: viewName, 
      error: errorMessage, 
      duration 
    }, 'Materialized view refresh failed');
    
    throw new Error(`Failed to refresh ${viewName}: ${errorMessage}`);
  }
}

/**
 * Process MV refresh job
 */
export async function processMVRefreshJob(job: BackgroundJob): Promise<void> {
  const { payload } = job;
  const viewsToRefresh = payload.views || MV_REFRESH_CONFIG.VIEWS_TO_REFRESH;
  
  logger.info({ 
    job_id: job.id, 
    views: viewsToRefresh 
  }, 'Processing MV refresh job');
  
  const errors: string[] = [];
  
  // Refresh views sequentially to avoid resource contention
  for (const viewName of viewsToRefresh) {
    try {
      await refreshMaterializedView(viewName);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`${viewName}: ${errorMessage}`);
    }
  }
  
  if (errors.length > 0) {
    throw new Error(`MV refresh failed for some views: ${errors.join('; ')}`);
  }
}

/**
 * Get next job to process
 */
export async function getNextJob(): Promise<BackgroundJob | null> {
  try {
    const result = await query(`
      UPDATE background_jobs 
      SET 
        started_at = NOW(),
        updated_at = NOW()
      WHERE id = (
        SELECT id 
        FROM background_jobs 
        WHERE 
          scheduled_at <= NOW()
          AND started_at IS NULL 
          AND completed_at IS NULL 
          AND (failed_at IS NULL OR retry_count < max_retries)
        ORDER BY priority DESC, scheduled_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0] as BackgroundJob;
    
  } catch (error) {
    logger.error({ error }, 'Failed to get next job');
    return null;
  }
}

/**
 * Mark job as completed
 */
export async function markJobCompleted(jobId: number): Promise<void> {
  try {
    await query(`
      UPDATE background_jobs 
      SET 
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `, [jobId]);
    
    logger.debug({ job_id: jobId }, 'Job marked as completed');
    
  } catch (error) {
    logger.error({ error, job_id: jobId }, 'Failed to mark job as completed');
  }
}

/**
 * Mark job as failed and schedule retry if applicable
 */
export async function markJobFailed(
  jobId: number, 
  errorMessage: string
): Promise<void> {
  try {
    const result = await query(`
      UPDATE background_jobs 
      SET 
        failed_at = NOW(),
        error_message = $2,
        retry_count = retry_count + 1,
        scheduled_at = CASE 
          WHEN retry_count + 1 < max_retries 
          THEN NOW() + INTERVAL '${MV_REFRESH_CONFIG.RETRY_DELAY_MS} milliseconds'
          ELSE scheduled_at
        END,
        started_at = CASE 
          WHEN retry_count + 1 < max_retries 
          THEN NULL
          ELSE started_at
        END,
        updated_at = NOW()
      WHERE id = $1
      RETURNING retry_count, max_retries
    `, [jobId, errorMessage]);
    
    if (result.rows.length > 0) {
      const { retry_count, max_retries } = result.rows[0];
      
      if (retry_count < max_retries) {
        logger.warn({ 
          job_id: jobId, 
          retry_count, 
          max_retries,
          error: errorMessage 
        }, 'Job failed, scheduled for retry');
      } else {
        logger.error({ 
          job_id: jobId, 
          retry_count, 
          max_retries,
          error: errorMessage 
        }, 'Job failed permanently after max retries');
      }
    }
    
  } catch (error) {
    logger.error({ 
      error, 
      job_id: jobId, 
      original_error: errorMessage 
    }, 'Failed to mark job as failed');
  }
}

/**
 * Process a single job
 */
export async function processJob(job: BackgroundJob): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    logger.info({ 
      job_id: job.id, 
      job_type: job.job_type 
    }, 'Processing background job');
    
    switch (job.job_type) {
      case 'mv_refresh':
        await processMVRefreshJob(job);
        break;
        
      default:
        throw new Error(`Unknown job type: ${job.job_type}`);
    }
    
    await markJobCompleted(job.id);
    
    const duration = Date.now() - startTime;
    logger.info({ 
      job_id: job.id, 
      job_type: job.job_type, 
      duration 
    }, 'Background job completed successfully');
    
    return true;
    
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    await markJobFailed(job.id, errorMessage);
    
    logger.error({ 
      job_id: job.id, 
      job_type: job.job_type, 
      error: errorMessage, 
      duration 
    }, 'Background job failed');
    
    return false;
  }
}

/**
 * Background job worker - processes jobs continuously
 */
export class BackgroundJobWorker {
  private running = false;
  private processingCount = 0;
  
  constructor(
    private maxConcurrent: number = MV_REFRESH_CONFIG.CONCURRENT_REFRESHES,
    private pollInterval: number = 5000 // 5 seconds
  ) {}
  
  /**
   * Start the worker
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Background job worker is already running');
      return;
    }
    
    this.running = true;
    logger.info({ 
      max_concurrent: this.maxConcurrent, 
      poll_interval: this.pollInterval 
    }, 'Starting background job worker');
    
    // Ensure tables exist
    await ensureBackgroundJobsTable();
    
    // Start processing loop
    this.processLoop();
  }
  
  /**
   * Stop the worker
   */
  stop(): void {
    if (!this.running) {
      return;
    }
    
    this.running = false;
    logger.info('Stopping background job worker');
  }
  
  /**
   * Main processing loop
   */
  private async processLoop(): Promise<void> {
    while (this.running) {
      try {
        // Check if we can process more jobs
        if (this.processingCount < this.maxConcurrent) {
          const job = await getNextJob();
          
          if (job) {
            // Process job asynchronously
            this.processingCount++;
            
            processJob(job)
              .finally(() => {
                this.processingCount--;
              });
          } else {
            // No jobs available, wait before polling again
            await this.sleep(this.pollInterval);
          }
        } else {
          // At max concurrent capacity, wait a bit
          await this.sleep(1000);
        }
        
      } catch (error) {
        logger.error({ error }, 'Error in background job processing loop');
        await this.sleep(5000); // Wait longer on error
      }
    }
    
    logger.info('Background job worker stopped');
  }
  
  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Get worker status
   */
  getStatus(): {
    running: boolean;
    processingCount: number;
    maxConcurrent: number;
  } {
    return {
      running: this.running,
      processingCount: this.processingCount,
      maxConcurrent: this.maxConcurrent
    };
  }
}

/**
 * Clean up old completed/failed jobs
 */
export async function cleanupOldJobs(
  olderThanHours: number = 24
): Promise<number> {
  try {
    const result = await query(`
      DELETE FROM background_jobs 
      WHERE 
        (completed_at IS NOT NULL OR (failed_at IS NOT NULL AND retry_count >= max_retries))
        AND updated_at < NOW() - INTERVAL '${olderThanHours} hours'
    `);
    
    const deletedCount = result.rowCount || 0;
    
    if (deletedCount > 0) {
      logger.info({ 
        deleted_count: deletedCount, 
        older_than_hours: olderThanHours 
      }, 'Cleaned up old background jobs');
    }
    
    return deletedCount;
    
  } catch (error) {
    logger.error({ error }, 'Failed to clean up old jobs');
    return 0;
  }
}

/**
 * Get job statistics
 */
export async function getJobStats(): Promise<{
  pending: number;
  processing: number;
  completed_today: number;
  failed_today: number;
}> {
  try {
    const result = await query(`
      SELECT 
        COUNT(*) FILTER (WHERE started_at IS NULL AND completed_at IS NULL AND failed_at IS NULL) as pending,
        COUNT(*) FILTER (WHERE started_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL) as processing,
        COUNT(*) FILTER (WHERE completed_at >= CURRENT_DATE) as completed_today,
        COUNT(*) FILTER (WHERE failed_at >= CURRENT_DATE AND retry_count >= max_retries) as failed_today
      FROM background_jobs
    `);
    
    return result.rows[0];
    
  } catch (error) {
    logger.error({ error }, 'Failed to get job stats');
    return { pending: 0, processing: 0, completed_today: 0, failed_today: 0 };
  }
}

// Global worker instance
let globalWorker: BackgroundJobWorker | null = null;

/**
 * Start the global background job worker
 */
export function startBackgroundJobWorker(): void {
  if (globalWorker) {
    logger.warn('Background job worker already started');
    return;
  }
  
  globalWorker = new BackgroundJobWorker();
  globalWorker.start().catch(error => {
    logger.error({ error }, 'Failed to start background job worker');
  });
}

/**
 * Stop the global background job worker
 */
export function stopBackgroundJobWorker(): void {
  if (globalWorker) {
    globalWorker.stop();
    globalWorker = null;
  }
}

/**
 * Get global worker status
 */
export function getBackgroundJobWorkerStatus() {
  return globalWorker ? globalWorker.getStatus() : { running: false, processingCount: 0, maxConcurrent: 0 };
}

// Periodic cleanup
setInterval(() => {
  cleanupOldJobs(24).catch(error => {
    logger.error({ error }, 'Failed to clean up old jobs');
  });
}, 60 * 60 * 1000); // Every hour
