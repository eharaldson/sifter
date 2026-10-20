import { logger } from '../log';

/**
 * Retry utility with exponential backoff and jitter
 * Used to make external service calls more resilient
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff (default: 500) */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds (default: 5000) */
  maxDelayMs?: number;
  /** Error patterns that should trigger a retry */
  retryableErrors?: string[];
  /** Optional context for logging */
  context?: Record<string, unknown>;
}

const DEFAULT_RETRYABLE_ERRORS = [
  'ETIMEDOUT',
  'ECONNRESET', 
  'ECONNREFUSED',
  'ENOTFOUND',
  '503',
  '429',
  '500',
  '502',
  '504',
  'AbortError',
  'socket hang up',
  'network error',
  'fetch failed',
];

/**
 * Execute a function with automatic retry on transient errors
 * Uses exponential backoff with jitter to prevent thundering herd
 * 
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => generateSemanticTextEmbedding(productData),
 *   { maxRetries: 3, baseDelayMs: 500, context: { productId: 123 } }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 500,
    maxDelayMs = 5000,
    retryableErrors = DEFAULT_RETRYABLE_ERRORS,
    context = {},
  } = options;

  let lastError: Error;
  const overallStartTime = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptStartTime = Date.now();
    
    // Log attempt start (except first attempt to reduce noise)
    if (attempt > 0) {
      logger.info({
        ...context,
        attempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        totalElapsedMs: Date.now() - overallStartTime,
      }, `🔄 Starting retry attempt ${attempt + 1}/${maxRetries + 1}`);
    }
    
    try {
      const result = await fn();
      const attemptDurationMs = Date.now() - attemptStartTime;
      
      // Log success with timing (especially if retries were needed)
      if (attempt > 0) {
        logger.info({
          ...context,
          attempt: attempt + 1,
          attemptDurationMs,
          totalDurationMs: Date.now() - overallStartTime,
        }, `✅ Retry attempt ${attempt + 1} succeeded after ${attemptDurationMs}ms`);
      }
      
      return result;
    } catch (error) {
      const attemptDurationMs = Date.now() - attemptStartTime;
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Check if error is retryable
      const errorString = `${lastError.message} ${lastError.name} ${(lastError as any).code || ''}`;
      const isRetryable = retryableErrors.some(pattern => 
        errorString.toLowerCase().includes(pattern.toLowerCase())
      );

      // Log the failure with timing details
      logger.warn({
        ...context,
        attempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        attemptDurationMs,
        totalElapsedMs: Date.now() - overallStartTime,
        error: lastError.message,
        errorName: lastError.name,
        errorCode: (lastError as any).code,
        isRetryable,
      }, `❌ Attempt ${attempt + 1} failed after ${attemptDurationMs}ms: ${lastError.message}`);

      // Don't retry if error is not retryable or we've exhausted attempts
      if (!isRetryable || attempt === maxRetries) {
        const totalDurationMs = Date.now() - overallStartTime;
        logger.error({
          ...context,
          totalAttempts: attempt + 1,
          maxAttempts: maxRetries + 1,
          totalDurationMs,
          error: lastError.message,
          errorCode: (lastError as any).code,
          isRetryable,
          reason: !isRetryable ? 'non-retryable error' : 'max retries exhausted',
        }, `💥 All retry attempts exhausted after ${totalDurationMs}ms`);
        throw lastError;
      }

      // Calculate delay with exponential backoff + jitter
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * baseDelayMs * 0.5; // Add up to 50% jitter
      const delay = Math.min(exponentialDelay + jitter, maxDelayMs);

      logger.info({
        ...context,
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        delayMs: Math.round(delay),
      }, `⏳ Waiting ${Math.round(delay)}ms before retry attempt ${attempt + 2}`);

      await sleep(delay);
    }
  }

  // TypeScript needs this even though it's unreachable
  throw lastError!;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wrap multiple promises with individual retry logic
 * Useful for parallel operations where each should retry independently
 * 
 * @example
 * ```ts
 * const [textEmb, imageEmb] = await withRetryAll([
 *   () => generateTextEmbedding(data),
 *   () => generateImageEmbedding(data),
 * ], { maxRetries: 3 });
 * ```
 */
export async function withRetryAll<T extends readonly (() => Promise<any>)[]>(
  fns: T,
  options: RetryOptions = {}
): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results = await Promise.all(
    fns.map((fn, index) => 
      withRetry(fn, { 
        ...options, 
        context: { ...options.context, operationIndex: index } 
      })
    )
  );
  return results as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

