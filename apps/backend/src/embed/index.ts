import { logger } from '../log';
import { query } from '../db';
import { generateSigLipImageEmbedding, validateEmbeddingDimension, validateTextEmbeddingDimension, validateSigLipEmbeddingDimension, generateSemanticTextEmbedding } from '../embeddings';
import { createHash } from 'crypto';
import fetch from 'node-fetch';
import sharp from 'sharp';
import { AbortController } from 'abort-controller';

// LRU Cache implementation
class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.cache = new Map();
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      // Update existing key
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Remove least recently used (first item)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// Cache instances
const textEmbeddingCache = new LRUCache<string, number[]>(1000);
const imageEmbeddingCache = new LRUCache<string, number[]>(500);
const contextEmbeddingCache = new LRUCache<string, { text: number[]; image: number[] }>(100);

// Configuration
const IMAGE_FETCH_TIMEOUT = 2000; // 2 seconds
const MAX_IMAGE_SIZE = 1024 * 1024; // 1MB
const MAX_IMAGE_DIMENSION = 512; // Resize images larger than this

// Types
export interface EmbedRequest {
  userQuery: string;
  freeText?: string;
  imageUrl?: string;
  pageContext?: {
    productId?: string;
  };
}

export interface BranchQueryVectors {
  textBranch: number[];
  imageBranch: number[];
  hasUserImage: boolean;
  hasContext: boolean;
  weights: {
    textBranch: { alpha_t: number; alpha_c: number };
    imageBranch: { beta_i: number; beta_c: number };
  };
}

export interface EmbedResult {
  textQuery: number[];
  imageQuery?: number[];
  contextText?: number[];
  contextImage?: number[];
  branchVectors: BranchQueryVectors;
  components: {
    text: {
      embedding: number[];
      source: 'query' | 'freeText';
      cached: boolean;
    };
    image?: {
      embedding: number[];
      url: string;
      cached: boolean;
      processed: boolean;
    };
    context?: {
      textEmbedding: number[];
      imageEmbedding: number[];
      productId: string;
      cached: boolean;
    };
  };
  cacheHits: number;
  totalComponents: number;
}

// Utility functions
function createTextHash(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex').substring(0, 16);
}

function createImageHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').substring(0, 16);
}

function createContextHash(productId: string): string {
  return createHash('sha256').update(`context:${productId}`).digest('hex').substring(0, 16);
}

// Vector operations
function l2Normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) {
    return vector; // Avoid division by zero
  }
  return vector.map(val => val / magnitude);
}

function combineAndNormalize(vectors: Array<{ vector: number[]; weight: number }>): number[] {
  if (vectors.length === 0) {
    throw new Error('Cannot combine empty vector array');
  }

  if (vectors.length === 1) {
    return l2Normalize(vectors[0].vector);
  }

  const dimension = vectors[0].vector.length;
  const result = new Array(dimension).fill(0);

  // Weighted combination
  for (const { vector, weight } of vectors) {
    for (let i = 0; i < dimension; i++) {
      result[i] += vector[i] * weight;
    }
  }

  // L2 normalize the result
  return l2Normalize(result);
}

// Text embedding with caching
async function getSemanticTextEmbedding(text: string, source: 'query' | 'freeText'): Promise<{ embedding: number[]; cached: boolean }> {
  const hash = createTextHash(text);
  
  // Check cache first
  const cached = textEmbeddingCache.get(hash);
  if (cached) {
    logger.debug({ hash, source, textLength: text.length }, '📖 Text embedding cache hit');
    return { embedding: cached, cached: true };
  }

  // Generate new embedding
  const startTime = Date.now();
  
  const embedding = await generateSemanticTextEmbedding({
    id: 0,
    title: text,
    search_text: text
  });

  const duration = Date.now() - startTime;
  
  // Validate and cache (embeddings are now pre-normalized by service)
  if (!validateTextEmbeddingDimension(embedding)) {
    throw new Error(`Invalid text embedding dimension: ${embedding.length}`);
  }

  textEmbeddingCache.set(hash, embedding);

  return { embedding: embedding, cached: false };
}

// Image processing and embedding with caching
async function getImageEmbedding(imageUrl: string): Promise<{ embedding: number[]; cached: boolean; processed: boolean }> {
  const hash = createImageHash(imageUrl);
  
  // Check cache first
  const cached = imageEmbeddingCache.get(hash);
  if (cached) {
    logger.debug({ hash, imageUrl }, '🖼️ Image embedding cache hit');
    return { embedding: cached, cached: true, processed: false };
  }

  // Fetch and process image
  const startTime = Date.now();
  
  let processed = false;
  let imageBuffer: Buffer;

  try {
    // Fetch image with timeout and size limit
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT);

    const response = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FindBot/1.0)',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE) {
      throw new Error(`Image too large: ${contentLength} bytes (max ${MAX_IMAGE_SIZE})`);
    }

    imageBuffer = await response.buffer();
    
    // Check actual size
    if (imageBuffer.length > MAX_IMAGE_SIZE) {
      throw new Error(`Image too large: ${imageBuffer.length} bytes (max ${MAX_IMAGE_SIZE})`);
    }

    logger.debug({
      hash,
      originalSize: imageBuffer.length,
      contentType: response.headers.get('content-type')
    }, '📊 Image downloaded successfully');

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn({ hash, imageUrl, error: errorMessage }, '⚠️ Image fetch failed');
    throw new Error(`Failed to fetch image: ${errorMessage}`);
  }

  try {
    // Process image with Sharp
    let processedBuffer = imageBuffer;
    const metadata = await sharp(imageBuffer).metadata();
    
    logger.debug({
      hash,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      format: metadata.format
    }, '🔍 Image metadata');

    // Resize if image is too large
    if (metadata.width && metadata.height && 
        (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION)) {

      processedBuffer = await sharp(imageBuffer)
        .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: 85 })
        .toBuffer();

      processed = true;
    }

    // Generate embedding
    const embedding = await generateSigLipImageEmbedding({
      id: 0,
      title: 'image',
      image_url: imageUrl,
    });

    const duration = Date.now() - startTime;

    // Validate and cache (embeddings are now pre-normalized by service)
    if (!validateSigLipEmbeddingDimension(embedding)) {
      throw new Error(`Invalid image embedding dimension: ${embedding.length}`);
    }

    imageEmbeddingCache.set(hash, embedding);

    return { embedding: embedding, cached: false, processed };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ hash, imageUrl, error: errorMessage }, '❌ Image processing/embedding failed');
    throw new Error(`Failed to process image: ${errorMessage}`);
  }
}

// Context embedding with caching (returns separate text and image embeddings)
async function getContextEmbeddings(productId: string): Promise<{ textEmbedding: number[]; imageEmbedding: number[]; cached: boolean }> {
  const hash = createContextHash(productId);
  
  // Check cache first
  const cached = contextEmbeddingCache.get(hash);
  if (cached) {
    logger.debug({ hash, productId }, '🔗 Context embeddings cache hit');
    return { textEmbedding: cached.text, imageEmbedding: cached.image, cached: true };
  }

  // Fetch product embeddings from database
  const startTime = Date.now();

  try {
    const result = await query(
      `SELECT embedding_text_semantic, embedding_image 
       FROM products 
       WHERE id = $1`,
      [productId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Product not found: ${productId}`);
    }

    const { embedding_text_semantic, embedding_image } = result.rows[0];
    
    if (!embedding_text_semantic && !embedding_image) {
      throw new Error(`No embeddings available for product: ${productId}`);
    }

    // Parse stored embeddings from database (pgvector returns them as strings)
    const textEmbedding = embedding_text_semantic 
      ? JSON.parse(embedding_text_semantic) 
      : new Array(768).fill(0);
    const imageEmbedding = embedding_image 
      ? JSON.parse(embedding_image) 
      : new Array(1152).fill(0);

    // Validate and cache
    if (!validateTextEmbeddingDimension(textEmbedding) || !validateSigLipEmbeddingDimension(imageEmbedding)) {
      throw new Error(`Invalid context embedding dimensions: text=${textEmbedding.length}, image=${imageEmbedding.length}`);
    }

    contextEmbeddingCache.set(hash, { text: textEmbedding, image: imageEmbedding });

    return { textEmbedding: textEmbedding, imageEmbedding: imageEmbedding, cached: false };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ hash, productId, error: errorMessage }, '❌ Context embeddings fetch failed');
    throw new Error(`Failed to fetch context embeddings: ${errorMessage}`);
  }
}

// Create branch-specific query vectors
function createBranchQueryVectors(
  textQuery: number[],
  imageQuery?: number[],
  contextText?: number[],
  contextImage?: number[]
): BranchQueryVectors {
  const hasUserImage = !!imageQuery;
  const hasContext = !!(contextText || contextImage);

  // Set weights based on query signals
  let weights: BranchQueryVectors['weights'];
  
  if (hasUserImage) {
    // User provided an image
    weights = {
      textBranch: { alpha_t: 0.8, alpha_c: 0.2 },
      imageBranch: { beta_i: 0.8, beta_c: 0.2 }
    };
  } else {
    // No user image - text branch only or context-based image branch
    weights = {
      textBranch: { alpha_t: 0.8, alpha_c: 0.2 },
      imageBranch: { beta_i: 0.0, beta_c: 1.0 } // Use only context for image branch
    };
  }

  // Create text branch vector: t_branch_q = normalize(α_t * t_q + α_c * c_q)
  const textBranchVectors = [{ vector: textQuery, weight: weights.textBranch.alpha_t }];
  if (hasContext && contextText) {
    textBranchVectors.push({ vector: contextText, weight: weights.textBranch.alpha_c });
  }
  const textBranch = combineAndNormalize(textBranchVectors);

  // Create image branch vector: i_branch_q = normalize(β_i * i_q + β_c * c_q_image)
  let imageBranch: number[];
  if (hasUserImage && imageQuery) {
    const imageBranchVectors = [{ vector: imageQuery, weight: weights.imageBranch.beta_i }];
    if (hasContext && contextImage) {
      imageBranchVectors.push({ vector: contextImage, weight: weights.imageBranch.beta_c });
    }
    imageBranch = combineAndNormalize(imageBranchVectors);
  } else if (hasContext && contextImage) {
    // No user image, use context image for image branch (already normalized)
    imageBranch = contextImage;
  } else {
    // No image query and no context image - use text query as fallback
    imageBranch = textQuery;
  }

  return {
    textBranch,
    imageBranch,
    hasUserImage,
    hasContext,
    weights
  };
}

// Main embedding service function
export async function embedQuery(request: EmbedRequest): Promise<EmbedResult> {
  const startTime = Date.now();
  const { userQuery, freeText, imageUrl, pageContext } = request;
  
  try {
    let cacheHits = 0;
    let totalComponents = 0;

    // 1. Text embedding (required)
    const textInput = freeText || userQuery;
    const textSource = freeText ? 'freeText' : 'query';
    
    const textResult = await getSemanticTextEmbedding(textInput, textSource);
    const components: EmbedResult['components'] = {
      text: {
        embedding: textResult.embedding,
        source: textSource,
        cached: textResult.cached
      }
    };
    totalComponents++;
    if (textResult.cached) cacheHits++;

    // 2. Image embedding (optional)
    let imageEmbedding: number[] | undefined;
    if (imageUrl) {
      try {
        const imageResult = await getImageEmbedding(imageUrl);
        components.image = {
          embedding: imageResult.embedding,
          url: imageUrl,
          cached: imageResult.cached,
          processed: imageResult.processed
        };
        imageEmbedding = imageResult.embedding;
        totalComponents++;
        if (imageResult.cached) cacheHits++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn({ imageUrl, error: errorMessage }, '⚠️ Image embedding failed, proceeding without user image');
        // Continue without user image
      }
    }

    // 3. Context embeddings (optional)
    let contextText: number[] | undefined;
    let contextImage: number[] | undefined;
    if (pageContext?.productId) {
      try {
        const contextResult = await getContextEmbeddings(pageContext.productId);
        components.context = {
          textEmbedding: contextResult.textEmbedding,
          imageEmbedding: contextResult.imageEmbedding,
          productId: pageContext.productId,
          cached: contextResult.cached
        };
        contextText = contextResult.textEmbedding;
        contextImage = contextResult.imageEmbedding;
        totalComponents++;
        if (contextResult.cached) cacheHits++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn({ 
          productId: pageContext.productId, 
          error: errorMessage 
        }, '⚠️ Context embeddings failed, proceeding without context');
        // Continue without context
      }
    }

    // 4. Create branch-specific query vectors
    const branchVectors = createBranchQueryVectors(
      textResult.embedding,
      imageEmbedding,
      contextText,
      contextImage
    );

    const totalDuration = Date.now() - startTime;

    return {
      textQuery: textResult.embedding,
      imageQuery: imageEmbedding,
      contextText,
      contextImage,
      branchVectors,
      components,
      cacheHits,
      totalComponents
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    logger.error({
      error: errorMessage,
      stack: errorStack,
      duration: Date.now() - startTime
    }, '❌ Branch-specific query embedding failed');
    
    throw new Error(`Failed to embed query: ${errorMessage}`);
  }
}

// Cache management functions
export function getCacheStats() {
  return {
    text: {
      size: textEmbeddingCache.size(),
      capacity: 1000
    },
    image: {
      size: imageEmbeddingCache.size(),
      capacity: 500
    },
    context: {
      size: contextEmbeddingCache.size(),
      capacity: 100
    }
  };
}

export function clearCaches() {
  textEmbeddingCache.clear();
  imageEmbeddingCache.clear();
  contextEmbeddingCache.clear();
}

// Health check function
export async function healthCheck(): Promise<{ healthy: boolean; details: any }> {
  try {
    // Test basic text embedding
    const testResult = await embedQuery({
      userQuery: 'test query'
    });

    return {
      healthy: true,
      details: {
        textEmbeddingDimension: testResult.textQuery.length,
        textBranchDimension: testResult.branchVectors.textBranch.length,
        imageBranchDimension: testResult.branchVectors.imageBranch.length,
        cacheStats: getCacheStats(),
        hasUserImage: testResult.branchVectors.hasUserImage,
        hasContext: testResult.branchVectors.hasContext
      }
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      healthy: false,
      details: {
        error: errorMessage,
        cacheStats: getCacheStats()
      }
    };
  }
}