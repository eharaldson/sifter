import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createRequestLogger, generateRequestId, logger } from '../log';
import { searchAndFilterByImageSimilarity, scrapeProductDetails } from '../services/serpapi-shopping';
import { createTrace, startSpan, endSpan, finishTrace, withSpan } from '../observability/trace';
import { resolveProduct } from '../match/resolve';
import { normalizeExtracted, extractDomain } from '../match/normalize';

// Request validation schema
const SerpSearchRequestSchema = z.object({
  imageEmbedding: z.array(z.number()).optional(), // Optional - can use keywords instead
  searchKeywords: z.string().optional(), // Keywords for Google Shopping search
  contextSearchText: z.string().optional(),
  parsedSearchText: z.string().optional(),
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  neededCount: z.number().int().min(1).max(50).default(12),
  filters: z.object({
    attributes: z.object({
      condition: z.string().nullable().optional(),
    }).optional(),
  }).optional(),
  topK: z.number().int().min(1).max(50).default(12),
  location: z.string().optional(), // Country code (e.g., 'us', 'gb', 'ca')
});

type SerpSearchRequest = z.infer<typeof SerpSearchRequestSchema>;

export interface SerpSearchResponse {
  results: Array<{
    product_id: string; // SerpAPI product_id is a string
    title: string;
    brand?: string;
    image_url?: string;
    category?: string;
    similarity_score?: number;
    _source: 'serpapi'; // Metadata to distinguish from database products
    best_offer: {
      retailer: string;
      retailer_domain: string;
      price: number;
      currency: string;
      original_price?: number;
      url: string;
      affiliate_url?: string;
      in_stock: boolean;
      condition: string;
    };
  }>;
  traceId: string;
}

export async function serpSearchRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: SerpSearchRequest }>('/serp-search', {
    handler: async (
      request: FastifyRequest<{ Body: any }>, 
      reply: FastifyReply
    ) => {
      const requestId = generateRequestId();
      const requestLogger = createRequestLogger(requestId);
      const startTime = Date.now();

      // Create trace context before starting spans
      createTrace(requestId);

      const requestBody = request.body as any;
      const rootSpan = startSpan(requestId, 'serpapi_search', {
        neededCount: requestBody?.neededCount,
        hasContext: !!requestBody?.contextSearchText,
        hasPriceFilters: !!(requestBody?.minPrice || requestBody?.maxPrice),
        isSecondHand: requestBody?.filters?.attributes?.condition === 'used'
      });

      try {
        // Validate request body
        const validationResult = SerpSearchRequestSchema.safeParse(request.body);
        if (!validationResult.success) {
          endSpan(requestId, rootSpan.id, undefined, undefined, 'Validation failed');
          await finishTrace(requestId);
          
          return reply.code(400).send({
            error: 'Validation failed',
            details: validationResult.error.errors,
            traceId: requestId,
          });
        }

        const { 
          imageEmbedding, 
          searchKeywords,
          contextSearchText, 
          parsedSearchText, 
          minPrice, 
          maxPrice, 
          neededCount,
          filters,
          topK,
          location
        } = validationResult.data;

        // Validate that we have either imageEmbedding or searchKeywords
        if (!imageEmbedding && !searchKeywords) {
          endSpan(requestId, rootSpan.id, undefined, undefined, 'Validation failed: imageEmbedding or searchKeywords required');
          await finishTrace(requestId);
          
          return reply.code(400).send({
            error: 'Validation failed',
            details: 'Either imageEmbedding or searchKeywords must be provided',
            traceId: requestId,
          });
        }

        // Perform SerpAPI search - return top 10 results directly without storing
        const serpApiResults = await withSpan(requestId, 'serpapi_shopping_search', async (spanId) => {
          // If we have keywords but no image embedding, use keywords directly
          if (searchKeywords && !imageEmbedding) {
            // Use searchGoogleShopping for keyword-based search
            const { searchGoogleShopping } = await import('../services/serpapi-shopping');
            const shoppingResults = await searchGoogleShopping(
              searchKeywords,
              minPrice,
              maxPrice,
              10, // Request top 10 results
              undefined, // site filter
              location
            );
            
            // Extract brand from title (typically first word)
            const extractBrand = (title: string): string | undefined => {
              const words = title.split(' ');
              if (words.length > 1) {
                // Return first word as brand if it looks like a brand (capitalized, short)
                const firstWord = words[0];
                if (firstWord.length > 1 && firstWord.length < 20 && /^[A-Z]/.test(firstWord)) {
                  return firstWord;
                }
              }
              return undefined;
            };

            // Detect currency from price string
            const detectCurrency = (priceString: string): string => {
              if (priceString.includes('£')) return 'GBP';
              if (priceString.includes('€')) return 'EUR';
              if (priceString.toUpperCase().includes('HK$')) return 'HKD';
              if (priceString.toUpperCase().includes('NZ$')) return 'NZD';
              if (priceString.toUpperCase().includes('AU$')) return 'AUD';
              if (priceString.toUpperCase().includes('CA$')) return 'CAD';
              if (priceString.toUpperCase().includes('SG$')) return 'SGD';
              if (priceString.toUpperCase().includes('S$')) return 'SGD';
              if (priceString.toUpperCase().includes('US$')) return 'USD';
              if (priceString.toUpperCase().includes('KR')) return 'SEK';
              if (priceString.toUpperCase().includes('KČ')) return 'CZK';
              if (priceString.includes('$')) return 'USD';
              if (priceString.includes('¥')) return 'JPY';
              if (priceString.includes('₽')) return 'RUB';
              if (priceString.includes('₺')) return 'TRY';
              if (priceString.includes('₹')) return 'INR';
              if (priceString.includes('₪')) return 'ILS';
              if (priceString.includes('฿')) return 'THB';
              if (priceString.includes('₫')) return 'VND';
              if (priceString.includes('₱')) return 'PHP';
              if (priceString.includes('₦')) return 'NGN';
              if (priceString.toUpperCase().includes('ZŁ')) return 'PLN';
              if (priceString.toUpperCase().includes('FT')) return 'HUF';
              if (priceString.includes('₩')) return 'KRW';
              if (priceString.includes('₽')) return 'RUB';
              if (priceString.includes('₺')) return 'TRY';
              if (priceString.includes('₹')) return 'INR';
              if (priceString.includes('₪')) return 'ILS';
              if (priceString.includes('฿')) return 'THB';
              if (priceString.toUpperCase().includes('ZŁ')) return 'PLN';
              if (priceString.toUpperCase().includes('FT')) return 'HUF';
              if (priceString.toUpperCase().includes('LEI')) return 'RON';
              if (priceString.toUpperCase().includes('₩')) return 'KRW';
              if (priceString.includes('₽')) return 'RUB';
              if (priceString.includes('₺')) return 'TRY';
              if (priceString.includes('₹')) return 'INR';
              if (priceString.includes('₪')) return 'ILS';
              return 'USD'; // Default
            };

            // Get condition from filters or default to 'new'
            const condition = filters?.attributes?.condition || 'new';

            // Convert to response format directly (no database storage)
            const results = shoppingResults.slice(0, 10).map((result) => {
              const currency = detectCurrency(result.price);
              const brand = extractBrand(result.title);
              
              // Extract domain from product_link safely
              let retailerDomain = '';
              try {
                if (result.product_link) {
                  retailerDomain = new URL(result.product_link).hostname.replace('www.', '');
                }
              } catch (e) {
                // If URL parsing fails, use source as domain
                retailerDomain = result.source || '';
              }
              
              return {
                product_id: result.product_id,
                title: result.title,
                brand: brand,
                image_url: result.thumbnail || result.serpapi_thumbnail || undefined,
                similarity_score: 0.5, // Default score for keyword-based search
                _source: 'serpapi' as const, // Mark as SerpAPI product
                best_offer: {
                  retailer: result.source || 'Unknown',
                  retailer_domain: retailerDomain,
                  price: result.extracted_price || 0,
                  currency: currency,
                  url: result.product_link,
                  in_stock: true, // Assume in stock for SerpAPI results
                  condition: condition,
                },
              };
            });

            return results;
          } else {
            // Use image-based search (existing flow) - still return top 10 without storing
            const imageSearchResults = await searchAndFilterByImageSimilarity(
              imageEmbedding!,
              contextSearchText,
              parsedSearchText || searchKeywords,
              minPrice,
              maxPrice,
              10, // Limit to 10 results
              0.1, // similarity threshold
              filters, // Pass filters to detect second-hand searches
              location // Pass location for country-specific results
            );

            // Extract brand and format results
            const extractBrand = (title: string): string | undefined => {
              const words = title.split(' ');
              if (words.length > 1) {
                const firstWord = words[0];
                if (firstWord.length > 1 && firstWord.length < 20 && /^[A-Z]/.test(firstWord)) {
                  return firstWord;
                }
              }
              return undefined;
            };

            const detectCurrency = (priceString: string): string => {
              if (priceString.includes('£')) return 'GBP';
              if (priceString.includes('€')) return 'EUR';
              if (priceString.includes('$')) return 'USD';
              return 'USD';
            };

            const condition = filters?.attributes?.condition || 'new';

            return imageSearchResults.products.slice(0, 10).map((product) => {
              const currency = detectCurrency(product.price);
              const brand = extractBrand(product.title);
              
              // Extract domain from product_link safely
              let retailerDomain = '';
              try {
                if (product.product_link) {
                  retailerDomain = new URL(product.product_link).hostname.replace('www.', '');
                }
              } catch (e) {
                // If URL parsing fails, use source as domain
                retailerDomain = product.source || '';
              }
              
              return {
                product_id: product.product_id,
                title: product.title,
                brand: brand,
                image_url: product.thumbnail || product.serpapi_thumbnail || undefined,
                similarity_score: product.similarity_score,
                _source: 'serpapi' as const, // Mark as SerpAPI product
                best_offer: {
                  retailer: product.source || 'Unknown',
                  retailer_domain: retailerDomain,
                  price: product.extracted_price || 0,
                  currency: currency,
                  url: product.product_link,
                  in_stock: true,
                  condition: condition,
                },
              };
            });
          }
        }, {
          neededCount,
          hasImageEmbedding: !!imageEmbedding,
          hasKeywords: !!searchKeywords,
          hasContext: !!contextSearchText,
          hasPriceFilters: !!(minPrice || maxPrice),
          isSecondHand: filters?.attributes?.condition === 'used',
          location: location || 'default'
        }, rootSpan.id);

        // Return results directly without database storage
        const enrichedResults = serpApiResults || [];

        const duration = Date.now() - startTime;
        
        requestLogger?.info({
          resultCount: enrichedResults.length,
          duration
        }, '✅ SerpAPI search completed (fast mode - no storage)');
        
        // End root span with final metrics
        endSpan(requestId, rootSpan.id, {
          resultsCount: enrichedResults.length,
        }, {
          totalDuration: duration
        });

        await finishTrace(requestId);

        const response: SerpSearchResponse = {
          results: enrichedResults,
          traceId: requestId,
        };

        return reply.code(200).send(response);

      } catch (error) {
        const duration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        // Record error in trace
        endSpan(requestId, rootSpan.id, undefined, {
          errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
          duration
        }, errorMessage);
        
        requestLogger.error({ 
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
          duration 
        }, 'SerpAPI search request failed');

        // Finish trace even on error
        await finishTrace(requestId);

        return reply.code(500).send({
          error: 'Internal server error',
          traceId: requestId,
        });
      }
    },
  });

  // Endpoint to resolve a SerpAPI product to a database product
  fastify.post<{ Body: any }>('/serp-resolve', {
    handler: async (
      request: FastifyRequest<{ Body: any }>, 
      reply: FastifyReply
    ) => {
      const requestId = generateRequestId();
      const requestLogger = createRequestLogger(requestId);
      const startTime = Date.now();

      try {
        // Validate request body
        const SerpResolveRequestSchema = z.object({
          product_link: z.string().url(),
          title: z.string().min(1),
          price: z.string(),
          extracted_price: z.number(),
          source: z.string().optional(),
          thumbnail: z.string().url().optional(),
        });

        const validationResult = SerpResolveRequestSchema.safeParse(request.body);
        if (!validationResult.success) {
          return reply.code(400).send({
            error: 'Validation failed',
            details: validationResult.error.errors,
            traceId: requestId,
          });
        }

        const { product_link, title, price, extracted_price, source, thumbnail } = validationResult.data;

        requestLogger.info({ product_link, title }, 'Resolving SerpAPI product to database');

        // Scrape product details from the product link
        const scrapedDetails = await scrapeProductDetails(product_link);
        
        // Extract retailer domain from product_link
        let retailerDomain = '';
        try {
          const urlObj = new URL(product_link);
          retailerDomain = urlObj.hostname.replace('www.', '');
        } catch (e) {
          // Fallback to source if URL parsing fails
          retailerDomain = source || 'unknown';
        }

        // Detect currency from price string
        let currency = 'USD';
        if (price.includes('£')) currency = 'GBP';
        else if (price.includes('€')) currency = 'EUR';
        else if (price.includes('$')) currency = 'USD';

        // Build extracted product data for resolve endpoint
        const extracted = {
          title: title,
          price: extracted_price,
          currency: currency,
          brand: null as string | null,
          description: scrapedDetails?.description || null,
          condition: 'new' as 'new' | 'used' | 'refurbished' | undefined,
          images: thumbnail ? [thumbnail] : (scrapedDetails?.imageUrl ? [scrapedDetails.imageUrl] : undefined),
          color: null as string | null,
          primaryMaterial: null as string | null,
          category: null as string | null,
          subCategory: null as string | null,
          gtin: null as string | null,
          mpn: null as string | null,
          sku: null as string | null,
          originalPrice: null as number | null,
        };

        // Normalize the extracted data
        const normalized = normalizeExtracted(extracted);
        
        // Ensure retailer_domain is properly formatted
        const domain = extractDomain(retailerDomain);

        // Resolve the product (creates or finds existing product in database)
        const result = await resolveProduct(domain, product_link, normalized);

        requestLogger.info({
          product_id: result.product_id,
          created: result.created,
          matched_via: result.matched_via
        }, 'SerpAPI product resolved to database product');

        return reply.code(200).send({
          product_id: result.product_id,
          created: result.created,
          matched_via: result.matched_via,
          traceId: requestId,
        });

      } catch (error) {
        const duration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        requestLogger.error({ 
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
          duration 
        }, 'SerpAPI resolve request failed');

        return reply.code(500).send({
          error: 'Internal server error',
          traceId: requestId,
        });
      }
    },
  });
}

