import { query } from '../db';
import { replaceContextPlaceholders } from '../intent/parse';
import { generateSemanticTextEmbedding, generateSigLipTextEmbedding } from '../embeddings';
import { withSpan } from '../observability/trace';

/**
 * Blend two embeddings with specified weights
 */
function blendEmbeddings(embedding1: number[], embedding2: number[], weight1: number, weight2: number): number[] {
  if (embedding1.length !== embedding2.length) {
    throw new Error(`Embedding dimensions don't match: ${embedding1.length} vs ${embedding2.length}`);
  }

  const blended = new Array(embedding1.length);
  for (let i = 0; i < embedding1.length; i++) {
    blended[i] = (embedding1[i] * weight1) + (embedding2[i] * weight2);
  }

  // L2 normalize the result
  const magnitude = Math.sqrt(blended.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) {
    return blended; // Avoid division by zero
  }
  
  return blended.map(val => val / magnitude);
}

/**
 * Perform embedding search against database
 */
async function performEmbeddingSearch(
  embedding: number[], 
  embeddingType: 'text' | 'image', 
  limit: number, 
  requestLogger?: any,
  excludeProductId?: number | string
): Promise<Array<{ product_id: number; title: string; brand?: string; category?: string; image_url?: string; similarity_score: number }>> {
  const embeddingColumn = embeddingType === 'text' ? 'embedding_text_semantic' : 'embedding_image';
  
  // Build query with optional exclusion
  let searchQuery = `
    SELECT 
      p.id as product_id,
      p.title,
      p.brand,
      p.category,
      p.image_url,
      (1 - (p.${embeddingColumn} <=> $1::vector)) as similarity_score
    FROM products p
    WHERE p.${embeddingColumn} IS NOT NULL
  `;
  
  const queryParams: any[] = [JSON.stringify(embedding)];
  
  // Add exclusion clause if product ID is provided
  if (excludeProductId) {
    searchQuery += ` AND p.id != $2`;
    queryParams.push(excludeProductId);
  }
  
  searchQuery += `
    ORDER BY p.${embeddingColumn} <=> $1::vector
    LIMIT $${excludeProductId ? '3' : '2'}
  `;
  
  queryParams.push(limit);

  const result = await query(searchQuery, queryParams);

  return result.rows;
}

/**
 * Combine text and image search results by averaging similarity scores
 * Filters results to only include those with similarity_score >= minSimilarityScore
 */
function combineEmbeddingResults(
  textResults: Array<{ product_id: number; similarity_score: number; [key: string]: any }>,
  imageResults: Array<{ product_id: number; similarity_score: number; [key: string]: any }>,
  limit: number,
  minSimilarityScore: number = 0.1
): Array<{ product_id: number; title: string; brand?: string; category?: string; image_url?: string; similarity_score: number }> {
  const productMap = new Map<number, any>();

  // Add text results
  textResults.forEach(result => {
    productMap.set(result.product_id, {
      ...result,
      text_score: result.similarity_score,
      image_score: 0,
      count: 1
    });
  });

  // Add image results and average scores
  imageResults.forEach(result => {
    const existing = productMap.get(result.product_id);
    if (existing) {
      // Product found in both - average the scores
      existing.image_score = result.similarity_score;
      existing.similarity_score = (existing.text_score + result.similarity_score) / 2;
      existing.count = 2;
    } else {
      // Product only in image results
      productMap.set(result.product_id, {
        ...result,
        text_score: 0,
        image_score: result.similarity_score,
        count: 1
      });
    }
  });

  // Convert to array, filter by similarity >= minSimilarityScore, sort by combined similarity score
  const combinedResults = Array.from(productMap.values())
    .filter(result => result.similarity_score >= minSimilarityScore) // Filter by similarity threshold
    .sort((a, b) => b.similarity_score - a.similarity_score)
    .slice(0, limit)
    .map(result => ({
      product_id: result.product_id,
      title: result.title,
      brand: result.brand,
      category: result.category,
      image_url: result.image_url,
      similarity_score: result.similarity_score
    }));

  return combinedResults;
}

/**
 * Apply price filters to search results
 */
async function applyPriceFilters(
  searchResults: Array<{ product_id: number; [key: string]: any }>,
  filters: Record<string, any>,
  requestLogger?: any
): Promise<Array<{ product_id: number; title: string; brand?: string; category?: string; image_url?: string; similarity_score: number }>> {
  if (!filters.price || (!filters.price.min && !filters.price.max)) {
    // No price filters, return as is but ensure correct type
    return searchResults.map(result => ({
      product_id: result.product_id,
      title: result.title,
      brand: result.brand,
      category: result.category,
      image_url: result.image_url,
      similarity_score: result.similarity_score
    }));
  }

  const productIds = searchResults.map(r => r.product_id);
  
  // Build price filter query
  let priceQuery = `
    SELECT DISTINCT p.id as product_id, p.title, p.brand, p.category, p.image_url
    FROM products p
    JOIN offers o ON p.id = o.product_id
    WHERE p.id = ANY($1)
      AND o.in_stock = true
  `;
  
  const queryParams: any[] = [productIds];
  let paramIndex = 2;

  if (filters.price.min) {
    priceQuery += ` AND o.price >= $${paramIndex}`;
    queryParams.push(filters.price.min);
    paramIndex++;
  }
  
  if (filters.price.max) {
    priceQuery += ` AND o.price <= $${paramIndex}`;
    queryParams.push(filters.price.max);
    paramIndex++;
  }
  
  if (filters.price.currency) {
    priceQuery += ` AND o.currency = $${paramIndex}`;
    queryParams.push(filters.price.currency);
    paramIndex++;
  }

  const priceFilterResult = await query(priceQuery, queryParams);
  const validProductIds = new Set(priceFilterResult.rows.map((row: any) => row.product_id));

  // Filter search results to only include products that pass price filter
  const filteredResults = searchResults
    .filter(result => validProductIds.has(result.product_id))
    .map(result => ({
      product_id: result.product_id,
      title: result.title,
      brand: result.brand,
      category: result.category,
      image_url: result.image_url,
      similarity_score: result.similarity_score
    }));

  return filteredResults;
}

/**
 * Context-aware product search using dual embedding approach
 */
export async function searchProductsContextAware(
  parsed: { freeText: string; filters: Record<string, any>; limit: number; clipText: string; searchText: string; useContext: boolean },
  contextToUse: { productId?: string } | undefined,
  topK: number,
  requestLogger?: any,
  traceId?: string,
  parentSpanId?: string,
  minSimilarityScore: number = 0.8,
  excludeProductId?: number | string
): Promise<{
  results: any[];
  relaxedSteps?: string[];
  relaxationMessage?: string;
  finalImageEmbedding?: number[] | null;
}> {
  const startTime = Date.now();

  try {
    // Step 1: Prepare embedding texts and generate embeddings for user query
    let finalClipText = parsed.clipText;
    let finalSearchText = parsed.searchText;
    
    // If using context, we need to get context product info first to replace placeholders
    let contextProductSubcategory = 'item';
    if (contextToUse?.productId) {
      const contextResult = await query(
        `SELECT sub_category FROM products WHERE id = $1`,
        [contextToUse.productId]
      );
      
      if (contextResult.rows.length > 0) {
        contextProductSubcategory = contextResult.rows[0].sub_category || 'item';
        // Replace placeholders in clipText and searchText if they exist
        if (finalClipText) {
          finalClipText = replaceContextPlaceholders(finalClipText, contextProductSubcategory);
        }
        if (finalSearchText) {
          finalSearchText = replaceContextPlaceholders(finalSearchText, contextProductSubcategory);
        }
      }
    }
    
    // Check if we have a valid user query (non-empty description or non-empty clipText/searchText after placeholder replacement)
    const hasUserQuery = (parsed.freeText && parsed.freeText.trim().length > 0) || 
                        (finalClipText && finalClipText.trim().length > 0) ||
                        (finalSearchText && finalSearchText.trim().length > 0);
    
    let userTextEmbedding: number[] | null = null;
    let userImageEmbedding: number[] | null = null;
    
    if (hasUserQuery) {
      // Only generate embeddings if we have valid clipText and searchText
      const embeddingPromises: Promise<any>[] = [];
      
      if (finalSearchText && finalSearchText.trim().length > 0) {
        embeddingPromises.push(
          withSpan(traceId || 'unknown', 'generate_user_text_embedding', async () => {
            return generateSemanticTextEmbedding({
              id: 0,
              title: parsed.freeText || '',
              search_text: finalSearchText
            } as any);
          }, { searchText: finalSearchText }, parentSpanId)
        );
      } else {
        embeddingPromises.push(Promise.resolve(null));
      }
      
      if (finalClipText && finalClipText.trim().length > 0) {
        embeddingPromises.push(
          withSpan(traceId || 'unknown', 'generate_user_image_embedding', async () => {
            return generateSigLipTextEmbedding(finalClipText);
          }, { clipText: finalClipText }, parentSpanId)
        );
      } else {
        embeddingPromises.push(Promise.resolve(null));
      }
      
      [userTextEmbedding, userImageEmbedding] = await Promise.all(embeddingPromises);
      
    }

    let finalTextEmbedding: number[] | null = userTextEmbedding;
    let finalImageEmbedding: number[] | null = userImageEmbedding;

    // Step 2: If context is provided, blend with context product embeddings
    if (contextToUse?.productId) {
      const contextEmbeddings = await withSpan(traceId || 'unknown', 'get_context_embeddings', async () => {
        const result = await query(
          `SELECT id, title, brand, category, sub_category, color, primary_material, 
                  embedding_text_semantic, embedding_image, search_text
           FROM products 
           WHERE id = $1`,
          [contextToUse.productId]
        );

        if (result.rows.length === 0) {
          throw new Error(`Context product not found: ${contextToUse.productId}`);
        }

        const contextProduct = result.rows[0];
        const { embedding_text_semantic, embedding_image } = contextProduct;
        
        return {
          textEmbedding: embedding_text_semantic ? JSON.parse(embedding_text_semantic) : null,
          imageEmbedding: embedding_image ? JSON.parse(embedding_image) : null
        };
      }, { contextProductId: contextToUse.productId }, parentSpanId);

      // Blend embeddings with 0.5 weight each, or use context only if no user query
      if (contextEmbeddings.textEmbedding) {
        if (userTextEmbedding) {
          finalTextEmbedding = blendEmbeddings(userTextEmbedding, contextEmbeddings.textEmbedding, 0.5, 0.5);
        } else {
          finalTextEmbedding = contextEmbeddings.textEmbedding;
        }
      }

      if (contextEmbeddings.imageEmbedding) {
        if (userImageEmbedding) {
          finalImageEmbedding = blendEmbeddings(userImageEmbedding, contextEmbeddings.imageEmbedding, 0.5, 0.5);
        } else {
          finalImageEmbedding = contextEmbeddings.imageEmbedding;
        }
      }
    }

    // Step 3: Perform dual embedding search (only if we have embeddings)
    const searchPromises: Promise<any[]>[] = [];
    
    if (finalTextEmbedding) {
      searchPromises.push(
        withSpan(traceId || 'unknown', 'text_embedding_search', async () => {
          return performEmbeddingSearch(finalTextEmbedding!, 'text', topK * 2, requestLogger, excludeProductId);
        }, { embeddingType: 'text', excludeProductId }, parentSpanId)
      );
    }
    
    if (finalImageEmbedding) {
      searchPromises.push(
        withSpan(traceId || 'unknown', 'image_embedding_search', async () => {
          return performEmbeddingSearch(finalImageEmbedding!, 'image', topK * 2, requestLogger, excludeProductId);
        }, { embeddingType: 'image', excludeProductId }, parentSpanId)
      );
    }
    
    // If no embeddings available, return empty results
    if (searchPromises.length === 0) {
      return { results: [] };
    }
    
    const searchResults = await Promise.all(searchPromises);
    
    // Assign results based on what searches were performed
    let textSearchResults: any[] = [];
    let imageSearchResults: any[] = [];
    
    let resultIndex = 0;
    if (finalTextEmbedding) {
      textSearchResults = searchResults[resultIndex++];
    }
    if (finalImageEmbedding) {
      imageSearchResults = searchResults[resultIndex++];
    }

    // Step 4: Combine results by averaging similarity scores    
    const combinedResults = combineEmbeddingResults(textSearchResults, imageSearchResults, topK, minSimilarityScore);

    // Step 5: Apply price filters if present
    const filteredResults = await applyPriceFilters(combinedResults, parsed.filters, requestLogger);

    // Step 6: Exclude the specified product ID if provided (safety check)
    const finalResults = excludeProductId 
      ? filteredResults.filter(r => String(r.product_id) !== String(excludeProductId))
      : filteredResults;

    return { 
      results: finalResults,
      finalImageEmbedding: finalImageEmbedding || null
    };

  } catch (error) {
    throw new Error(`Context-aware search failed: ${error}`);
  }
}

/**
 * Enrich search results with best offers
 */
export async function enrichWithBestOffers(
  searchResults: any[],
  filters: any,
  requestLogger?: any
): Promise<any[]> {
  if (searchResults.length === 0) {
    return [];
  }
  // Extract product IDs
  const productIds = searchResults.map(r => r.product_id);
  
  // Build offer query with price filters
  let offerQuery = `
    SELECT DISTINCT ON (o.product_id)
      o.id as offer_id,
      o.product_id,
      r.name as retailer,
      r.domain as retailer_domain,
      o.price,
      o.currency,
      o.original_price,
      o.url,
      o.affiliate_url,
      o.in_stock,
      o.condition
    FROM offers o
    JOIN retailers r ON o.retailer_id = r.id
    WHERE o.product_id = ANY($1)
      AND o.in_stock = true
  `;
  
  const queryParams: any[] = [productIds];
  let paramIndex = 2;

  // Add price filters
  if (filters.price?.min) {
    offerQuery += ` AND o.price >= $${paramIndex}`;
    queryParams.push(filters.price.min);
    paramIndex++;
  }
  
  if (filters.price?.max) {
    offerQuery += ` AND o.price <= $${paramIndex}`;
    queryParams.push(filters.price.max);
    paramIndex++;
  }
  
  if (filters.price?.currency) {
    offerQuery += ` AND o.currency = $${paramIndex}`;
    queryParams.push(filters.price.currency);
    paramIndex++;
  }

  // Add condition filter
  if (filters.attributes?.condition) {
    offerQuery += ` AND o.condition = $${paramIndex}`;
    queryParams.push(filters.attributes.condition);
    paramIndex++;
  }

  offerQuery += `
    ORDER BY o.product_id, o.price ASC
  `;

  try {
    const offerResult = await query(offerQuery, queryParams);

    // Fetch size information for all offers
    const offerIds = offerResult.rows.map((offer: any) => offer.offer_id);
    let sizeMap = new Map<number, string[]>();
    
    if (offerIds.length > 0) {
      const sizeQuery = `
        SELECT 
          ov.offer_id,
          COALESCE(ov.raw_size_label, ss.canonical_label) as size_label
        FROM offer_variants ov
        LEFT JOIN standard_sizes ss ON ov.standard_size_id = ss.id
        WHERE ov.offer_id = ANY($1)
          AND ov.in_stock = true
        ORDER BY ss.sort_order ASC NULLS LAST
      `;
      
      try {
        const sizeResult = await query(sizeQuery, [offerIds]);
        
        // Group sizes by offer_id
        sizeResult.rows.forEach((row: any) => {
          if (!sizeMap.has(row.offer_id)) {
            sizeMap.set(row.offer_id, []);
          }
          if (row.size_label) {
            sizeMap.get(row.offer_id)!.push(row.size_label);
          }
        });
        
      } catch (sizeError) {
      }
    }
    
    // Create a map of product_id -> best offer
    const offerMap = new Map();
    offerResult.rows.forEach((offer: any) => {
      const availableSizes = sizeMap.get(offer.offer_id) || [];
      
      offerMap.set(offer.product_id, {
        retailer: offer.retailer,
        retailer_domain: offer.retailer_domain,
        price: offer.price,
        currency: offer.currency,
        original_price: offer.original_price,
        url: offer.url,
        affiliate_url: offer.affiliate_url,
        in_stock: offer.in_stock,
        condition: offer.condition,
        available_sizes: availableSizes.length > 0 ? availableSizes : undefined,
      });
    });

    // Track products without offers for logging
    const productsWithoutOffers: number[] = [];

    // Enrich search results with offers
    const enrichedResults = searchResults
      .map(result => {
        const bestOffer = offerMap.get(result.product_id);
        if (!bestOffer) {
          productsWithoutOffers.push(result.product_id);
          return null; // Filter out products without offers
        }

        return {
          product_id: result.product_id,
          title: result.title,
          brand: result.brand,
          image_url: result.image_url,
          category: result.category,
          similarity_score: result.similarity_score,
          best_offer: bestOffer,
        };
      })
      .filter(Boolean);

    return enrichedResults;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    requestLogger?.error({ error: errorMessage }, 'Offer enrichment failed');
    throw new Error(`Offer enrichment failed: ${errorMessage}`);
  }
}

