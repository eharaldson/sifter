import { PoolClient } from 'pg';
import pino from 'pino';
import { query, transaction } from '../db';
import { logger } from '../log';
import { NormalizedProduct } from './normalize';
import { onProductCreated, onProductUpdated } from '../hooks/products';
import { generateCleanTitle } from '../embed/title-clean';
import { generateSearchText, LLMProductExtraction } from '../embed/search-text';
import { currencyService } from '../services/currencyService';
import { generateSemanticTextEmbedding, generateSigLipImageEmbedding, ProductData, validateTextEmbeddingDimension, validateSigLipEmbeddingDimension } from '../embeddings';
import { mapSizeToStandard, SizeMappingContext } from '../shared/size-mapper';
import { withRetry } from '../utils/retry';
import { textEmbeddingCircuit, imageEmbeddingCircuit, CircuitBreakerError } from '../utils/circuitBreaker';

export interface MatchResult {
  product_id: number;
  offer_id: number;
  created: boolean;
  matched_via: string;
  scores: Record<string, number | string | boolean>;
  retailer_id: number;
}

export interface ProductCandidate {
  product_id: number;
  title: string;
  brand: string | null;
  color: string | null;
  trgm_score: number;
  cosine_score?: number;
  image_cosine_score?: number;
}

export interface ResolveConfig {
  trgmMinThreshold: number;
  cosineMinTextThreshold: number;
  cosineMinImageThreshold: number;
  cosineMinAverageThreshold: number;
  maxCandidates: number;
}

const DEFAULT_CONFIG: ResolveConfig = {
  trgmMinThreshold: parseFloat(process.env.TRGM_MIN_THRESHOLD || '0.55'),
  cosineMinTextThreshold: parseFloat(process.env.COSINE_MIN_TEXT_THRESHOLD || '0.70'),
  cosineMinImageThreshold: parseFloat(process.env.COSINE_MIN_IMAGE_THRESHOLD || '0.932'),
  cosineMinAverageThreshold: parseFloat(process.env.COSINE_MIN_AVERAGE_THRESHOLD || '0.75'),
  maxCandidates: 50,
};

/**
 * Check color consistency between two products for matching
 */
export function checkColorConsistency(color1: string | null | undefined, color2: string | null | undefined): {
  canMatch: boolean;
  matchType: 'exact' | 'missing' | 'conflict';
} {
  // Normalize colors (treat empty/whitespace strings as null)
  const normalizedColor1 = color1?.trim() || null;
  const normalizedColor2 = color2?.trim() || null;
  
  // Both colors are null - allow match
  if (!normalizedColor1 && !normalizedColor2) {
    return { canMatch: true, matchType: 'exact' };
  }
  
  // One is null, other is not - allow match but flag as missing
  if (!normalizedColor1 || !normalizedColor2) {
    return { canMatch: true, matchType: 'missing' };
  }
  
  // Both have colors - compare case-insensitively
  const lowerColor1 = normalizedColor1.toLowerCase();
  const lowerColor2 = normalizedColor2.toLowerCase();
  
  if (lowerColor1 === lowerColor2) {
    return { canMatch: true, matchType: 'exact' };
  }
  
  // Colors differ - do not allow match
  return { canMatch: false, matchType: 'conflict' };
}

/**
 * Check if two products are the same based on embedding similarity criteria
 * ALL three conditions must be true simultaneously:
 * 1. Average of both embeddings >= 0.79
 * 2. Image embedding >= 0.8  
 * 3. Text embedding >= 0.72
 */
export function checkEmbeddingSimilarity(candidate: ProductCandidate): {
  isSameProduct: boolean;
  matchType: 'all_criteria_met' | 'criteria_not_met';
  averageScore?: number;
  details: {
    textScore: number;
    imageScore: number;
    averageScore: number;
    textMeetsThreshold: boolean;
    imageMeetsThreshold: boolean;
    averageMeetsThreshold: boolean;
  };
} {
  const textScore = candidate.cosine_score || 0;
  const imageScore = candidate.image_cosine_score || 0;
  
  // Calculate average if both embeddings are available
  const hasBothEmbeddings = textScore > 0 && imageScore > 0;
  const averageScore = hasBothEmbeddings ? (textScore + imageScore) / 2 : 0;
  
  // Check each individual criterion
  const textMeetsThreshold = textScore >= 0.8;
  const imageMeetsThreshold = imageScore >= 0.85;
  const averageMeetsThreshold = hasBothEmbeddings && averageScore >= 0.82;
  
  // ALL three conditions must be true for a match
  const allCriteriaMet = textMeetsThreshold && imageMeetsThreshold && averageMeetsThreshold;
  
  return {
    isSameProduct: allCriteriaMet,
    matchType: allCriteriaMet ? 'all_criteria_met' : 'criteria_not_met',
    averageScore,
    details: {
      textScore,
      imageScore,
      averageScore,
      textMeetsThreshold,
      imageMeetsThreshold,
      averageMeetsThreshold,
    }
  };
}

/**
 * Pre-generate embeddings for a product OUTSIDE the transaction
 * This prevents long-running embedding generation from holding database locks
 * 
 * Now includes:
 * - Retry logic with exponential backoff for transient failures
 * - Circuit breaker protection to prevent cascading failures
 */
async function preGenerateEmbeddings(
  normalized: NormalizedProduct,
  requestLogger: pino.Logger
): Promise<{ textEmbedding: number[]; imageEmbedding: number[] } | null> {
  const productData: ProductData = {
    id: 0,
    title: normalized.title || '',
    brand: normalized.brand || '',
    color: normalized.color || '',
    gender: normalized.gender || '',
    description: normalized.description || '',
    image_url: normalized.imageUrl || '',
  };

  const retryContext = { 
    title: normalized.title?.substring(0, 50),
    brand: normalized.brand,
  };

  try {
    const startTime = Date.now();
    requestLogger.info('🔄 Starting parallel embedding generation (text + image)');
    
    // Track individual embedding times
    let textStartTime: number, textDuration: number, imageStartTime: number, imageDuration: number;
    
    // Generate both embeddings in parallel with retry logic and circuit breakers
    const [textEmbedding, imageEmbedding] = await Promise.all([
      // Text embedding with circuit breaker and retry
      (async () => {
        textStartTime = Date.now();
        requestLogger.debug('📝 Text embedding generation starting');
        const result = await textEmbeddingCircuit.execute(() => 
          withRetry(
            () => generateSemanticTextEmbedding(productData),
            { 
              maxRetries: 3, 
              baseDelayMs: 500, 
              maxDelayMs: 5000,
              context: { ...retryContext, operation: 'text-embedding' }
            }
          )
        );
        textDuration = Date.now() - textStartTime;
        requestLogger.info({ 
          durationMs: textDuration,
          dimensions: result?.length || 0,
        }, `📝 Text embedding complete: ${textDuration}ms`);
        return result;
      })(),
      // Image embedding with circuit breaker and retry
      (async () => {
        imageStartTime = Date.now();
        requestLogger.debug('🖼️ Image embedding generation starting');
        const result = await imageEmbeddingCircuit.execute(() =>
          withRetry(
            () => generateSigLipImageEmbedding(productData),
            { 
              maxRetries: 3, 
              baseDelayMs: 500, 
              maxDelayMs: 5000,
              context: { ...retryContext, operation: 'image-embedding' }
            }
          )
        );
        imageDuration = Date.now() - imageStartTime;
        requestLogger.info({ 
          durationMs: imageDuration,
          dimensions: result?.length || 0,
        }, `🖼️ Image embedding complete: ${imageDuration}ms`);
        return result;
      })(),
    ]);

    const totalDuration = Date.now() - startTime;
    requestLogger.info({ 
      totalDurationMs: totalDuration,
      textDurationMs: textDuration!,
      imageDurationMs: imageDuration!,
      textDimensions: textEmbedding?.length || 0,
      imageDimensions: imageEmbedding?.length || 0,
    }, `✅ Both embeddings complete in ${totalDuration}ms (text: ${textDuration!}ms, image: ${imageDuration!}ms)`);

    // Validate dimensions
    if (!validateTextEmbeddingDimension(textEmbedding)) {
      requestLogger.warn({ 
        actualDimensions: textEmbedding?.length || 0,
        expectedDimensions: 768,
      }, '⚠️ Text embedding dimension validation failed');
      return null;
    }
    if (!validateSigLipEmbeddingDimension(imageEmbedding)) {
      requestLogger.warn({ 
        actualDimensions: imageEmbedding?.length || 0,
        expectedDimensions: 1152,
      }, '⚠️ Image embedding dimension validation failed');
      return null;
    }

    return { textEmbedding, imageEmbedding };
  } catch (error) {
    // Note: total timing is tracked above; avoid bogus duration computation here.
    // Handle circuit breaker errors separately
    if (error instanceof CircuitBreakerError) {
      requestLogger.warn({ 
        circuit: error.circuitName,
        state: error.state,
      }, '⚡ Circuit breaker prevented embedding request - service degraded');
    } else {
      requestLogger.error({ 
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : 'Unknown',
        errorStack: error instanceof Error ? error.stack?.substring(0, 500) : undefined,
      }, '❌ Failed to pre-generate embeddings after retries');
    }
    return null;
  }
}

/**
 * Find candidates using pre-generated embeddings (no embedding generation, just DB query)
 */
async function findCandidatesByEmbeddings(
  client: PoolClient,
  textEmbedding: number[],
  imageEmbedding: number[],
  config: ResolveConfig
): Promise<ProductCandidate[]> {
  const result = await client.query(
    `SELECT id as product_id, title, brand, color, 
     (1 - (embedding_text_semantic <=> $1)) as cosine_score, 
     (1 - (embedding_image <=> $2)) as image_cosine_score 
     FROM products 
     WHERE embedding_text_semantic IS NOT NULL 
     AND embedding_image IS NOT NULL 
     AND (1 - (embedding_text_semantic <=> $1)) > $3 
     AND (1 - (embedding_image <=> $2)) > $4 
     AND ((1 - (embedding_text_semantic <=> $1)) + (1 - (embedding_image <=> $2))) / 2 > $5 
     ORDER BY image_cosine_score DESC`,
    [
      JSON.stringify(textEmbedding),
      JSON.stringify(imageEmbedding),
      config.cosineMinTextThreshold,
      config.cosineMinImageThreshold,
      config.cosineMinAverageThreshold,
    ]
  );

  return result.rows;
}

/**
 * Main resolve function that handles the complete matching pipeline
 * @param syncEmbeddings - If true, ensures embeddings exist synchronously (for extension requests)
 *                         For scrapers (false), embeddings are pre-generated outside the transaction
 *                         to avoid holding database locks during slow API calls.
 */
export async function resolveProduct(
  retailerDomain: string,
  pageUrl: string,
  normalized: NormalizedProduct,
  config: ResolveConfig = DEFAULT_CONFIG,
  syncEmbeddings: boolean = false
): Promise<MatchResult> {
  const resolveStartTime = Date.now();
  const requestLogger = logger.child({ retailerDomain, pageUrl, syncEmbeddings });
  
  // Timing tracker for detailed performance analysis
  const timings: Record<string, number> = {};
  const markTiming = (step: string, startTime: number) => {
    timings[step] = Date.now() - startTime;
  };

  requestLogger.info({
    title: normalized.title?.substring(0, 50),
    brand: normalized.brand,
    price: normalized.price,
    syncEmbeddings,
  }, '🚀 RESOLVE START - Beginning product resolution');

  // Scraper path (syncEmbeddings=false) now skips inline embedding generation entirely.
  // Extension path (syncEmbeddings=true) keeps synchronous embeddings for immediate search.
  const isAsyncOnly = !syncEmbeddings;
  
  const transactionStartTime = Date.now();
  requestLogger.info('📊 Step 2: Starting database transaction');
  
  return transaction(async (client) => {
    markTiming('transactionAcquire', transactionStartTime);
    requestLogger.info({ 
      durationMs: timings.transactionAcquire 
    }, `📊 Transaction acquired in ${timings.transactionAcquire}ms`);

    // 1. Get or create retailer
    const retailerStartTime = Date.now();
    const retailer = await upsertRetailerByDomain(client, retailerDomain);
    markTiming('upsertRetailer', retailerStartTime);
    requestLogger.debug({ 
      durationMs: timings.upsertRetailer,
      retailerId: retailer.id,
    }, `📊 Retailer upsert: ${timings.upsertRetailer}ms`);

    // 2. Short-circuit: check if offer already exists
    const offerLookupStartTime = Date.now();
    const existingOffer = await findOfferByRetailerAndUrl(client, retailer.id, pageUrl);
    markTiming('findExistingOffer', offerLookupStartTime);
    requestLogger.debug({ 
      durationMs: timings.findExistingOffer,
      found: existingOffer !== null,
    }, `📊 Offer URL lookup: ${timings.findExistingOffer}ms`);
    
    if (existingOffer) {
      const updateOfferStartTime = Date.now();
      const updatedOfferId = await upsertOffer(client, existingOffer.product_id, retailer.id, pageUrl, normalized, undefined, undefined, undefined);
      markTiming('updateExistingOffer', updateOfferStartTime);
      
      const totalDuration = Date.now() - resolveStartTime;
      requestLogger.info({ 
        productId: existingOffer.product_id,
        offerId: updatedOfferId,
        matchedVia: 'offer_url',
        totalDurationMs: totalDuration,
        timings,
      }, `✅ RESOLVE COMPLETE (offer_url match) - Total: ${totalDuration}ms`);
      
      // For extension requests, ensure embeddings exist synchronously (needed for immediate search)
      // For scrapers, queue embedding check asynchronously (better throughput)
      if (syncEmbeddings) {
        await ensureProductHasEmbeddings(existingOffer.product_id, requestLogger);
      } else {
      setImmediate(async () => {
        try {
          await onProductUpdated(existingOffer.product_id, []);
        } catch (error) {
          requestLogger.warn({ 
            productId: existingOffer.product_id,
            error: error instanceof Error ? error.message : String(error) 
          }, 'Failed to trigger embedding check for existing offer');
        }
      });
      }
      
      return {
        product_id: existingOffer.product_id,
        offer_id: updatedOfferId,
        created: false,
        matched_via: 'offer_url',
        scores: {
          trgm: 0,
          cosine: 0,
          image_cosine: 0,
          average_embedding: 0,
          match_type: 'offer_url',
          text_meets_threshold: false,
          image_meets_threshold: false,
          average_meets_threshold: false,
        },
        retailer_id: retailer.id,
      };
    }

    // 3. Try strict ID matching (GTIN, MPN+brand)
    const strictIdStartTime = Date.now();
    const strictMatch = await findByStrictIds(client, normalized);
    markTiming('findByStrictIds', strictIdStartTime);
    requestLogger.debug({ 
      durationMs: timings.findByStrictIds,
      found: strictMatch !== null,
    }, `📊 Strict ID lookup: ${timings.findByStrictIds}ms`);
    
    if (strictMatch) {
      const updateStartTime = Date.now();
      const updatedFields = await updateProductInfo(client, strictMatch.product_id, normalized);
      markTiming('updateProductInfo_strictId', updateStartTime);
      
      // For extension requests, ensure embeddings exist synchronously
      // For scrapers, queue embedding check asynchronously
      if (syncEmbeddings) {
        await ensureProductHasEmbeddings(strictMatch.product_id, requestLogger);
      } else {
      setImmediate(async () => {
        try {
          await onProductUpdated(strictMatch.product_id, updatedFields);
        } catch (error) {
          requestLogger.warn({ 
            productId: strictMatch.product_id,
            error: error instanceof Error ? error.message : String(error) 
          }, 'Failed to trigger embedding check for strict ID match');
        }
      });
      }
      
      const offerStartTime = Date.now();
      const offerId = await upsertOffer(client, strictMatch.product_id, retailer.id, pageUrl, normalized, undefined, undefined, undefined);
      markTiming('upsertOffer_strictId', offerStartTime);
      
      const totalDuration = Date.now() - resolveStartTime;
      requestLogger.info({ 
        productId: strictMatch.product_id,
        offerId,
        matchedVia: strictMatch.matched_via,
        totalDurationMs: totalDuration,
        timings,
      }, `✅ RESOLVE COMPLETE (strict_id match) - Total: ${totalDuration}ms`);
      
      return {
        product_id: strictMatch.product_id,
        offer_id: offerId,
        created: false,
        matched_via: strictMatch.matched_via,
        scores: {
          trgm: 0,
          cosine: 0,
          image_cosine: 0,
          average_embedding: 0,
          match_type: 'strict_id',
          text_meets_threshold: false,
          image_meets_threshold: false,
          average_meets_threshold: false,
        },
        retailer_id: retailer.id,
      };
    }

    // 4. Try brand+title matching
    const brandTitleStartTime = Date.now();
    const brandTitleMatch = await findByBrandAndTitle(client, normalized);
    markTiming('findByBrandAndTitle', brandTitleStartTime);
    requestLogger.debug({ 
      durationMs: timings.findByBrandAndTitle,
      found: brandTitleMatch !== null,
    }, `📊 Brand+title lookup: ${timings.findByBrandAndTitle}ms`);
    
    if (brandTitleMatch) {
      const updateStartTime = Date.now();
      const updatedFields = await updateProductInfo(client, brandTitleMatch.product_id, normalized);
      markTiming('updateProductInfo_brandTitle', updateStartTime);
      
      // For extension requests, ensure embeddings exist synchronously
      // For scrapers, queue embedding check asynchronously
      if (syncEmbeddings) {
        await ensureProductHasEmbeddings(brandTitleMatch.product_id, requestLogger);
      } else {
      setImmediate(async () => {
        try {
          await onProductUpdated(brandTitleMatch.product_id, updatedFields);
        } catch (error) {
          requestLogger.warn({ 
            productId: brandTitleMatch.product_id,
            error: error instanceof Error ? error.message : String(error) 
          }, 'Failed to trigger embedding check for brand+title match');
        }
      });
      }
      
      const offerStartTime = Date.now();
      const offerId = await upsertOffer(client, brandTitleMatch.product_id, retailer.id, pageUrl, normalized, undefined, undefined, undefined);
      markTiming('upsertOffer_brandTitle', offerStartTime);
      
      const totalDuration = Date.now() - resolveStartTime;
      requestLogger.info({ 
        productId: brandTitleMatch.product_id,
        offerId,
        matchedVia: brandTitleMatch.matched_via,
        totalDurationMs: totalDuration,
        timings,
      }, `✅ RESOLVE COMPLETE (brand_title match) - Total: ${totalDuration}ms`);
      
      return {
        product_id: brandTitleMatch.product_id,
        offer_id: offerId,
        created: false,
        matched_via: brandTitleMatch.matched_via,
        scores: {
          trgm: 0,
          cosine: 0,
          image_cosine: 0,
          average_embedding: 0,
          match_type: 'brand_title',
          text_meets_threshold: false,
          image_meets_threshold: false,
          average_meets_threshold: false,
        },
        retailer_id: retailer.id,
      };
    }

    // 5. Get candidates via trigram similarity (currently disabled)
    // const trigramCandidates = await getCandidatesByTrigram(client, normalized, config);

    // 6. Find candidates by text and image embedding similarity
    // For scrapers: skip inline embedding generation; rely on background jobs
    // For extension: Generate embeddings inside transaction (needs sync for immediate search)
    requestLogger.info('📊 Step 3: Embedding similarity path selection');
    
    let candidates: ProductCandidate[] = [];
    let textEmbedding: number[] | null = null;
    let imageEmbedding: number[] | null = null;

    if (isAsyncOnly) {
      requestLogger.info('⏩ Skipping inline embedding generation (scraper mode)');
    } else {
      const inlineEmbeddingStartTime = Date.now();
      requestLogger.info('📊 Generating embeddings inline (extension mode)');
      
      const result = await getCandidatesByTextAndImageEmbedding(client, normalized, config);
      candidates = result.candidates;
      textEmbedding = result.textEmbedding;
      imageEmbedding = result.imageEmbedding;
      
      markTiming('getCandidatesWithInlineEmbedding', inlineEmbeddingStartTime);
      requestLogger.info({ 
        durationMs: timings.getCandidatesWithInlineEmbedding,
        candidateCount: candidates.length,
        mode: 'inline-generation',
      }, `📊 Inline embedding + search: ${timings.getCandidatesWithInlineEmbedding}ms (found ${candidates.length} candidates)`);
    }

    // Candidates found, update and add offer for best candidate
    if (candidates.length != 0) {
      const bestCandidate = candidates[0];

      const updateStartTime = Date.now();
      const updatedFields = await updateProductInfo(client, bestCandidate.product_id, normalized);
      markTiming('updateProductInfo_embedding', updateStartTime);

      const offerStartTime = Date.now();
      const offerId = await upsertOffer(client, bestCandidate.product_id, retailer.id, pageUrl, normalized, undefined, undefined, undefined);
      markTiming('upsertOffer_embedding', offerStartTime);

      const totalDuration = Date.now() - resolveStartTime;
      requestLogger.info({ 
        productId: bestCandidate.product_id,
        offerId,
        matchedVia: 'embedding',
        cosineScore: bestCandidate.cosine_score,
        imageCosineScore: bestCandidate.image_cosine_score,
        totalDurationMs: totalDuration,
        timings,
      }, `✅ RESOLVE COMPLETE (embedding match) - Total: ${totalDuration}ms`);

      return {
        product_id: candidates[0].product_id,
        offer_id: offerId,
        created: false,
        matched_via: 'embedding',
        scores: {
          trgm: 0,
          cosine: candidates[0].cosine_score || 0,
          image_cosine: candidates[0].image_cosine_score || 0,
          average_embedding: ((candidates[0].cosine_score || 0) + (candidates[0].image_cosine_score || 0)) / 2,
          match_type: 'embedding',
          text_meets_threshold: (candidates[0].cosine_score || 0) >= config.cosineMinTextThreshold,
          image_meets_threshold: (candidates[0].image_cosine_score || 0) >= config.cosineMinImageThreshold,
          average_meets_threshold: (((candidates[0].cosine_score || 0) + (candidates[0].image_cosine_score || 0)) / 2) >= config.cosineMinAverageThreshold,
        },
        retailer_id: retailer.id,
      };
    }

    // No candidate found, create new product
    requestLogger.info('📊 Step 4: No matches found - creating new product');
    
    // If synchronous embeddings are required but missing (e.g., extension path), generate now.
    if (!isAsyncOnly && ((textEmbedding?.length || 0) === 0 || (imageEmbedding?.length || 0) === 0)) {
      const fallbackEmbeddingStartTime = Date.now();
      requestLogger.warn('⚠️ Missing embeddings in sync path, generating inline for new product');
      
      const result = await getCandidatesByTextAndImageEmbedding(client, normalized, config);
      textEmbedding = result.textEmbedding;
      imageEmbedding = result.imageEmbedding;
      
      markTiming('fallbackEmbeddingGeneration', fallbackEmbeddingStartTime);
      requestLogger.warn({ 
        durationMs: timings.fallbackEmbeddingGeneration 
      }, `📊 Fallback embedding generation: ${timings.fallbackEmbeddingGeneration}ms`);
    }

    const createProductStartTime = Date.now();
    const { productId: newProductId, llmExtraction } = await createProduct(
      client, 
      normalized, 
      textEmbedding || null, 
      imageEmbedding || null
    );
    markTiming('createProduct', createProductStartTime);
    requestLogger.info({ 
      durationMs: timings.createProduct,
      newProductId,
    }, `📊 Product creation: ${timings.createProduct}ms`);
    
    const offerStartTime = Date.now();
    const newOfferId = await upsertOffer(
      client, 
      newProductId, 
      retailer.id, 
      pageUrl, 
      normalized,
      llmExtraction.metadata.available_sizes,
      llmExtraction.metadata.category,
      llmExtraction.metadata.gender
    );
    markTiming('upsertOffer_new', offerStartTime);
    
    const totalDuration = Date.now() - resolveStartTime;
    requestLogger.info({ 
      productId: newProductId,
      offerId: newOfferId,
      matchedVia: 'new',
      totalDurationMs: totalDuration,
      timings,
    }, `✅ RESOLVE COMPLETE (new product) - Total: ${totalDuration}ms`);
    
    setImmediate(() => onProductCreated(newProductId));

    return {
      product_id: newProductId,
      offer_id: newOfferId,
      created: true,
      matched_via: 'new',
      scores: {
        trgm: 0,
        cosine: 0,
        image_cosine: 0,
        average_embedding: 0,
        match_type: 'new',
        text_meets_threshold: false,
        image_meets_threshold: false,
        average_meets_threshold: false,
      },
      retailer_id: retailer.id,
    };
  });
}

/**
 * Find or create retailer by domain
 */
async function upsertRetailerByDomain(client: PoolClient, domain: string): Promise<{ id: number; name: string }> {
  // Use INSERT ... ON CONFLICT to handle race conditions
  const result = await client.query(
    `INSERT INTO retailers (name, domain) VALUES ($1, $2) 
     ON CONFLICT (domain) DO UPDATE SET name = EXCLUDED.name 
     RETURNING id, name`,
    [domain, domain]
  );

  return result.rows[0];
}

/**
 * Find existing offer by retailer and URL
 */
async function findOfferByRetailerAndUrl(
  client: PoolClient, 
  retailerId: number, 
  url: string
): Promise<{ id: number; product_id: number } | null> {
  const result = await client.query(
    'SELECT id, product_id FROM offers WHERE retailer_id = $1 AND url = $2',
    [retailerId, url]
  );

  return result.rows[0] || null;
}

/**
 * Find product by brand and title combination
 */
async function findByBrandAndTitle(
  client: PoolClient,
  normalized: NormalizedProduct
): Promise<{ product_id: number; matched_via: string; scores: Record<string, number>; color: string | null } | null> {
  // Only attempt brand+title matching if both brand and title are available
  if (!normalized.brand || !normalized.title) {
    return null;
  }

  const result = await client.query(
    'SELECT id, color FROM products WHERE LOWER(brand) = LOWER($1) AND LOWER(title) = LOWER($2)',
    [normalized.brand, normalized.title]
  );

  if (result.rows.length > 0) {
    const product = result.rows[0];
    
    // Check color consistency for brand+title matches
    const colorCheck = checkColorConsistency(normalized.color, product.color);
    if (!colorCheck.canMatch) {
      return null;
    }
    
    return {
      product_id: product.id,
      matched_via: colorCheck.matchType === 'missing' ? 'brand+title (color-missing)' : 'brand+title',
      scores: { brand_title: 1.0 },
      color: product.color,
    };
  }

  return null;
}

/**
 * Find product by strict IDs (GTIN/MPN)
 */
async function findByStrictIds(
  client: PoolClient, 
  normalized: NormalizedProduct
): Promise<{ product_id: number; matched_via: string; scores: Record<string, number>; color: string | null } | null> {
  if (normalized.gtin) {
    const result = await client.query(
      'SELECT id, color FROM products WHERE gtin = $1',
      [normalized.gtin]
    );
    if (result.rows.length > 0) {
      const product = result.rows[0];
      
      // Check color consistency for GTIN matches
      const colorCheck = checkColorConsistency(normalized.color, product.color);
      if (!colorCheck.canMatch) {
        return null;
      }
      
      return {
        product_id: product.id,
        matched_via: colorCheck.matchType === 'missing' ? 'gtin (color-missing)' : 'gtin',
        scores: { gtin: 1.0 },
        color: product.color,
      };
    }
  }

  if (normalized.mpn && normalized.brand) {
    const result = await client.query(
      'SELECT id, color FROM products WHERE mpn = $1 AND brand = $2',
      [normalized.mpn, normalized.brand]
    );
    if (result.rows.length > 0) {
      const product = result.rows[0];
      
      // Check color consistency for MPN matches
      const colorCheck = checkColorConsistency(normalized.color, product.color);
      if (!colorCheck.canMatch) {
        return null;
      }
      
      return {
        product_id: product.id,
        matched_via: colorCheck.matchType === 'missing' ? 'mpn (color-missing)' : 'mpn',
        scores: { mpn: 1.0 },
        color: product.color,
      };
    }
  }

  return null;
}

/**
 * Get candidate products using trigram similarity
 */
async function getCandidatesByTrigram(
  client: PoolClient,
  normalized: NormalizedProduct,
  config: ResolveConfig
): Promise<ProductCandidate[]> {
  let queryText = `
    SELECT 
      id as product_id,
      title,
      brand,
      color,
      similarity(title, $1) as trgm_score
    FROM products 
    WHERE similarity(title, $1) > $2
  `;
  
  const params: any[] = [normalized.title, config.trgmMinThreshold];

  // Add brand filter if available
  if (normalized.brand) {
    queryText += ' AND brand = $3';
    params.push(normalized.brand);
  }

  queryText += `
    ORDER BY trgm_score DESC 
    LIMIT $${params.length + 1}
  `;
  params.push(config.maxCandidates);

  const result = await client.query(queryText, params);
  return result.rows;
}

/**
 * Get candidates by checking the text and image embedding cosine similarity against the normalized product
 */
async function getCandidatesByTextAndImageEmbedding(client: PoolClient, normalized: NormalizedProduct, config: ResolveConfig): 
Promise<{ candidates: ProductCandidate[], textEmbedding: number[], imageEmbedding: number[] }> {
  
  const productData: ProductData = {
    id: 0,
    title: normalized.title || '',
    brand: normalized.brand || '',
    color: normalized.color || '',
    gender: normalized.gender || '',
    description: normalized.description || '',
    image_url: normalized.imageUrl || '',
  };
  
  const textEmbedding = await generateSemanticTextEmbedding(productData);
  if (!validateTextEmbeddingDimension(textEmbedding)) {
    return { candidates: [], textEmbedding: [], imageEmbedding: [] };
  }
  const imageEmbedding = await generateSigLipImageEmbedding(productData);
  if (!validateSigLipEmbeddingDimension(imageEmbedding)) {
    return { candidates: [], textEmbedding: [], imageEmbedding: [] };
  }

  const result = await client.query(
    'SELECT id as product_id, title, brand, color, (1 - (embedding_text_semantic <=> $1)) as cosine_score, (1 - (embedding_image <=> $2)) as image_cosine_score FROM products WHERE embedding_text_semantic IS NOT NULL AND embedding_image IS NOT NULL AND (1 - (embedding_text_semantic <=> $1)) > $3 AND (1 - (embedding_image <=> $2)) > $4 AND ((1 - (embedding_text_semantic <=> $1)) + (1 - (embedding_image <=> $2))) / 2 > $5 ORDER BY image_cosine_score DESC',
    [JSON.stringify(textEmbedding), JSON.stringify(imageEmbedding), config.cosineMinTextThreshold, config.cosineMinImageThreshold, config.cosineMinAverageThreshold]
  );
  
  return { candidates: result.rows, textEmbedding: textEmbedding, imageEmbedding: imageEmbedding };
}

/**
 * Update existing product with new information (only fill null fields)
 * Returns array of field names that were actually updated
 */
async function updateProductInfo(client: PoolClient, productId: number, normalized: NormalizedProduct): Promise<string[]> {
  const updates: string[] = [];
  const values: any[] = [];
  const updatedFields: string[] = [];
  let paramIndex = 1;
  // Build dynamic update query for non-null fields
  if (normalized.gtin) {
    updates.push(`gtin = COALESCE(gtin, $${paramIndex})`);
    values.push(normalized.gtin);
    updatedFields.push('gtin');
    paramIndex++;
  }
  
  if (normalized.mpn) {
    updates.push(`mpn = COALESCE(mpn, $${paramIndex})`);
    values.push(normalized.mpn);
    updatedFields.push('mpn');
    paramIndex++;
  }
  
  if (normalized.brand) {
    updates.push(`brand = COALESCE(brand, $${paramIndex})`);
    values.push(normalized.brand);
    updatedFields.push('brand');
    paramIndex++;
  }
  
  if (normalized.title) {
    updates.push(`title = COALESCE(title, $${paramIndex})`);
    values.push(normalized.title);
    updatedFields.push('title');
    paramIndex++;
  }
  
  if (normalized.description) {
    updates.push(`description = COALESCE(description, $${paramIndex})`);
    values.push(normalized.description);
    updatedFields.push('description');
    paramIndex++;
  }
  
  if (normalized.color) {
    updates.push(`color = COALESCE(color, $${paramIndex})`);
    values.push(normalized.color);
    updatedFields.push('color');
    paramIndex++;
  }
  
  if (normalized.primaryMaterial) {
    updates.push(`primary_material = COALESCE(primary_material, $${paramIndex})`);
    values.push(normalized.primaryMaterial);
    updatedFields.push('primary_material');
    paramIndex++;
  }
  
  if (normalized.category) {
    updates.push(`category = COALESCE(category, $${paramIndex})`);
    values.push(normalized.category);
    updatedFields.push('category');
    paramIndex++;
  }
  
  if (normalized.subCategory) {
    updates.push(`sub_category = COALESCE(sub_category, $${paramIndex})`);
    values.push(normalized.subCategory);
    updatedFields.push('sub_category');
    paramIndex++;
  }
  
  if (normalized.gender) {
    updates.push(`gender = COALESCE(gender, $${paramIndex})`);
    values.push(normalized.gender);
    updatedFields.push('gender');
    paramIndex++;
  }
  
  if (normalized.imageUrl) {
    updates.push(`image_url = COALESCE(image_url, $${paramIndex})`);
    values.push(normalized.imageUrl);
    updatedFields.push('image_url');
    paramIndex++;
  }

  // Only run update if there are fields to update
  if (updates.length > 0) {
    // Regenerate text fields if any descriptive fields were updated
    const descriptiveFields = ['brand', 'title', 'description', 'color', 'primary_material', 'category', 'sub_category'];
    const hasDescriptiveUpdates = updatedFields.some(field => descriptiveFields.includes(field));
    
    if (hasDescriptiveUpdates) {
      // Regenerate all text variants using LLM
      const titleClean = generateCleanTitle(normalized);
      const llmExtraction = await generateSearchText(normalized);
      
      // Use LLM-generated description for search_text
      const searchText = llmExtraction.description;
      
      // Fill missing fields from LLM metadata (only if not already set)
      if (!normalized.brand && llmExtraction.metadata.brand) {
        updates.push(`brand = COALESCE(brand, $${paramIndex})`);
        values.push(llmExtraction.metadata.brand);
        updatedFields.push('brand');
        paramIndex++;
      }
      
      if (!normalized.category && llmExtraction.metadata.category) {
        updates.push(`category = COALESCE(category, $${paramIndex})`);
        values.push(llmExtraction.metadata.category);
        updatedFields.push('category');
        paramIndex++;
      }
      
      if (!normalized.subCategory && llmExtraction.metadata.sub_category) {
        updates.push(`sub_category = COALESCE(sub_category, $${paramIndex})`);
        values.push(llmExtraction.metadata.sub_category);
        updatedFields.push('sub_category');
        paramIndex++;
      }
      
      if (!normalized.color && llmExtraction.metadata.color) {
        updates.push(`color = COALESCE(color, $${paramIndex})`);
        values.push(llmExtraction.metadata.color);
        updatedFields.push('color');
        paramIndex++;
      }
      
      // Update attributes column with LLM metadata
      updates.push(`attributes = $${paramIndex}`);
      values.push(JSON.stringify(llmExtraction.metadata));
      updatedFields.push('attributes');
      paramIndex++;
      
      updates.push(`title_clean = $${paramIndex}`);
      values.push(titleClean);
      updatedFields.push('title_clean');
      paramIndex++;
      
      updates.push(`search_text = $${paramIndex}`);
      values.push(searchText);
      updatedFields.push('search_text');
      paramIndex++;
    }
    
    updates.push(`updated_at = now()`);
    values.push(productId);
    
    const query = `
      UPDATE products 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
    `;
    
    await client.query(query, values);
    logger.debug({ 
      productId, 
      updatedFields: updatedFields.length,
      regeneratedTextFields: hasDescriptiveUpdates 
    }, 'Updated product with new information');
  }
  
  return updatedFields;
}

/**
 * Create a new product in the database
 * Returns product ID and LLM extraction (for size processing)
 */
async function createProduct(
  client: PoolClient, 
  normalized: NormalizedProduct, 
  textEmbedding: number[] | null, 
  imageEmbedding: number[] | null
): Promise<{ productId: number; llmExtraction: LLMProductExtraction }> {
  // Generate all text variants using LLM
  const titleClean = generateCleanTitle(normalized);
  const llmExtraction = await generateSearchText(normalized);
  
  // Use LLM-generated description for search_text
  const searchText = llmExtraction.description;
  
  // Fill missing fields from LLM metadata
  const brand = normalized.brand || llmExtraction.metadata.brand || null;
  const category = normalized.category || llmExtraction.metadata.category || null;
  const subCategory = normalized.subCategory || llmExtraction.metadata.sub_category || null;
  const color = normalized.color || llmExtraction.metadata.color || null;
  const gender = normalized.gender || 'unisex'; // Default to unisex if not specified
  
  // Store metadata in attributes column
  const attributes = JSON.stringify(llmExtraction.metadata);

  const textEmbeddingValue = textEmbedding ? JSON.stringify(textEmbedding) : null;
  const imageEmbeddingValue = imageEmbedding ? JSON.stringify(imageEmbedding) : null;

  const result = await client.query(`
    INSERT INTO products (
      gtin, mpn, brand, title, description, title_clean, search_text, 
      color, primary_material, category, sub_category, gender, image_url, embedding_text_semantic, embedding_image, attributes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING id
  `, [
    normalized.gtin,
    normalized.mpn,
    brand,
    normalized.title,
    normalized.description, // Keep original messy description
    titleClean,
    searchText, // LLM-generated clean description
    color,
    normalized.primaryMaterial,
    category,
    subCategory,
    gender,
    normalized.imageUrl,
    textEmbeddingValue,
    imageEmbeddingValue,
    attributes
  ]);

  return {
    productId: result.rows[0].id,
    llmExtraction
  };
}

/**
 * Create offer variants for a given offer with size mapping
 */
async function createOfferVariants(
  client: PoolClient,
  offerId: number,
  availableSizes: string[] | null | undefined,
  sizeMappingContext: SizeMappingContext
): Promise<void> {
  // CRITICAL: If no size information provided (undefined), preserve existing variants
  // This prevents data loss when matching existing products without re-extracting sizes
  if (availableSizes === undefined) {
    logger.debug({ 
      offerId, 
      action: 'preserve_existing' 
    }, 'No size info provided - preserving existing variants to prevent data loss');
    return; // Don't touch existing variants
  }
  
  // Delete existing variants only if we have new size information to replace them with
  await client.query('DELETE FROM offer_variants WHERE offer_id = $1', [offerId]);
  
  logger.debug({ 
    offerId, 
    sizeCount: availableSizes?.length || 0,
    action: 'recreate'
  }, 'Cleared existing variants - recreating with new size info');
  
  // If explicitly set to null or empty array, create a single variant without size info
  if (!availableSizes || availableSizes.length === 0) {
    await client.query(
      `INSERT INTO offer_variants (offer_id, raw_size_label, in_stock)
       VALUES ($1, NULL, true)`,
      [offerId]
    );
    
    logger.debug({ offerId }, 'Created offer variant without size info');
    return;
  }
  
  // Create a variant for each size
  for (const rawSize of availableSizes) {
    try {
      // Map raw size to standard size
      const standardSizeId = await mapSizeToStandard(client, rawSize, sizeMappingContext);
      
      await client.query(
        `INSERT INTO offer_variants (offer_id, standard_size_id, raw_size_label, in_stock)
         VALUES ($1, $2, $3, true)`,
        [offerId, standardSizeId, rawSize]
      );
      
      logger.debug({
        offerId,
        rawSize,
        standardSizeId,
        mapped: !!standardSizeId,
      }, 'Created offer variant with size');
      
    } catch (error) {
      logger.warn({
        error: error instanceof Error ? error.message : String(error),
        offerId,
        rawSize,
      }, 'Failed to create offer variant for size');
    }
  }
}

/**
 * Create or update an offer
 */
async function upsertOffer(
  client: PoolClient,
  productId: number,
  retailerId: number,
  url: string,
  normalized: NormalizedProduct,
  availableSizes?: string[] | null,
  category?: string | null,
  gender?: string | null
): Promise<number> {

  const baseCurrency = process.env.DEFAULT_CURRENCY || 'USD';

  var priceUsd = normalized.price;
  if (normalized.currency !== baseCurrency) {
    const priceConversion = await currencyService.convertPrice(normalized.price, normalized.currency, baseCurrency);
    priceUsd = priceConversion.convertedAmount;
  }

  const result = await client.query(`
    INSERT INTO offers (
      product_id, retailer_id, title, url, sku, condition, currency, 
      price, price_usd, original_price, in_stock, image_url, last_seen_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
    ON CONFLICT (retailer_id, url) 
    DO UPDATE SET 
      price = EXCLUDED.price,
      price_usd = EXCLUDED.price_usd,
      currency = EXCLUDED.currency,
      original_price = EXCLUDED.original_price,
      in_stock = EXCLUDED.in_stock,
      last_seen_at = now(),
      updated_at = now()
    RETURNING id
  `, [
    productId,
    retailerId,
    normalized.title,
    url,
    normalized.sku,
    normalized.condition,
    normalized.currency,
    normalized.price,
    priceUsd,
    normalized.originalPrice,
    true, // assume in stock
    normalized.imageUrl
  ]);

  const offerId = result.rows[0].id;
  
  // Create size variants for this offer
  const sizeMappingContext: SizeMappingContext = {
    category: category || normalized.category || undefined,
    gender: gender || normalized.gender || undefined,
  };
  
  await createOfferVariants(client, offerId, availableSizes, sizeMappingContext);

  return offerId;
}

/**
 * Ensure a product has both text and image embeddings
 * Used for extension requests that need embeddings immediately for search
 */
async function ensureProductHasEmbeddings(productId: number, requestLogger: any): Promise<void> {
  // Check current embedding status
  const result = await query(
    `SELECT 
      embedding_text_semantic IS NOT NULL as has_text,
      embedding_image IS NOT NULL as has_image,
      title, brand, color, description, image_url, primary_material, category, gender, search_text
    FROM products WHERE id = $1`,
    [productId]
  );
  
  if (result.rows.length === 0) {
    requestLogger.warn({ productId }, 'Product not found for embedding check');
    return;
  }
  
  const product = result.rows[0];
  const missingText = !product.has_text;
  const missingImage = !product.has_image;
  
  if (!missingText && !missingImage) {
    requestLogger.debug({ productId }, 'Product already has all embeddings');
    return;
  }
  
  requestLogger.info({ productId, missingText, missingImage }, 'Generating missing embeddings synchronously for extension request');
  
  try {
    const productData: ProductData = {
      id: productId,
      title: product.title,
      brand: product.brand,
      color: product.color,
      description: product.description,
      image_url: product.image_url,
      primary_material: product.primary_material,
      category: product.category,
      gender: product.gender,
      search_text: product.search_text
    };
    
    const updates: Promise<void>[] = [];
    
    if (missingText) {
      updates.push((async () => {
        const textEmbedding = await generateSemanticTextEmbedding(productData);
        await query(
          `UPDATE products SET embedding_text_semantic = $1, embedding_text_semantic_updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(textEmbedding), productId]
        );
        requestLogger.debug({ productId }, 'Text embedding generated synchronously');
      })());
    }
    
    if (missingImage && product.image_url) {
      updates.push((async () => {
        const imageEmbedding = await generateSigLipImageEmbedding(productData);
        await query(
          `UPDATE products SET embedding_image = $1, embedding_image_updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(imageEmbedding), productId]
        );
        requestLogger.debug({ productId }, 'Image embedding generated synchronously');
      })());
    }
    
    await Promise.all(updates);
    requestLogger.info({ productId, generatedText: missingText, generatedImage: missingImage && !!product.image_url }, 'Embeddings generated successfully for extension request');
    
  } catch (error) {
    requestLogger.error({ 
      productId, 
      error: error instanceof Error ? error.message : String(error) 
    }, 'Failed to generate embeddings synchronously - search may not work immediately');
    // Don't throw - let the request continue even if embeddings fail
    // The user will still get the product match, but search might not work until embeddings are generated async
  }
}
