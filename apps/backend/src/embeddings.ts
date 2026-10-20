import { logger } from './log';
import fetch, { type Response as FetchResponse } from 'node-fetch';
import FormData from 'form-data';
// Note: Using native AbortController (Node.js 16+) instead of polyfill for better compatibility
import { randomUUID } from 'crypto';
import { lookup } from 'dns/promises';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Semaphore } from './utils/semaphore';
import { generateSearchText } from './embed/search-text';
import { generateCleanTitle } from './embed/title-clean';
import { NormalizedProduct } from './match/normalize';
import { query } from './db';

function safeToString(value: unknown): string {
  try {
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function serializeUnknownError(error: unknown, maxCauseDepth = 3): Record<string, any> {
  const seen = new WeakSet<object>();

  const inner = (e: any, depth: number): any => {
    if (e === null || e === undefined) return e;
    if (typeof e !== 'object') return { value: safeToString(e) };
    if (seen.has(e)) return { circular: true };
    seen.add(e);

    const out: Record<string, any> = {};
    for (const key of [
      'name',
      'message',
      'type',
      'code',
      'errno',
      'syscall',
      'hostname',
      'address',
      'port',
      'status',
      'statusCode',
    ]) {
      if (e[key] !== undefined) out[key] = e[key];
    }

    if (typeof e.stack === 'string') out.stack = e.stack.substring(0, 2000);

    // node-fetch often stores the real socket/DNS error in `cause`
    if (e.cause && depth < maxCauseDepth) out.cause = inner(e.cause, depth + 1);

    return out;
  };

  return inner(error as any, 0);
}

async function dnsPreflight(hostname: string): Promise<Record<string, any>> {
  const start = Date.now();
  try {
    const addresses = await lookup(hostname, { all: true });
    return { ok: true, durationMs: Date.now() - start, addresses };
  } catch (e) {
    return { ok: false, durationMs: Date.now() - start, error: serializeUnknownError(e) };
  }
}

// OpenAI Text Embedding Service Configuration
const TEXT_EMBEDDING_SERVICE_URL = process.env.TEXT_EMBEDDING_SERVICE_URL || 'http://localhost:8001';
const TEXT_EMBEDDING_TIMEOUT = parseInt(process.env.TEXT_EMBEDDING_TIMEOUT || '10000'); // 10 seconds for text processing (reduced from 30s)
const TEXT_EMBEDDING_AUTO_START = false; // Default: true

// Concurrency limits to prevent event-loop stalls under high load
const TEXT_EMBEDDING_CONCURRENCY = parseInt(process.env.TEXT_EMBEDDING_CONCURRENCY || '6');

// SigLIP Image Embedding Service Configuration
const SIGLIP_SERVICE_URL = process.env.SIGLIP_SERVICE_URL || 'http://localhost:8002';
const SIGLIP_SERVICE_TIMEOUT = parseInt(process.env.SIGLIP_SERVICE_TIMEOUT || '15000'); // 15 seconds for image processing (reduced from 30s)
const SIGLIP_AUTO_START = false; // Default: true

const IMAGE_EMBEDDING_CONCURRENCY = parseInt(process.env.IMAGE_EMBEDDING_CONCURRENCY || '3');

// Health check configuration - configurable timeout
const HEALTH_CHECK_TIMEOUT = parseInt(process.env.HEALTH_CHECK_TIMEOUT || '10000'); // 10 seconds (increased from 5s)
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Global concurrency guards (module-scoped)
const textEmbeddingSemaphore = new Semaphore(
  Number.isFinite(TEXT_EMBEDDING_CONCURRENCY) && TEXT_EMBEDDING_CONCURRENCY > 0 ? TEXT_EMBEDDING_CONCURRENCY : 6
);
const imageEmbeddingSemaphore = new Semaphore(
  Number.isFinite(IMAGE_EMBEDDING_CONCURRENCY) && IMAGE_EMBEDDING_CONCURRENCY > 0 ? IMAGE_EMBEDDING_CONCURRENCY : 3
);

// OpenAI Text Embedding Service management
let textEmbeddingServiceProcess: ChildProcess | null = null;
let isTextEmbeddingServiceHealthy = false;
let isStartingTextEmbeddingService = false;
let isInTextEmbeddingStartupPhase = false;
let lastTextEmbeddingHealthCheck = 0;

// SigLIP Image Embedding Service management
let sigLipServiceProcess: ChildProcess | null = null;
let isSigLipServiceHealthy = false;
let isInSigLipStartupPhase = false;
let lastSigLipHealthCheck = 0;

// Types
export interface ProductData {
  id: number;
  gender?: string;
  title: string;
  brand?: string;
  color?: string;
  primary_material?: string;
  category?: string;
  sub_category?: string;
  description?: string;
  search_text?: string;
  image_url?: string;
}

export interface EmbeddingResult {
  text?: number[];
  image?: number[];
}

// ==================== OpenAI Text Embedding Functions ====================

// Text Embedding Service Health Check
export async function checkTextEmbeddingServiceHealth(): Promise<boolean> {
  const url = `${TEXT_EMBEDDING_SERVICE_URL}/health`;
  const requestId = randomUUID().slice(0, 12);
  const urlParts = (() => {
    try {
      const u = new URL(url);
      return { protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, pathname: u.pathname };
    } catch {
      return {};
    }
  })();
  const startTime = Date.now();
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, HEALTH_CHECK_TIMEOUT);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-request-id': requestId,
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      const health = await response.json() as any;
      const healthy = health.status === 'healthy';
      const totalDurationMs = Date.now() - startTime;
      isTextEmbeddingServiceHealthy = healthy;
      lastTextEmbeddingHealthCheck = Date.now();
      return healthy;
    } else {
      const totalDurationMs = Date.now() - startTime;
      
      isTextEmbeddingServiceHealthy = false;
      lastTextEmbeddingHealthCheck = Date.now();
      return false;
    }
  } catch (error) {
    const totalDurationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : 'Unknown';
    const isAbortError = error instanceof Error && error.name === 'AbortError';
    const isTimeoutError = isAbortError || errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT');

    const dns = (urlParts as any)?.hostname ? await dnsPreflight((urlParts as any).hostname) : undefined;
    
    // Always log with full details for debugging
    logger.error({ 
      url,
      requestId,
      ...urlParts,
      error: errorMessage,
      errorName,
      isAbortError,
      isTimeoutError,
      errorDetails: serializeUnknownError(error),
      dns,
      totalDurationMs,
      timeoutMs: HEALTH_CHECK_TIMEOUT,
      ServiceUrl: TEXT_EMBEDDING_SERVICE_URL,
      previousStatus: isTextEmbeddingServiceHealthy ? 'healthy' : 'unhealthy',
    }, `❌ Text embedding health check failed: ${isTimeoutError ? 'TIMEOUT' : errorName}`);
    
    isTextEmbeddingServiceHealthy = false;
    lastTextEmbeddingHealthCheck = Date.now();
    return false;
  }
}

// Fast health check using cached status for text embedding service
export function isTextEmbeddingServiceReady(): boolean {
  const now = Date.now();
  
  // Use cached status if recent
  if (now - lastTextEmbeddingHealthCheck < HEALTH_CHECK_INTERVAL) {
    return isTextEmbeddingServiceHealthy;
  }
  
  // If cache is stale, assume it might be ready and trigger a health check in the background
  checkTextEmbeddingServiceHealth().catch(error => {
  });
  
  // For now, assume service is ready to prevent embeddings from being skipped
  return true;
}

// Force a fresh health check for text embedding service
export async function forceTextEmbeddingServiceHealthCheck(): Promise<boolean> {
  return await checkTextEmbeddingServiceHealth();
}

// Get text embedding service information
export async function getTextEmbeddingServiceInfo(): Promise<any> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(`${TEXT_EMBEDDING_SERVICE_URL}/model-info`, {
      method: 'GET',
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      return await response.json();
    } else {
      throw new Error(`Service error: ${response.status}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return null;
  }
}

// Generate title embedding using OpenAI service with clean title
export async function generateTitleEmbedding(product: ProductData): Promise<number[]> {
  try {
    // Convert ProductData to NormalizedProduct for the title generation
    const normalizedProduct: NormalizedProduct = {
      title: product.title,
      brand: product.brand || null,
      description: product.description || null,
      search_text: product.search_text || null,
      price: 0, // Not used for embedding generation
      currency: 'USD', // Not used for embedding generation
      originalPrice: null, // Not used for embedding generation
      condition: 'new', // Not used for embedding generation
      category: product.category || null,
      subCategory: null, // Not available in ProductData
      color: product.color || null,
      gender: product.gender || null,
      primaryMaterial: product.primary_material || null,
      imageUrl: product.image_url || null,
      gtin: null,
      mpn: null,
      sku: null // Not available in ProductData
    };

    // Generate clean title using the title-clean function
    const cleanTitle = generateCleanTitle(normalizedProduct);

    // Quick service readiness check
    if (!isTextEmbeddingServiceReady()) {
      const isHealthy = await forceTextEmbeddingServiceHealthCheck();
      if (!isHealthy) {
        throw new Error('Text embedding service is not ready. Please ensure the service is running.');
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TEXT_EMBEDDING_TIMEOUT);
    
    const response = await fetch(`${TEXT_EMBEDDING_SERVICE_URL}/embed-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: cleanTitle }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({
        productId: product.id,
        status: response.status,
        statusText: response.statusText,
        responseBody: errorBody,
        cleanTitle
      }, '❌ Title embedding service returned error response');
      throw new Error(`Title embedding service error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as any;
    return result.embedding;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    logger.error({
      productId: product.id,
      error: errorMessage,
      stack: errorStack
    }, '❌ Title embedding generation failed');
    
    throw new Error(`Failed to generate title embedding: ${errorMessage}`);
  }
}

// Generate semantic text embedding using OpenAI service with search text
export async function generateSemanticTextEmbedding(product: ProductData): Promise<number[]> {
  const requestId = randomUUID().slice(0, 12);
  const embedUrl = `${TEXT_EMBEDDING_SERVICE_URL}/embed-text`;
  const urlParts = (() => {
    try {
      const u = new URL(embedUrl);
      return { protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, pathname: u.pathname };
    } catch {
      return {};
    }
  })();
  
  try {
    // Use the pre-stored search_text column from the database
    // If search_text is not available, fall back to generating it
    let searchText: string;
    
    if (product.search_text && product.search_text.trim()) {
      // Use the stored search_text from the database
      // Avoid logging the full search text (large strings can be expensive under load)
      searchText = product.search_text.trim();
    } else {
      // Fallback: generate search text dynamically (for backward compatibility)
      
      const normalizedProduct: NormalizedProduct = {
        title: product.title,
        brand: product.brand || null,
        description: product.description || null,
        search_text: null, // Will be generated
        price: 0, // Not used for embedding generation
        currency: 'USD', // Not used for embedding generation
        originalPrice: null, // Not used for embedding generation
        condition: 'new', // Not used for embedding generation
        category: product.category || null,
        subCategory: null, // Not available in ProductData
        color: product.color || null,
        primaryMaterial: product.primary_material || null,
        gender: product.gender || null,
        imageUrl: product.image_url || null,
        gtin: null,
        mpn: null,
        sku: null // Not available in ProductData
      };
      const llmExtraction = await generateSearchText(normalizedProduct);
      searchText = llmExtraction.description;
    }

    // Quick service readiness check
    if (!isTextEmbeddingServiceReady()) {
      const isHealthy = await forceTextEmbeddingServiceHealthCheck();
      if (!isHealthy) {
        throw new Error('Text embedding service is not ready. Please ensure the service is running.');
      }
    }

    // const startTime = Date.now();
    // const controller = new AbortController();
    
    // const timeoutId = setTimeout(() => {
    //   const nowMs = Date.now();
    //   const elapsedMs = nowMs - startTime;
    //   logger.error({
    //     productId: product.id,
    //     startTimeMs: startTime,
    //     nowMs,
    //     elapsedMs,
    //     timeoutMs: TEXT_EMBEDDING_TIMEOUT,
    //     url: TEXT_EMBEDDING_SERVICE_URL,
    //   }, `⏱️ Text embedding request timeout after ${elapsedMs}ms (configured: ${TEXT_EMBEDDING_TIMEOUT}ms) - aborting`);
    //   controller.abort();
    // }, TEXT_EMBEDDING_TIMEOUT);
    
    // const fetchStartTime = Date.now();
    // const setupDuration = fetchStartTime - startTime;
    
    // logger.info({
    //   productId: product.id,
    //   setupDurationMs: setupDuration,
    //   fetchStartTimeMs: fetchStartTime,
    // }, `📤 About to call fetch (setup took ${setupDuration}ms)`);

    // Cap concurrent in-flight requests to keep the event loop responsive under load
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TEXT_EMBEDDING_TIMEOUT);
    const release = await textEmbeddingSemaphore.acquire(controller.signal);

    const searchTextLength = searchText.length;
    const searchTextSample = searchText.substring(0, 120);

    let response: FetchResponse;
    const fetchStart = Date.now();
    try {
      response = await fetch(embedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': requestId,
        },
        body: JSON.stringify({ text: searchText }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
      release();
    }
    const fetchDurationMs = Date.now() - fetchStart;
    
    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({
        productId: product.id,
        status: response.status,
        statusText: response.statusText,
        responseBody: errorBody,
        searchTextLength,
        searchTextSample,
        requestId,
        fetchDurationMs,
      }, '❌ Semantic text embedding service returned error response');
      throw new Error(`Semantic text embedding service error: ${response.status} ${response.statusText}`);
    }

    const parseStartTime = Date.now();
    const result = await response.json() as any;
    const parseDuration = Date.now() - parseStartTime;
    
    return result.embedding;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : 'Unknown';
    const errorStack = error instanceof Error ? error.stack : undefined;
    const isAbortError = error instanceof Error && error.name === 'AbortError';

    const dns = (urlParts as any)?.hostname ? await dnsPreflight((urlParts as any).hostname) : undefined;
    
    logger.error({
      productId: product.id,
      requestId,
      embedUrl,
      ...urlParts,
      error: errorMessage,
      errorName,
      isAbortError,
      errorDetails: serializeUnknownError(error),
      dns,
      stack: errorStack?.substring(0, 500),
      textEmbeddingServiceUrl: TEXT_EMBEDDING_SERVICE_URL,
      textEmbeddingTimeout: TEXT_EMBEDDING_TIMEOUT,
    }, `❌ Semantic text embedding generation failed${isAbortError ? ' (timeout)' : ''}`);
    
    throw new Error(`Failed to generate semantic text embedding: ${errorMessage}`);
  }
}

// Generate batch title embeddings using OpenAI service
export async function generateBatchTitleEmbeddings(products: ProductData[]): Promise<number[][]> {
  try {
    if (products.length === 0) {
      return [];
    }

    if (products.length > 2048) {
      throw new Error('Batch size too large (maximum 2048 products allowed)');
    }

    // Generate clean titles for all products
    const cleanTitles = products.map(product => {
      const normalizedProduct: NormalizedProduct = {
        title: product.title,
        brand: product.brand || null,
        description: product.description || null,
        search_text: product.search_text || null,
        gender: product.gender || null,
        price: 0, // Not used for embedding generation
        currency: 'USD', // Not used for embedding generation
        originalPrice: null, // Not used for embedding generation
        condition: 'new', // Not used for embedding generation
        category: product.category || null,
        subCategory: null,
        color: product.color || null,
        primaryMaterial: product.primary_material || null,
        imageUrl: product.image_url || null,
        gtin: null,
        mpn: null,
        sku: null // Not available in ProductData
      };
      return generateCleanTitle(normalizedProduct);
    });

    // Quick service readiness check
    if (!isTextEmbeddingServiceReady()) {
      const isHealthy = await forceTextEmbeddingServiceHealthCheck();
      if (!isHealthy) {
        throw new Error('Text embedding service is not ready. Please ensure the service is running.');
      }
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TEXT_EMBEDDING_TIMEOUT * 2);
    
    const response = await fetch(`${TEXT_EMBEDDING_SERVICE_URL}/embed-batch-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ texts: cleanTitles }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({
        productCount: products.length,
        status: response.status,
        statusText: response.statusText,
        responseBody: errorBody
      }, '❌ Batch title embedding service returned error response');
      throw new Error(`Batch title embedding service error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as any;

    return result.embeddings;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    logger.error({
      productCount: products.length,
      error: errorMessage,
      stack: errorStack
    }, '❌ Batch title embedding generation failed');
    
    throw new Error(`Failed to generate batch title embeddings: ${errorMessage}`);
  }
}

// Generate batch semantic text embeddings using OpenAI service
export async function generateBatchSemanticTextEmbeddings(products: ProductData[]): Promise<number[][]> {
  try {
    if (products.length === 0) {
      return [];
    }

    if (products.length > 2048) {
      throw new Error('Batch size too large (maximum 2048 products allowed)');
    }

    // Use stored search_text from database, with fallback to generated text
    const searchTexts = await Promise.all(products.map(async product => {
      if (product.search_text && product.search_text.trim()) {
        // Use the stored search_text from the database
        return product.search_text.trim();
      } else {
        // Fallback: generate search text dynamically (for backward compatibility)
        const normalizedProduct: NormalizedProduct = {
          title: product.title,
          brand: product.brand || null,
          description: product.description || null,
          search_text: product.search_text || null, // Will be generated
          price: 0, // Not used for embedding generation
          currency: 'USD', // Not used for embedding generation
          originalPrice: null, // Not used for embedding generation
          condition: 'new', // Not used for embedding generation
          category: product.category || null,
          subCategory: null,
          color: product.color || null,
          gender: product.gender || null,
          primaryMaterial: product.primary_material || null,
          imageUrl: product.image_url || null,
          gtin: null,
          mpn: null,
          sku: null // Not available in ProductData
        };
        const llmExtraction = await generateSearchText(normalizedProduct);
        return llmExtraction.description;
      }
    }));

    // Quick service readiness check
    if (!isTextEmbeddingServiceReady()) {
      const isHealthy = await forceTextEmbeddingServiceHealthCheck();
      if (!isHealthy) {
        throw new Error('Text embedding service is not ready. Please ensure the service is running.');
      }
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TEXT_EMBEDDING_TIMEOUT * 2);
    
    const response = await fetch(`${TEXT_EMBEDDING_SERVICE_URL}/embed-batch-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ texts: searchTexts }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({
        productCount: products.length,
        status: response.status,
        statusText: response.statusText,
        responseBody: errorBody
      }, '❌ Batch semantic text embedding service returned error response');
      throw new Error(`Batch semantic text embedding service error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as any;
    const duration = Date.now() - startTime;

    return result.embeddings;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    logger.error({
      productCount: products.length,
      error: errorMessage,
      stack: errorStack
    }, '❌ Batch semantic text embedding generation failed');
    
    throw new Error(`Failed to generate batch semantic text embeddings: ${errorMessage}`);
  }
}

// Initialize and manage OpenAI Text Embedding Service
export async function initializeTextEmbeddingService(): Promise<void> {
  
  try {
    // Check if auto-start is enabled
    if (!TEXT_EMBEDDING_AUTO_START) {
      return;
    }

    // Check if service is already running
    const isHealthy = await checkTextEmbeddingServiceHealth();
    if (isHealthy) {
      return;
    }

    // Start the service if it's not running
    await startTextEmbeddingService();
    
    // Wait for service to become healthy with timeout
    const maxWaitTime = 60000; // 60 seconds
    const checkInterval = 2000; // 2 seconds
    let waited = 0;
    
    isInTextEmbeddingStartupPhase = true;
    
    while (waited < maxWaitTime) {
      const healthy = await checkTextEmbeddingServiceHealth();
      if (healthy) {
        isInTextEmbeddingStartupPhase = false;
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waited += checkInterval;
    }
    
    isInTextEmbeddingStartupPhase = false;
    throw new Error('Text embedding service failed to become healthy within timeout');
    
  } catch (error) {
    isInTextEmbeddingStartupPhase = false;
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, '❌ Failed to initialize text embedding service');
    throw error;
  }
}

// Start the text embedding service process
async function startTextEmbeddingService(): Promise<void> {
  if (textEmbeddingServiceProcess) {
    await cleanupTextEmbeddingService();
  }

  try {
    const serviceDir = path.join(__dirname, '../../embed-services/text-service');
    const startScript = path.join(serviceDir, 'start.sh');
    
    // Check if start script exists
    if (!fs.existsSync(startScript)) {
      throw new Error(`Text embedding service start script not found at ${startScript}`);
    }
    
    isStartingTextEmbeddingService = true;
    
    textEmbeddingServiceProcess = spawn('bash', [startScript], {
      cwd: serviceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Handle process output
    textEmbeddingServiceProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
      }
    });

    textEmbeddingServiceProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
      }
    });

    textEmbeddingServiceProcess.on('close', (code) => {
      textEmbeddingServiceProcess = null;
      isTextEmbeddingServiceHealthy = false;
      isStartingTextEmbeddingService = false;
    });

    textEmbeddingServiceProcess.on('error', (error) => {
      textEmbeddingServiceProcess = null;
      isTextEmbeddingServiceHealthy = false;
      isStartingTextEmbeddingService = false;
    });
    
  } catch (error) {
    isStartingTextEmbeddingService = false;
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, '❌ Failed to start text embedding service process');
    throw error;
  }
}

// Cleanup text embedding service
export async function cleanupTextEmbeddingService(): Promise<void> {  
  if (textEmbeddingServiceProcess) {
    try {
      // Send SIGTERM first
      textEmbeddingServiceProcess.kill('SIGTERM');
      
      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Force kill if still running
      if (textEmbeddingServiceProcess && !textEmbeddingServiceProcess.killed) {
        textEmbeddingServiceProcess.kill('SIGKILL');
      }
      
      textEmbeddingServiceProcess = null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, '❌ Error cleaning up text embedding service');
    }
  }
  
  isTextEmbeddingServiceHealthy = false;
  isStartingTextEmbeddingService = false;
  isInTextEmbeddingStartupPhase = false;
}

// ==================== End OpenAI Text Embedding Functions ====================

// ==================== SigLIP Image Embedding Functions ====================

// SigLIP Image Embedding Service Health Check
export async function checkSigLipServiceHealth(): Promise<boolean> {
  const url = `${SIGLIP_SERVICE_URL}/health`;
  const startTime = Date.now();
    
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, HEALTH_CHECK_TIMEOUT);
    
    const fetchStartTime = Date.now();
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    const fetchDurationMs = Date.now() - fetchStartTime;
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      const health = await response.json() as any;
      const healthy = health.status === 'healthy' && health.model_loaded;
      const totalDurationMs = Date.now() - startTime;

      isSigLipServiceHealthy = healthy;
      lastSigLipHealthCheck = Date.now();
      return healthy;
    } else {      
      isSigLipServiceHealthy = false;
      lastSigLipHealthCheck = Date.now();
      return false;
    }
  } catch (error) {
    const totalDurationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : 'Unknown';
    const isAbortError = error instanceof Error && error.name === 'AbortError';
    const isTimeoutError = isAbortError || errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT');
    
    // Always log with full details for debugging
    logger.error({ 
      url,
      error: errorMessage,
      errorName,
      isAbortError,
      isTimeoutError,
      totalDurationMs,
      timeoutMs: HEALTH_CHECK_TIMEOUT,
      previousStatus: isSigLipServiceHealthy ? 'healthy' : 'unhealthy',
    }, `❌ SigLIP health check failed: ${isTimeoutError ? 'TIMEOUT' : errorName}`);
    
    isSigLipServiceHealthy = false;
    lastSigLipHealthCheck = Date.now();
    return false;
  }
}

// Fast health check using cached status for SigLIP service
export function isSigLipServiceReady(): boolean {
  const now = Date.now();
  
  // Use cached status if recent
  if (now - lastSigLipHealthCheck < HEALTH_CHECK_INTERVAL) {
    return isSigLipServiceHealthy;
  }
  
  // If cache is stale, assume it might be ready and trigger a health check in the background
  checkSigLipServiceHealth().catch(error => {
  });
  
  // For now, assume service is ready to prevent embeddings from being skipped
  return true;
}

// Force a fresh health check for SigLIP service
export async function forceSigLipServiceHealthCheck(): Promise<boolean> {
  return await checkSigLipServiceHealth();
}

// Generate image embedding using SigLIP service
export async function generateSigLipImageEmbedding(product: ProductData): Promise<number[]> {
  const startTime = Date.now();

  try {
    if (!product.image_url) {
      throw new Error('No image URL available for embedding');
    }

    // Quick service readiness check
    const healthCheckStartTime = Date.now();
    if (!isSigLipServiceReady()) {
      const isHealthy = await forceSigLipServiceHealthCheck();
      const healthCheckDuration = Date.now() - healthCheckStartTime;
      if (!isHealthy) {
        logger.error({ 
          productId: product.id, 
          healthCheckDurationMs: healthCheckDuration 
        }, '❌ SigLIP service health check failed');
        throw new Error('SigLIP service is not ready. Please ensure the service is running.');
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, SIGLIP_SERVICE_TIMEOUT);

    // Cap concurrent in-flight image embedding requests
    const release = await imageEmbeddingSemaphore.acquire(controller.signal);
    
    const fetchStartTime = Date.now();
    let response: FetchResponse;
    try {
      response = await fetch(`${SIGLIP_SERVICE_URL}/embed-image-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          url: product.image_url,
          timeout: 15
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
      release();
    }
    const fetchDuration = Date.now() - fetchStartTime;

    if (!response.ok) {
      const errorBody = await response.text();
      const totalDuration = Date.now() - startTime;
      logger.error({
        productId: product.id,
        status: response.status,
        statusText: response.statusText,
        responseBody: errorBody,
        imageUrl: product.image_url,
        totalDurationMs: totalDuration,
        fetchDurationMs: fetchDuration,
      }, '❌ SigLIP service returned error response');
      throw new Error(`SigLIP service error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as any;

    return result.embedding;

  } catch (error) {
    const totalDuration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : 'Unknown';
    const errorStack = error instanceof Error ? error.stack : undefined;
    const isAbortError = error instanceof Error && error.name === 'AbortError';
    
    logger.error({
      productId: product.id,
      imageUrl: product.image_url,
      error: errorMessage,
      errorName,
      isAbortError,
      stack: errorStack?.substring(0, 500),
      totalDurationMs: totalDuration,
      sigLipServiceTimeout: SIGLIP_SERVICE_TIMEOUT,
    }, `❌ SigLIP image embedding generation failed${isAbortError ? ' (timeout)' : ''}`);
    
    throw new Error(`Failed to generate SigLIP image embedding: ${errorMessage}`);
  }
}

/**
 * Helper: Check if data is base64 image
 */
function isBase64Image(data: string): boolean {
  return data.startsWith('data:image/');
}

/**
 * Helper: Convert base64 to Buffer for Node.js fetch
 */
function base64ToBuffer(base64: string): { buffer: Buffer; mimeType: string } {
  const parts = base64.split(',');
  const mimeMatch = parts[0].match(/:(.*?);/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
  const base64Data = parts[1];
  const buffer = Buffer.from(base64Data, 'base64');
  return { buffer, mimeType };
}

/**
 * Generate image embedding from user-provided image (URL or base64)
 * This is specifically for user uploads, not for product images in the database
 */
export async function generateSigLipImageEmbeddingFromUserInput(imageData: string): Promise<number[]> {
  const startTime = Date.now();
  const isBase64 = isBase64Image(imageData);
  
  try {
    // Quick service readiness check
    if (!isSigLipServiceReady()) {
      const isHealthy = await forceSigLipServiceHealthCheck();
      if (!isHealthy) {
        throw new Error('SigLIP service is not ready. Please ensure the service is running.');
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SIGLIP_SERVICE_TIMEOUT);
    
    let response: FetchResponse;
    
    if (isBase64) {
      // Handle base64 image - send to /embed-image endpoint as multipart/form-data      
      const { buffer, mimeType } = base64ToBuffer(imageData);
      
      // Create form data with the image buffer
      const FormData = (await import('form-data')).default;
      const formData = new FormData();
      formData.append('file', buffer, {
        filename: 'upload.png',
        contentType: mimeType,
      });
      
      response = await fetch(`${SIGLIP_SERVICE_URL}/embed-image`, {
        method: 'POST',
        body: formData as any,
        signal: controller.signal,
      });
      
    } else {
      response = await fetch(`${SIGLIP_SERVICE_URL}/embed-image-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          url: imageData,
          timeout: 15
        }),
        signal: controller.signal,
      });
    }
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`SigLIP service error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as any;
    const duration = Date.now() - startTime;
    
    return result.embedding;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    throw new Error(`Failed to generate SigLIP image embedding from user input: ${errorMessage}`);
  }
}

// Generate text embedding using SigLIP service
export async function generateSigLipTextEmbedding(text: string): Promise<number[]> {
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SIGLIP_SERVICE_TIMEOUT);

    const response = await fetch(`${SIGLIP_SERVICE_URL}/embed-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        text: text
      }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({
        status: response.status,
        statusText: response.statusText,
        responseBody: errorBody,
        textLength: text.length,
        textSample: text.substring(0, 100)
      }, '❌ SigLIP text service returned error response');
      throw new Error(`SigLIP text service error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as any;
    const duration = Date.now() - startTime;
    
    return result.embedding;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    const duration = Date.now() - startTime;
    
    logger.error({
      text: text.substring(0, 100),
      error: errorMessage,
      stack: errorStack,
      duration: duration,
      sigLipServiceTimeout: SIGLIP_SERVICE_TIMEOUT,
      isAbortError: error instanceof Error && error.name === 'AbortError'
    }, '❌ SigLIP text embedding generation failed');
    
    throw new Error(`Failed to generate SigLIP text embedding: ${errorMessage}`);
  }
}

// Generate batch image embeddings using SigLIP service
export async function generateSigLipBatchImageEmbeddings(imageUrls: string[]): Promise<Array<number[] | null>> {
  try {
    if (imageUrls.length === 0) {
      return [];
    }

    if (imageUrls.length > 32) {
      throw new Error('Batch size too large (maximum 32 images allowed for SigLIP)');
    }

    // Quick service readiness check
    if (!isSigLipServiceReady()) {
      // Try a fresh health check before giving up
      const isHealthy = await forceSigLipServiceHealthCheck();
      if (!isHealthy) {
        throw new Error('SigLIP service is not ready. Please ensure the service is running.');
      }
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SIGLIP_SERVICE_TIMEOUT * 3); // Triple timeout for batch images

    const response = await fetch(`${SIGLIP_SERVICE_URL}/embed-batch-image-urls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        urls: imageUrls,
        timeout: 15, // 15 seconds per image
        max_concurrent: 5 // 5 concurrent downloads
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SigLIP service error: ${response.status} ${response.statusText}: ${errorText}`);
    }

    const result = await response.json() as any;

    return result.embeddings;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    logger.error({
      imageCount: imageUrls.length,
      error: errorMessage,
      stack: errorStack
    }, '❌ SigLIP batch image embedding generation failed');
    
    throw new Error(`Failed to generate SigLIP batch image embeddings: ${errorMessage}`);
  }
}

// Get SigLIP service information
export async function getSigLipServiceInfo(): Promise<any> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(`${SIGLIP_SERVICE_URL}/model-info`, {
      method: 'GET',
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      return await response.json();
    } else {
      throw new Error(`Service error: ${response.status}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return null;
  }
}

// Initialize and manage SigLIP Image Embedding Service
export async function initializeImageEmbeddingService(): Promise<void> {
  
  try {
    // Check if auto-start is enabled
    if (!SIGLIP_AUTO_START) {
      return;
    }

    // Check if service is already running
    const isHealthy = await checkSigLipServiceHealth();
    if (isHealthy) {
      return;
    }

    // Start the service if it's not running
    await startSigLipService();
    
    // Wait for service to become healthy with timeout
    const maxWaitTime = 90000; // 90 seconds (image models take longer to load)
    const checkInterval = 3000; // 3 seconds
    let waited = 0;
    
    isInSigLipStartupPhase = true;
    
    while (waited < maxWaitTime) {
      const healthy = await checkSigLipServiceHealth();
      if (healthy) {
        isInSigLipStartupPhase = false;
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waited += checkInterval;
    }
    
    isInSigLipStartupPhase = false;
    throw new Error('SigLIP image embedding service failed to become healthy within timeout');
    
  } catch (error) {
    isInSigLipStartupPhase = false;
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, '❌ Failed to initialize SigLIP image embedding service');
    throw error;
  }
}

// Start the SigLIP image embedding service process
async function startSigLipService(): Promise<void> {
  if (sigLipServiceProcess) {
    await cleanupImageEmbeddingService();
  }

  try {
    const serviceDir = path.join(__dirname, '../../embed-services/image-service');
    const startScript = path.join(serviceDir, 'start.sh');
    
    // Check if start script exists
    if (!fs.existsSync(startScript)) {
      throw new Error(`SigLIP image embedding service start script not found at ${startScript}`);
    }
    
    sigLipServiceProcess = spawn('bash', [startScript], {
      cwd: serviceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Handle process output
    sigLipServiceProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
      }
    });

    sigLipServiceProcess.stderr?.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
      }
    });

    sigLipServiceProcess.on('close', (code) => {
      sigLipServiceProcess = null;
      isSigLipServiceHealthy = false;
    });

    sigLipServiceProcess.on('error', (error) => {
      logger.error({ error: error.message }, 'SigLIP image embedding service process error');
      sigLipServiceProcess = null;
      isSigLipServiceHealthy = false;
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, '❌ Failed to start SigLIP image embedding service process');
    throw error;
  }
}

// Cleanup SigLIP image embedding service
export async function cleanupImageEmbeddingService(): Promise<void> {
  
  if (sigLipServiceProcess) {
    try {
      // Send SIGTERM first
      sigLipServiceProcess.kill('SIGTERM');
      
      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Force kill if still running
      if (sigLipServiceProcess && !sigLipServiceProcess.killed) {
        sigLipServiceProcess.kill('SIGKILL');
      }
      
      sigLipServiceProcess = null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, '❌ Error cleaning up SigLIP image embedding service');
    }
  }
  
  isSigLipServiceHealthy = false;
  isInSigLipStartupPhase = false;
}

// ==================== End SigLIP Image Embedding Functions ====================


// Generate embeddings for search queries
export async function generateSearchEmbedding(query: string): Promise<number[]> {
  const productData: ProductData = { id: 0, title: query };
  return generateSemanticTextEmbedding(productData);
}

// Utility function to validate embedding dimensions
export function validateEmbeddingDimension(embedding: number[], expectedDim: number): boolean {
  return Array.isArray(embedding) && embedding.length === expectedDim;
}

// Utility function to validate OpenAI text embedding dimensions
export function validateTextEmbeddingDimension(embedding: number[]): boolean {
  return validateEmbeddingDimension(embedding, 768); // gemini-embedding-001
}

// Utility function to validate SigLIP embedding dimensions
export function validateSigLipEmbeddingDimension(embedding: number[]): boolean {
  return validateEmbeddingDimension(embedding, 1152); // SigLIP ViT-SO400M-14 dimension
}

/**
 * Process embeddings for a product (for use by the embedding worker)
 * Fetches product data, generates embeddings, and updates the database
 */
export async function processProductEmbeddings(
  productId: number, 
  type: 'text' | 'image' | 'both' = 'both'
): Promise<EmbeddingResult> {
  const result: EmbeddingResult = {};
  
  try {
    // Fetch product data from database
    const productQuery = `
      SELECT id, title, brand, description, search_text, color, primary_material as material, category, image_url
      FROM products 
      WHERE id = $1
    `;
    
    const productResult = await query(productQuery, [productId]);
    
    if (productResult.rows.length === 0) {
      throw new Error(`Product with ID ${productId} not found`);
    }
    
    const product: ProductData = productResult.rows[0];
    
    // Generate text embedding if requested
    if (type === 'text' || type === 'both') {
      try {
        const textEmbedding = await generateSemanticTextEmbedding(product);
        
        // Update database with text embedding (using embedding_text_semantic for the main text embedding)
        await query(
          `UPDATE products SET embedding_text_semantic = $1, embedding_text_semantic_updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(textEmbedding), productId]
        );
        
        result.text = textEmbedding;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Failed to generate text embedding for product ${productId}: ${errorMessage}`);
        throw error;
      }
    }
    
    // Generate image embedding if requested
    if (type === 'image' || type === 'both') {
      try {
        const imageEmbedding = await generateSigLipImageEmbedding(product);
        
        // Update database with image embedding
        await query(
          `UPDATE products SET embedding_image = $1, embedding_image_updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(imageEmbedding), productId]
        );
        
        result.image = imageEmbedding;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`❌ Failed to generate image embedding for product ${productId}: ${errorMessage}`);
        throw error;
      }
    }
    
    return result;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`💥 Failed to process embeddings for product ${productId}: ${errorMessage}`);
    throw error;
  }
}

/**
 * Process batch text embeddings for multiple products
 */
export async function processBatchTextEmbeddings(productIds: number[]): Promise<{
  successful: number;
  failed: number;
  errors: Array<{ productId: number; error: string }>;
}> {
  const errors: Array<{ productId: number; error: string }> = [];
  let successful = 0;
    
  try {
    // Fetch product data for all products
    const productQuery = `
      SELECT id, title, brand, description, search_text, color, primary_material, category
      FROM products 
      WHERE id = ANY($1)
      ORDER BY id
    `;
    
    const productResult = await query(productQuery, [productIds]);
    const products: ProductData[] = productResult.rows;
    
    if (products.length === 0) {
      throw new Error('No products found for the given IDs');
    }

    // Generate batch embeddings
    const embeddings = await generateBatchSemanticTextEmbeddings(products);
    
    // Update database with embeddings
    const updatePromises = products.map(async (product, index) => {
      try {
        const embedding = embeddings[index];
        if (embedding && embedding.length > 0) {
          await query(
            `UPDATE products SET embedding_text_semantic = $1, embedding_text_semantic_updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(embedding), product.id]
          );
          successful++;
        } else {
          throw new Error('Empty embedding returned');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ productId: product.id, error: errorMessage });
        logger.error(`❌ Failed to update text embedding for product ${product.id}: ${errorMessage}`);
      }
    });
    
    await Promise.all(updatePromises);
    
    return { successful, failed: errors.length, errors };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`💥 Failed to process batch text embeddings: ${errorMessage}`);
    throw error;
  }
}

/**
 * Process batch image embeddings for multiple products
 */
export async function processBatchImageEmbeddings(productIds: number[]): Promise<{
  successful: number;
  failed: number;
  errors: Array<{ productId: number; error: string }>;
}> {
  const errors: Array<{ productId: number; error: string }> = [];
  let successful = 0;
    
  try {
    // Fetch product data for all products with image URLs
    const productQuery = `
      SELECT id, title, image_url
      FROM products 
      WHERE id = ANY($1) AND image_url IS NOT NULL AND image_url != ''
      ORDER BY id
    `;
    
    const productResult = await query(productQuery, [productIds]);
    const products: ProductData[] = productResult.rows;
    
    if (products.length === 0) {
      return { successful: 0, failed: productIds.length, errors: [] };
    }
    
    // Extract image URLs
    const imageUrls = products.map(product => product.image_url!);
    
    // Generate batch embeddings
    const embeddings = await generateSigLipBatchImageEmbeddings(imageUrls);
    
    // Update database with embeddings
    const updatePromises = products.map(async (product, index) => {
      try {
        const embedding = embeddings[index];
        if (embedding && embedding.length > 0) {
          await query(
            `UPDATE products SET embedding_image = $1, embedding_image_updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(embedding), product.id]
          );
          successful++;
        } else {
          throw new Error('Empty or null embedding returned');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ productId: product.id, error: errorMessage });
        logger.error(`❌ Failed to update image embedding for product ${product.id}: ${errorMessage}`);
      }
    });
    
    await Promise.all(updatePromises);
    
    // Add errors for products without image URLs
    const productsWithImages = new Set(products.map(p => p.id));
    productIds.forEach(id => {
      if (!productsWithImages.has(id)) {
        errors.push({ productId: id, error: 'No image URL available' });
      }
    });
    
    return { successful, failed: errors.length, errors };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`💥 Failed to process batch image embeddings: ${errorMessage}`);
    throw error;
  }
}

/**
 * Get all products without a text embedding
 */
export async function getProductsWithoutSemanticTextEmbedding(
  batchSize: number, 
  offset: number = 0
): Promise<ProductData[]> {
  const result = await query(`
    SELECT id, title, brand, color, primary_material, category, description, search_text, image_url
    FROM products 
    WHERE embedding_text_semantic IS NULL
    LIMIT ${batchSize} OFFSET ${offset}
  `);
  return result.rows;
}

/**
 * Get all products without a title embedding
 */
export async function getProductsWithoutTitleEmbedding(
  batchSize: number, 
  offset: number = 0
): Promise<ProductData[]> {
  const result = await query(`
    SELECT id, title, brand, color, primary_material, category, description, search_text, image_url
    FROM products 
    WHERE embedding_title IS NULL
    LIMIT ${batchSize} OFFSET ${offset}
  `);
  return result.rows;
}

/**
 * Get all products without a text embedding
 */
export async function getProductsWithoutImageEmbedding(
  batchSize: number, 
  offset: number = 0
): Promise<ProductData[]> {
  const result = await query(`
    SELECT id, title, brand, color, primary_material, category, description, search_text, image_url
    FROM products 
    WHERE embedding_image IS NULL
    LIMIT ${batchSize} OFFSET ${offset}
  `);
  return result.rows;
}

/**
 * Process batch title embeddings for multiple products
 */
export async function processBatchTitleEmbeddings(productIds: number[]): Promise<{
  successful: number;
  failed: number;
  errors: Array<{ productId: number; error: string }>;
}> {
  const errors: Array<{ productId: number; error: string }> = [];
  let successful = 0;
    
  try {
    // Fetch product data for all products
    const productQuery = `
      SELECT id, title, brand, description, color, primary_material as material, category
      FROM products 
      WHERE id = ANY($1)
      ORDER BY id
    `;
    
    const productResult = await query(productQuery, [productIds]);
    const products: ProductData[] = productResult.rows;
    
    if (products.length === 0) {
      throw new Error('No products found for the given IDs');
    }
    
    // Generate batch embeddings
    const embeddings = await generateBatchTitleEmbeddings(products);
    
    // Update database with embeddings
    const updatePromises = products.map(async (product, index) => {
      try {
        const embedding = embeddings[index];
        if (embedding && embedding.length > 0) {
          await query(
            `UPDATE products SET embedding_title = $1, embedding_title_updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(embedding), product.id]
          );
          successful++;
        } else {
          throw new Error('Empty embedding returned');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ productId: product.id, error: errorMessage });
        logger.error(`❌ Failed to update title embedding for product ${product.id}: ${errorMessage}`);
      }
    });
    
    await Promise.all(updatePromises);
    
    return { successful, failed: errors.length, errors };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`💥 Failed to process batch title embeddings: ${errorMessage}`);
    throw error;
  }
}

/**
 * Process batch semantic text embeddings for multiple products
 */
export async function processBatchSemanticTextEmbeddings(productIds: number[]): Promise<{
  successful: number;
  failed: number;
  errors: Array<{ productId: number; error: string }>;
}> {
  const errors: Array<{ productId: number; error: string }> = [];
  let successful = 0;
    
  try {
    // Fetch product data for all products
    const productQuery = `
      SELECT id, title, brand, description, search_text, color, primary_material as material, category
      FROM products 
      WHERE id = ANY($1)
      ORDER BY id
    `;
    
    const productResult = await query(productQuery, [productIds]);
    const products: ProductData[] = productResult.rows;
    
    if (products.length === 0) {
      throw new Error('No products found for the given IDs');
    }
    
    // Generate batch embeddings
    const embeddings = await generateBatchSemanticTextEmbeddings(products);
    
    // Update database with embeddings
    const updatePromises = products.map(async (product, index) => {
      try {
        const embedding = embeddings[index];
        if (embedding && embedding.length > 0) {
          await query(
            `UPDATE products SET embedding_text_semantic = $1, embedding_text_semantic_updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(embedding), product.id]
          );
          successful++;
        } else {
          throw new Error('Empty embedding returned');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ productId: product.id, error: errorMessage });
        logger.error(`❌ Failed to update semantic text embedding for product ${product.id}: ${errorMessage}`);
      }
    });
    
    await Promise.all(updatePromises);
    
    return { successful, failed: errors.length, errors };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`💥 Failed to process batch semantic text embeddings: ${errorMessage}`);
    throw error;
  }
}