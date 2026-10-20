import { generateSemanticTextEmbedding, generateSigLipTextEmbedding, generateSigLipImageEmbeddingFromUserInput } from '../embeddings';
import { query } from '../db';
import { logger } from '../log';

export interface SearchInput {
  userText?: string;
  userImage?: string; // base64 or URL
  contextProduct?: {
    searchText?: string;
    embedding_text_semantic?: number[];
    embedding_image?: number[];
  };
  modifiedSearchText?: string;
  modifiedClipCaption?: string;
}

export interface SearchManagerResult {
  strategy: 'image_only' | 'text_only' | 'hybrid_image_text';
  embeddings: {
    textSemantic?: number[];
    imageSigLip?: number[];
  };
  weights?: {
    imageSigLip: number;
    textSemantic: number;
  };
}

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
    return blended;
  }
  
  return blended.map(val => val / magnitude);
}

/**
 * Average multiple embeddings with optional weights (used for triple embedding approach)
 * @param embeddings Array of embeddings to average
 * @param weights Optional array of weights for each embedding. If provided, must match embeddings length.
 *                Weights will be normalized to sum to 1. If not provided, uses equal weights (simple average).
 */
function averageEmbeddings(embeddings: number[][], weights?: number[]): number[] {
  if (embeddings.length === 0) {
    throw new Error('No embeddings to average');
  }
  
  // Validate weights if provided
  if (weights) {
    if (weights.length !== embeddings.length) {
      throw new Error(`Weights length (${weights.length}) must match embeddings length (${embeddings.length})`);
    }
    
    // Normalize weights to sum to 1
    const weightSum = weights.reduce((sum, w) => sum + w, 0);
    if (weightSum === 0) {
      throw new Error('Weights cannot all be zero');
    }
    weights = weights.map(w => w / weightSum);
  } else {
    // Default to equal weights (simple average)
    weights = new Array(embeddings.length).fill(1 / embeddings.length);
  }
  
  const dimensions = embeddings[0].length;
  const averaged = new Array(dimensions).fill(0);
  
  // Weighted sum of all embeddings
  for (let j = 0; j < embeddings.length; j++) {
    const embedding = embeddings[j];
    const weight = weights![j];
    
    if (embedding.length !== dimensions) {
      throw new Error('Embedding dimensions mismatch in averaging');
    }
    
    for (let i = 0; i < dimensions; i++) {
      averaged[i] += embedding[i] * weight;
    }
  }
  
  // L2 normalize
  const magnitude = Math.sqrt(averaged.reduce((sum, val) => sum + val * val, 0));
  if (magnitude === 0) {
    return averaged;
  }
  
  return averaged.map(val => val / magnitude);
}

/**
 * Search Manager - determines search strategy based on inputs
 */
export async function determineSearchStrategy(input: SearchInput): Promise<SearchManagerResult> {
  const hasUserText = !!input.userText?.trim();
  const hasUserImage = !!input.userImage;
  const hasContextProduct = !!input.contextProduct;
  const hasModifiedSearchText = !!input.modifiedSearchText?.trim();
  const hasModifiedClipCaption = !!input.modifiedClipCaption?.trim();
  
  // Case 1: User provides only image
  if (hasUserImage && !hasUserText && !hasContextProduct) {
    logger.info('CASE 1: User provides only image');
    const imageEmbedding = await generateSigLipImageEmbeddingFromUserInput(input.userImage!);

    return {
      strategy: 'image_only',
      embeddings: {
        imageSigLip: imageEmbedding
      }
    };
  }
  
  // Case 2: User provides only text (no context)
  if (hasUserText && !hasUserImage && !hasContextProduct) {
    logger.info('CASE 2: User provides only text');
    const [textSemanticEmb, textSigLipEmb] = await Promise.all([
      generateSemanticTextEmbedding({ 
        id: 0, 
        title: input.userText!, 
        search_text: input.userText! 
      } as any).then(result => {
        return result;
      }),
      generateSigLipTextEmbedding(input.userText!).then(result => {
        return result;
      })
    ]);
    
    return {
      strategy: 'text_only',
      embeddings: {
        textSemantic: textSemanticEmb,
        imageSigLip: textSigLipEmb
      },
      weights: {
        imageSigLip: 0.7,
        textSemantic: 0.3
      }
    };
  }
  
  // Case 3: User provides image + text
  if (hasUserImage && hasUserText) {
    logger.info('CASE 3: User provides image + text');
    const [imageEmb, textSigLipEmb] = await Promise.all([
      generateSigLipImageEmbeddingFromUserInput(input.userImage!),
      generateSigLipTextEmbedding(input.userText!)
    ]);
    
    // Weighted average of image and text SigLIP embeddings (70/30 split)
    const blendedSigLip = blendEmbeddings(imageEmb, textSigLipEmb, 0.4, 0.6);
    
    // Also generate semantic text embedding
    const textSemanticEmb = await generateSemanticTextEmbedding({
      id: 0,
      title: input.userText!,
      search_text: input.userText!
    } as any);
    
    return {
      strategy: 'hybrid_image_text',
      embeddings: {
        imageSigLip: blendedSigLip,
        textSemantic: textSemanticEmb
      },
      weights: {
        imageSigLip: 0.55,
        textSemantic: 0.45
      }
    };
  }
  
  // Case 4: Context product with modifications (triple embedding)
  if (hasContextProduct && (hasModifiedSearchText || hasModifiedClipCaption)) {
    logger.info('CASE 4: Context product with modifications');
    logger.info('Modified search text: ' + input.modifiedSearchText);
    logger.info('Modified clip caption: ' + input.modifiedClipCaption);
    const embeddingsToGenerate: Promise<number[] | null>[] = [];
    
    // Generate new semantic text embedding if search text modified
    if (hasModifiedSearchText) {
      embeddingsToGenerate.push(
        generateSemanticTextEmbedding({
          id: 0,
          title: input.modifiedSearchText!,
          search_text: input.modifiedSearchText!
        } as any)
      );
    } else {
      embeddingsToGenerate.push(Promise.resolve(null));
    }
    
    // Generate new SigLIP text embedding if CLIP caption modified
    if (hasModifiedClipCaption) {
      embeddingsToGenerate.push(
        generateSigLipTextEmbedding(input.modifiedClipCaption!)
      );
    } else {
      embeddingsToGenerate.push(Promise.resolve(null));
    }
    
    const [newTextSemantic, newTextSigLip] = await Promise.all(embeddingsToGenerate);
    
    // For semantic text: use new one if available, otherwise context
    const textSemanticEmb = newTextSemantic || input.contextProduct!.embedding_text_semantic;
    
    // For SigLIP: weighted average of new text caption and existing image embeddings
    const sigLipEmbeddings: number[][] = [];
    const sigLipWeights: number[] = [];
    
    if (newTextSigLip) {
      sigLipEmbeddings.push(newTextSigLip);
      sigLipWeights.push(0.5); // Weight for text SigLIP embedding
    }
    
    if (input.contextProduct!.embedding_image) {
      sigLipEmbeddings.push(input.contextProduct!.embedding_image);
      sigLipWeights.push(0.5); // Weight for image embedding (higher weight for visual similarity)
    }
    
    // If we have multiple SigLIP embeddings, weighted average them
    const imageSigLipEmb = sigLipEmbeddings.length > 1 
      ? averageEmbeddings(sigLipEmbeddings, sigLipWeights)
      : sigLipEmbeddings[0];
    
    return {
      strategy: 'hybrid_image_text',
      embeddings: {
        textSemantic: textSemanticEmb,
        imageSigLip: imageSigLipEmb
      },
      weights: {
        imageSigLip: 0.7,
        textSemantic: 0.3
      }
    };
  }
  
  // Case 5: Context product without modifications
  if (hasContextProduct && !hasModifiedSearchText && !hasModifiedClipCaption) {
    logger.info('CASE 5: Context product without modifications');
    return {
      strategy: 'hybrid_image_text',
      embeddings: {
        textSemantic: input.contextProduct!.embedding_text_semantic,
        imageSigLip: input.contextProduct!.embedding_image
      },
      weights: {
        imageSigLip: 0.7,
        textSemantic: 0.3
      }
    };
  }
  
  // Fallback: text only search with user text
  const fallbackText = input.userText || input.modifiedSearchText || 'fashion item';
  
  const [textSemanticEmb, textSigLipEmb] = await Promise.all([
    generateSemanticTextEmbedding({
      id: 0,
      title: fallbackText,
      search_text: fallbackText
    } as any),
    generateSigLipTextEmbedding(fallbackText)
  ]);
  
  logger.info('CASE 6: Fallback: text only search with user text');
  return {
    strategy: 'text_only',
    embeddings: {
      textSemantic: textSemanticEmb,
      imageSigLip: textSigLipEmb
    },
    weights: {
      imageSigLip: 0.7,
      textSemantic: 0.3
    }
  };
}

/**
 * Perform embedding search with Search Manager strategy
 */
export async function performManagedSearch(
  searchStrategy: SearchManagerResult,
  topK: number,
  excludeProductIds?: string[],
  filters?: any
): Promise<any[]> {
  
  if (searchStrategy.strategy === 'image_only') {
    // Simple SigLIP image search
    return performSingleEmbeddingSearch(
      searchStrategy.embeddings.imageSigLip!,
      'embedding_image',
      topK,
      excludeProductIds,
      filters
    );
  }
  
  if (searchStrategy.strategy === 'text_only') {
    // Dual embedding search with mixed similarity score
    // mixed_similarity_score = (0.5 * text_embedding_similarity) + image_siglip_embedding_similarity
    return performDualEmbeddingSearch(
      searchStrategy.embeddings.textSemantic!,
      searchStrategy.embeddings.imageSigLip!,
      topK,
      excludeProductIds,
      filters,
      0.7,
      0.3,
      0.5
    );
  }
  
  // Hybrid search with weighted RRF fusion
  // If we only have imageSigLip embedding, fall back to single embedding search
  if (!searchStrategy.embeddings.textSemantic) {
    return performSingleEmbeddingSearch(
      searchStrategy.embeddings.imageSigLip!,
      'embedding_image',
      topK,
      excludeProductIds,
      filters,
      0.4
    );
  }

  // If we only have textSemantic embedding, fall back to single embedding search
  if (!searchStrategy.embeddings.imageSigLip) {
    return performSingleEmbeddingSearch(
      searchStrategy.embeddings.textSemantic!,
      'embedding_text_semantic',
      topK,
      excludeProductIds,
      filters,
      0.65
    );
  }

  logger.info('Performing dual embedding search with minimum similarity scores: text 0, image 0, mixed 0');
  return performDualEmbeddingSearch(
    searchStrategy.embeddings.textSemantic!,
    searchStrategy.embeddings.imageSigLip!,
    topK,
    excludeProductIds,
    filters,
    0,
    0,
    0
  );
  
  // const [sigLipResults, semanticResults] = await Promise.all([
  //   performSingleEmbeddingSearch(
  //     searchStrategy.embeddings.imageSigLip,
  //     'embedding_image',
  //     topK * 5,
  //     excludeProductIds,
  //     filters,
  //     0.35
  //   ),
  //   performSingleEmbeddingSearch(
  //     searchStrategy.embeddings.textSemantic,
  //     'embedding_text_semantic',
  //     topK * 5,
  //     excludeProductIds,
  //     filters,
  //     0.65
  //   )
  // ]);
  
  // return fuseResultsWithRRF(
  //   sigLipResults, 
  //   semanticResults, 
  //   topK, 
  //   searchStrategy.weights!.imageSigLip, 
  //   searchStrategy.weights!.textSemantic
  // );
}

/**
 * Perform dual embedding search with mixed similarity score
 * mixed_similarity_score = (0.5 * text_embedding_similarity) + image_siglip_embedding_similarity
 */
async function performDualEmbeddingSearch(
  textSemanticEmbedding: number[],
  imageSigLipEmbedding: number[],
  limit: number,
  excludeProductIds?: string[],
  filters?: any,
  minTextSimilarityScore?: number,
  minImageSimilarityScore?: number,
  minMixedSimilarityScore?: number
): Promise<any[]> {
  /**
   * Two-phase retrieval (same approach as /similar):
   * - Phase A: retrieve candidates with ANN-friendly kNN queries:
   *   - top 100 by image embedding distance
   *   - top 100 by text embedding distance
   * - Phase B: union candidates (<=200), then apply heavier filters + mixed similarity re-rank.
   *
   * This keeps phase A in the shape pgvector indexes can accelerate:
   *   ORDER BY embedding <=> $vec LIMIT k
   */
  const queryParams: any[] = [JSON.stringify(textSemanticEmbedding), JSON.stringify(imageSigLipEmbedding)];
  let paramIndex = 3;

  // Optional filter params (stored once, referenced in both candidate subqueries and final query)
  let excludeIdsParam: number | null = null;
  if (excludeProductIds && excludeProductIds.length > 0) {
    excludeIdsParam = paramIndex;
    queryParams.push(excludeProductIds);
    paramIndex++;
  }

  let brandParam: number | null = null;
  if (filters?.brand && filters.brand.length > 0) {
    brandParam = paramIndex;
    queryParams.push(filters.brand);
    paramIndex++;
  }

  let genderParam: number | null = null;
  if (filters?.gender) {
    genderParam = paramIndex;
    queryParams.push(filters.gender);
    paramIndex++;
  }

  // Similarity threshold params (applied in phase B only)
  let minMixedParam: number | null = null;
  if (minMixedSimilarityScore !== undefined && minMixedSimilarityScore > 0) {
    minMixedParam = paramIndex;
    queryParams.push(minMixedSimilarityScore);
    paramIndex++;
  }

  let minTextParam: number | null = null;
  if (minTextSimilarityScore !== undefined && minTextSimilarityScore > 0) {
    minTextParam = paramIndex;
    queryParams.push(minTextSimilarityScore);
    paramIndex++;
  }

  let minImageParam: number | null = null;
  if (minImageSimilarityScore !== undefined && minImageSimilarityScore > 0) {
    minImageParam = paramIndex;
    queryParams.push(minImageSimilarityScore);
    paramIndex++;
  }

  // Size filter params (phase B only; can be expensive due to joins)
  let sizeValuesParam: number | null = null;
  let sizeRegionParam: number | null = null;
  let sizeTypeParam: number | null = null;
  if (filters?.size?.values && filters.size.values.length > 0) {
    sizeValuesParam = paramIndex;
    queryParams.push(filters.size.values);
    paramIndex++;

    if (filters.size.region) {
      sizeRegionParam = paramIndex;
      queryParams.push(filters.size.region);
      paramIndex++;
    }

    if (filters.size.type) {
      sizeTypeParam = paramIndex;
      queryParams.push(filters.size.type);
      paramIndex++;
    }
  }

  // Price/condition filter params (phase B only; can be expensive due to EXISTS)
  let priceMinParam: number | null = null;
  let priceMaxParam: number | null = null;
  let priceCurrencyParam: number | null = null;
  let conditionParam: number | null = null;

  if (filters?.price?.min !== undefined) {
    priceMinParam = paramIndex;
    queryParams.push(filters.price.min);
    paramIndex++;
  }
  if (filters?.price?.max !== undefined) {
    priceMaxParam = paramIndex;
    queryParams.push(filters.price.max);
    paramIndex++;
  }
  if (filters?.price?.currency) {
    priceCurrencyParam = paramIndex;
    queryParams.push(filters.price.currency);
    paramIndex++;
  }
  if (filters?.condition) {
    conditionParam = paramIndex;
    queryParams.push(filters.condition);
    paramIndex++;
  }

  // Final limit param
  const limitParam = paramIndex;
  queryParams.push(limit);

  const candidateFiltersSql = `
    WHERE p.embedding_text_semantic IS NOT NULL
      AND p.embedding_image IS NOT NULL
      ${excludeIdsParam ? `AND NOT (p.id::text = ANY($${excludeIdsParam}::text[]))` : ''}
      ${brandParam ? `AND p.brand_norm = ANY($${brandParam}::text[])` : ''}
      ${
        genderParam
          ? `AND (p.gender_norm = $${genderParam} OR p.gender_norm IS NULL OR p.gender_norm = 'unisex')`
          : ''
      }
  `;

  let searchQuery = `
    WITH image_candidates AS (
      SELECT p.id
      FROM products p
      ${candidateFiltersSql}
      ORDER BY p.embedding_image <=> $2::vector
      LIMIT 100
    ),
    text_candidates AS (
      SELECT p.id
      FROM products p
      ${candidateFiltersSql}
      ORDER BY p.embedding_text_semantic <=> $1::vector
      LIMIT 100
    ),
    candidates AS (
      SELECT id FROM image_candidates
      UNION
      SELECT id FROM text_candidates
    )
    SELECT 
      p.id::text as product_id,
      p.title,
      p.brand,
      p.category,
      p.sub_category,
      p.color,
      p.primary_material,
      p.image_url,
      p.search_text,
      (1 - (p.embedding_text_semantic <=> $1::vector)) as text_similarity_score,
      (1 - (p.embedding_image <=> $2::vector)) as image_similarity_score,
      ((0.45 * (1 - (p.embedding_text_semantic <=> $1::vector))) + (1 - (p.embedding_image <=> $2::vector))) as mixed_similarity_score
    FROM products p
    JOIN candidates c ON c.id = p.id
    WHERE p.embedding_text_semantic IS NOT NULL
      AND p.embedding_image IS NOT NULL
  `;

  // Phase B: apply "heavy" filters only to the small candidate set
  if (sizeValuesParam) {
    searchQuery += `
      AND EXISTS (
        SELECT 1 FROM offers o
        JOIN offer_variants ov ON ov.offer_id = o.id
        LEFT JOIN standard_sizes ss ON ov.standard_size_id = ss.id
        WHERE o.product_id = p.id
          AND (
            ss.canonical_label = ANY($${sizeValuesParam}::text[])
            OR ov.raw_size_label = ANY($${sizeValuesParam}::text[])
          )
          ${sizeRegionParam ? `AND (ss.region = $${sizeRegionParam} OR ss.region IS NULL)` : ''}
          ${sizeTypeParam ? `AND (ss.type = $${sizeTypeParam} OR ss.type IS NULL)` : ''}
      )
    `;
  }

  if (priceMinParam || priceMaxParam || priceCurrencyParam || conditionParam) {
    searchQuery += `
      AND EXISTS (
        SELECT 1 FROM offers o
        WHERE o.product_id = p.id
          AND o.in_stock = true
          ${priceMinParam ? `AND o.price >= $${priceMinParam}` : ''}
          ${priceMaxParam ? `AND o.price <= $${priceMaxParam}` : ''}
          ${priceCurrencyParam ? `AND o.currency = $${priceCurrencyParam}` : ''}
          ${conditionParam ? `AND o.condition = $${conditionParam}` : ''}
      )
    `;
  }

  // Similarity thresholds: AND (mixed >= x OR text >= y OR image >= z)
  const thresholdClauses: string[] = [];
  if (minMixedParam) {
    thresholdClauses.push(
      `((0.45 * (1 - (p.embedding_text_semantic <=> $1::vector))) + (1 - (p.embedding_image <=> $2::vector))) >= $${minMixedParam}`
    );
  }
  if (minTextParam) {
    thresholdClauses.push(`(1 - (p.embedding_text_semantic <=> $1::vector)) >= $${minTextParam}`);
  }
  if (minImageParam) {
    thresholdClauses.push(`(1 - (p.embedding_image <=> $2::vector)) >= $${minImageParam}`);
  }
  if (thresholdClauses.length > 0) {
    searchQuery += ` AND (${thresholdClauses.join(' OR ')})`;
  }

  searchQuery += `
    ORDER BY mixed_similarity_score DESC
    LIMIT $${limitParam}
  `;
  
  try {
    const result = await query(searchQuery, queryParams);

    logger.info('Dual embedding search result: ' + result.rows.length);
    
    return result.rows.map((row: any) => ({
      ...row,
      similarity_score: row.mixed_similarity_score
    }));
  } catch (error) {
    throw error;
  }
}

/**
 * Perform single embedding search
 */
async function performSingleEmbeddingSearch(
  embedding: number[],
  embeddingColumn: string,
  limit: number,
  excludeProductIds?: string[],
  filters?: any,
  minSimilarityScore?: number
): Promise<any[]> {  
  let searchQuery = `
    SELECT 
      p.id::text as product_id,
      p.title,
      p.brand,
      p.category,
      p.sub_category,
      p.color,
      p.primary_material,
      p.image_url,
      p.search_text,
      (1 - (p.${embeddingColumn} <=> $1::vector)) as similarity_score
    FROM products p
    WHERE p.${embeddingColumn} IS NOT NULL
  `;
  
  const queryParams: any[] = [JSON.stringify(embedding)];
  let paramIndex = 2;
  
  // Add exclusion clause if product IDs are provided
  if (excludeProductIds && excludeProductIds.length > 0) {
    searchQuery += ` AND p.id::text NOT IN (${excludeProductIds.map((_, i) => `$${paramIndex + i}`).join(', ')})`;
    queryParams.push(...excludeProductIds);
    paramIndex += excludeProductIds.length;
  }
  
  // Add brand filter
  if (filters?.brand && filters.brand.length > 0) {
    searchQuery += ` AND p.brand_norm IN (${filters.brand.map((_: any, i: number) => `$${paramIndex + i}`).join(', ')})`;
    queryParams.push(...filters.brand);
    paramIndex += filters.brand.length;
  }
  
  // Add color filter
  // if (filters?.color && filters.color.length > 0) {
  //   searchQuery += ` AND p.color_norm IN (${filters.color.map((_: any, i: number) => `$${paramIndex + i}`).join(', ')})`;
  //   queryParams.push(...filters.color);
  //   paramIndex += filters.color.length;
  //   logger.debug({ colors: filters.color, paramIndex }, '🎨 Added color filter');
  // }
  
  // Add subcategory filter
  // if (filters?.subcategory) {
  //   searchQuery += ` AND p.sub_category_norm IN (${filters.subcategory.map((_: any, i: number) => `$${paramIndex + i}`).join(', ')})`;
  //   queryParams.push(...filters.subcategory);
  //   paramIndex += filters.subcategory.length;
  //   logger.debug({ subcategory: filters.subcategory, paramIndex }, '📂 Added subcategory filter');
  // }
  
  // Add material filter
  // if (filters?.material && filters.material.length > 0) {
  //   searchQuery += ` AND p.primary_material_norm IN (${filters.material.map((_: any, i: number) => `$${paramIndex + i}`).join(', ')})`;
  //   queryParams.push(...filters.material);
  //   paramIndex += filters.material.length;
  //   logger.debug({ materials: filters.material, paramIndex }, '🧵 Added material filter');
  // }
  
  // Add gender filter
  if (filters?.gender) {
    searchQuery += ` AND (p.gender_norm = $${paramIndex} OR p.gender_norm IS NULL OR p.gender_norm = 'unisex')`;
    queryParams.push(filters.gender);
    paramIndex++;
  }
  
  // Add size filter via EXISTS subquery on offer_variants and standard_sizes
  if (filters?.size && filters.size.values && filters.size.values.length > 0) {    
    searchQuery += ` AND EXISTS (
      SELECT 1 FROM offers o
      JOIN offer_variants ov ON ov.offer_id = o.id
      LEFT JOIN standard_sizes ss ON ov.standard_size_id = ss.id
      WHERE o.product_id = p.id
      AND (`;
    
    // Match by canonical label in standard_sizes OR by raw label
    const sizeConditions: string[] = [];
    
    for (let i = 0; i < filters.size.values.length; i++) {
      // Match either by standard size canonical label or raw size label
      sizeConditions.push(`(ss.canonical_label = $${paramIndex + i} OR ov.raw_size_label = $${paramIndex + i})`);
    }
    
    searchQuery += sizeConditions.join(' OR ');
    searchQuery += ')';
    
    // Add region filter if specified
    if (filters.size.region) {
      searchQuery += ` AND (ss.region = $${paramIndex + filters.size.values.length} OR ss.region IS NULL)`;
      queryParams.push(...filters.size.values, filters.size.region);
      paramIndex += filters.size.values.length + 1;
    } else {
      queryParams.push(...filters.size.values);
      paramIndex += filters.size.values.length;
    }
    
    // Add type filter if specified
    if (filters.size.type) {
      searchQuery += ` AND (ss.type = $${paramIndex} OR ss.type IS NULL)`;
      queryParams.push(filters.size.type);
      paramIndex++;
    }
    
    searchQuery += ')';
  }
  
  // Add price and condition filters via EXISTS subquery on offers
  if (filters?.price || filters?.condition) {

    searchQuery += ` AND EXISTS (
      SELECT 1 FROM offers o
      WHERE o.product_id = p.id
      AND o.in_stock = true`;

    if (filters?.price?.min) {
      searchQuery += ` AND o.price >= $${paramIndex}`;
      queryParams.push(filters.price.min);
      paramIndex++;
    }

    if (filters?.price?.max) {
      searchQuery += ` AND o.price <= $${paramIndex}`;
      queryParams.push(filters.price.max);
      paramIndex++;
    }

    if (filters?.price?.currency) {
      searchQuery += ` AND o.currency = $${paramIndex}`;
      queryParams.push(filters.price.currency);
      paramIndex++;
    }

    if (filters?.condition) {
      searchQuery += ` AND o.condition = $${paramIndex}`;
      queryParams.push(filters.condition);
      paramIndex++;
    }

    searchQuery += ')';
  }

  // Add minimum similarity score filter
  if (minSimilarityScore !== undefined && minSimilarityScore > 0) {
    searchQuery += ` AND (1 - (p.${embeddingColumn} <=> $1::vector)) >= $${paramIndex}`;
    queryParams.push(minSimilarityScore);
    paramIndex++;
  }

  searchQuery += `
    ORDER BY p.${embeddingColumn} <=> $1::vector
    LIMIT $${paramIndex}
  `;
  
  queryParams.push(limit);
  
  try {
    const result = await query(searchQuery, queryParams);
    
    return result.rows;
  } catch (error) {
    throw error;
  }
}

/**
 * Fuse results using Weighted Reciprocal Rank Fusion (RRF)
 */
function fuseResultsWithRRF(
  results1: any[],
  results2: any[],
  topK: number,
  weight1: number,
  weight2: number
): any[] {
  const k = 60; // RRF constant
  const fusedScores = new Map<string, { score: number; product: any }>();
  
  // Process first result set
  results1.forEach((result, rank) => {
    const productId = result.product_id;
    const rrfScore = weight1 * (1 / (k + rank + 1));
    fusedScores.set(productId, {
      score: rrfScore,
      product: result
    });
  });
  
  // Process second result set
  results2.forEach((result, rank) => {
    const productId = result.product_id;
    const rrfScore = weight2 * (1 / (k + rank + 1));
    
    if (fusedScores.has(productId)) {
      // Product appeared in both results
      const existing = fusedScores.get(productId)!;
      existing.score += rrfScore;
      // Average the similarity scores
      existing.product.similarity_score = 
        (existing.product.similarity_score + result.similarity_score) / 2;
    } else {
      fusedScores.set(productId, {
        score: rrfScore,
        product: result
      });
    }
  });
  
  // Sort by fused score and return top K
  const sortedResults = Array.from(fusedScores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(item => ({
      ...item.product,
      fused_score: item.score
    }));
  
  return sortedResults;
}
