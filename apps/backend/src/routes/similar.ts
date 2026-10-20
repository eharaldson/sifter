import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { query } from '../db';
import { createRequestLogger, generateRequestId, logger } from '../log';

// Request validation schema - simplified for similarity search only
const SimilarProductsRequestSchema = z.object({
  anchor_id: z.number().int().positive(),
  filters: z.object({
    max_price: z.number().positive().optional(),
    min_price: z.number().positive().optional(),
    condition: z.enum(['new', 'used', 'refurbished']).default('used'),
    country: z.string().length(2).optional(),
    currency: z.string().length(3).optional(),
    in_stock_only: z.boolean().default(true),
  }).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

type SimilarProductsRequest = z.infer<typeof SimilarProductsRequestSchema>;

export interface ProductCard {
  product_id: number;
  title: string;
  brand?: string;
  image_url?: string;
  category?: string;
  similarity_score?: number;
  best_offer: {
    retailer: string;
    retailer_domain: string;
    title?: string; // Retailer-specific title
    image_url?: string; // Retailer-specific image
    price: number;
    currency: string;
    original_price?: number;
    url: string;
    affiliate_url?: string;
    in_stock: boolean;
    condition: string;
  };
}

export async function similarRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: SimilarProductsRequest }>('/similar', {
    handler: async (
      request: FastifyRequest<{ Body: any }>, 
      reply: FastifyReply
    ) => {
      const requestId = generateRequestId();
      const requestLogger = createRequestLogger(requestId);
      const startTime = Date.now();

      try {
        // Validate request body
        const validationResult = SimilarProductsRequestSchema.safeParse(request.body);
        if (!validationResult.success) {
          return reply.code(400).send({
            error: 'Validation failed',
            details: validationResult.error.errors,
            request_id: requestId,
          });
        }

        const { anchor_id, filters = {}, limit } = validationResult.data;

        requestLogger.info({ 
          anchor_id, 
          filters, 
          limit 
        }, 'Finding similar products using embedding similarity');

        // Find similar products using embedding similarity
        const similarProducts = await findSimilarProductsByEmbedding(anchor_id, limit, filters, requestLogger);

        logger.info('similarProducts', similarProducts);

        // Enrich with best offers
        const productCards = await enrichWithBestOffers(similarProducts, filters);

        const duration = Date.now() - startTime;

        requestLogger.info({ 
          similar_products_found: similarProducts.length,
          products_with_offers: productCards.length,
          duration 
        }, 'Similar products search completed');

        return reply.code(200).send(productCards);

      } catch (error) {
        const duration = Date.now() - startTime;
        requestLogger.error({ 
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          duration 
        }, 'Similar products request failed');

        return reply.code(500).send({
          error: 'Internal server error',
          request_id: requestId,
        });
      }
    },
  });
}

/**
 * Find similar products using embedding similarity (both text and image)
 * Requires 0.7+ cosine similarity in both text and image embeddings
 * Orders by image cosine similarity and returns top N results
 */
async function findSimilarProductsByEmbedding(
  anchorId: number, 
  limit: number,
  filters: any,
  requestLogger: any
): Promise<any[]> {
  // First get the anchor product's embeddings
  const anchorResult = await query(
    'SELECT id, title, brand, image_url, sub_category_norm, embedding_image, embedding_text_semantic FROM products WHERE id = $1',
    [anchorId]
  );

  if (anchorResult.rows.length === 0) {
    throw new Error('Anchor product not found');
  }

  const anchor = anchorResult.rows[0];

  if (!anchor.embedding_image || !anchor.embedding_text_semantic) {
    throw new Error('Anchor product missing required embeddings');
  }

  /**
   * Two-phase retrieval:
   * - Phase A: retrieve candidates via ANN-friendly kNN queries:
   *   - top 100 by image embedding distance
   *   - top 100 by text embedding distance
   * - Phase B: union candidates (<=200), compute mixed similarity, filter, and re-rank.
   *
   * Keep phase A shaped as `ORDER BY embedding <=> $vec LIMIT k` so pgvector can use
   * HNSW/IVFFlat indexes, then do heavier scoring on the small candidate set.
   */
  const params = [
    anchor.embedding_image,
    anchor.embedding_text_semantic,
    anchorId,
    limit
  ];

  var minImageSimilarity = 0.4;
  var minTextSimilarity = 0.7;

  let conditionClause = '';
  if (filters?.condition) {
    const conditionParamIndex = params.length + 1;
    conditionClause = `
      AND EXISTS (
        SELECT 1 FROM offers o
        WHERE o.product_id = p.id
          AND o.condition = $${conditionParamIndex}
          ${filters.in_stock_only ? 'AND o.in_stock = true' : ''}
      )
    `;
    params.push(filters.condition);

    if (filters.condition == 'used') {
      minImageSimilarity = 0;
      minTextSimilarity = 0;
    }
  }

  const similarityQuery = `
    WITH image_candidates AS (
      SELECT p.id
      FROM products p
      WHERE p.id != $3
        AND p.embedding_image IS NOT NULL
      ORDER BY p.embedding_image <=> $1::vector
      LIMIT 100
    ),
    text_candidates AS (
      SELECT p.id
      FROM products p
      WHERE p.id != $3
        AND p.embedding_text_semantic IS NOT NULL
      ORDER BY p.embedding_text_semantic <=> $2::vector
      LIMIT 100
    ),
    candidates AS (
      SELECT id FROM image_candidates
      UNION
      SELECT id FROM text_candidates
    )
    SELECT 
      p.id as product_id,
      p.title,
      p.brand,
      p.image_url,
      p.category,
      (1 - (p.embedding_image <=> $1::vector)) as image_similarity,
      (1 - (p.embedding_text_semantic <=> $2::vector)) as text_similarity,
      ((0.35 * (1 - (p.embedding_text_semantic <=> $2::vector))) + (1 - (p.embedding_image <=> $1::vector))) as mixed_similarity
    FROM products p
    JOIN candidates c ON c.id = p.id
    WHERE p.embedding_image IS NOT NULL
      AND p.embedding_text_semantic IS NOT NULL
      AND ((1 - (p.embedding_image <=> $1::vector)) >= ${minImageSimilarity}
      OR (1 - (p.embedding_text_semantic <=> $2::vector)) >= ${minTextSimilarity})
      ${conditionClause}
    ORDER BY mixed_similarity DESC
    LIMIT $4
  `;

  const result = await query(similarityQuery, params);

  return result.rows;
}

/**
 * Enrich search results with best offers for each product
 */
async function enrichWithBestOffers(
  searchResults: any[], 
  filters: any
): Promise<ProductCard[]> {
  if (searchResults.length === 0) return [];

  const productIds = searchResults.map(p => p.product_id);

  /**
   * Best-offer query improvement:
   * Use DISTINCT ON (product_id) to pick the cheapest offer per product with a stable tie-breaker.
   * This generally performs better than a ROW_NUMBER() window for this pattern.
   */
  let offerQuery = `
    SELECT DISTINCT ON (o.product_id)
      o.product_id,
      o.title,
      o.image_url,
      o.price,
      o.currency,
      o.original_price,
      o.url,
      o.affiliate_url,
      o.in_stock,
      o.condition,
      r.name as retailer_name,
      r.domain as retailer_domain
    FROM offers o
    JOIN retailers r ON o.retailer_id = r.id
    WHERE o.product_id = ANY($1)
  `;

  const offerParams: any[] = [productIds];
  let paramIndex = 2;

  // Add offer filters
  if (filters.max_price) {
    offerQuery += ` AND o.price <= $${paramIndex}`;
    offerParams.push(filters.max_price);
    paramIndex++;
  }

  if (filters.min_price) {
    offerQuery += ` AND o.price >= $${paramIndex}`;
    offerParams.push(filters.min_price);
    paramIndex++;
  }

  if (filters.condition) {
    offerQuery += ` AND o.condition = $${paramIndex}`;
    offerParams.push(filters.condition);
    paramIndex++;
  }

  if (filters.country) {
    offerQuery += ` AND (o.country = $${paramIndex} OR o.country IS NULL)`;
    offerParams.push(filters.country);
    paramIndex++;
  }

  if (filters.currency) {
    offerQuery += ` AND o.currency = $${paramIndex}`;
    offerParams.push(filters.currency);
    paramIndex++;
  }

  if (filters.in_stock_only) {
    offerQuery += ` AND o.in_stock = true`;
  }

  offerQuery += `
    ORDER BY o.product_id, o.price ASC, o.last_seen_at DESC
  `;

  const offerResult = await query(offerQuery, offerParams);
  const offersByProduct = new Map(
    offerResult.rows.map((offer: any) => [offer.product_id, offer])
  );

  // Combine search results with best offers
  const productCards: ProductCard[] = [];

  for (const product of searchResults) {
    const bestOffer = offersByProduct.get(product.product_id);
    
    // Skip products without offers (based on filters)
    if (!bestOffer) continue;

    const offer = bestOffer as any;

    productCards.push({
      product_id: product.product_id,
      title: product.title,
      brand: product.brand || undefined,
      image_url: product.image_url || undefined,
      category: product.category || undefined,
      similarity_score: parseFloat(product.image_similarity) || undefined, // Use image similarity as main score
      best_offer: {
        retailer: offer.retailer_name,
        retailer_domain: offer.retailer_domain,
        title: offer.title || undefined, // Retailer-specific title
        image_url: offer.image_url || undefined, // Retailer-specific image
        price: parseFloat(offer.price),
        currency: offer.currency,
        original_price: offer.original_price ? parseFloat(offer.original_price) : undefined,
        url: offer.url,
        affiliate_url: offer.affiliate_url || undefined,
        in_stock: offer.in_stock,
        condition: offer.condition,
      },
    });
  }

  return productCards;
}
