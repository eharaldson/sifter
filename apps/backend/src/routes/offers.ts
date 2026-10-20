import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { query } from '../db';
import { createRequestLogger, generateRequestId, logger } from '../log';
import { currencyService } from '../services/currencyService';

// Query parameters validation schema for /search/offers
const SearchOffersQuerySchema = z.object({
  product_id: z.coerce.number().int().positive(), // The specific product to get offers for
  country: z.string().length(2).optional(), // ISO 2-letter country code
  condition: z.enum(['new', 'used', 'refurbished']).optional(),
  max_price: z.coerce.number().positive().optional(),
  min_price: z.coerce.number().positive().optional(),
  currency: z.string().length(3).optional(), // ISO 3-letter currency code
  base_currency: z.string().length(3).optional(), // Currency to convert all prices to
  in_stock_only: z.coerce.boolean().default(true),
  current_url: z.string().url().optional(), // URL to exclude from results
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

type SearchOffersQuery = z.infer<typeof SearchOffersQuerySchema>;

export interface ProductOffer {
  product_id: number;
  title: string;
  brand?: string;
  image_url?: string;
  category?: string;
  offers: OfferDetails[];
}

export interface OfferDetails {
  retailer: string;
  retailer_domain: string;
  title?: string; // Retailer-specific title
  image_url?: string; // Retailer-specific image
  price: number;
  currency: string;
  original_price?: number;
  converted_price?: number; // Price converted to base currency
  converted_original_price?: number; // Original price converted to base currency
  base_currency?: string; // The currency that prices were converted to
  conversion_rate?: number; // Exchange rate used for conversion
  url: string;
  affiliate_url?: string;
  in_stock: boolean;
  condition: string;
  last_seen_at: string;
  shipping_cost?: number;
  shipping_badges?: string[];
}

export async function offersRoutes(fastify: FastifyInstance) {
  fastify.get<{ 
    Querystring: SearchOffersQuery;
  }>('/search/offers', {
    handler: async (
      request: FastifyRequest<{ Querystring: any }>, 
      reply: FastifyReply
    ) => {
      const requestId = generateRequestId();
      const requestLogger = createRequestLogger(requestId);
      const startTime = Date.now();

      try {
        // Validate query parameters
        const queryResult = SearchOffersQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
          requestLogger.error({
            validationErrors: queryResult.error.errors,
            receivedQuery: request.query,
            requestId
          }, 'Query parameter validation failed');
          
          return reply.code(400).send({
            error: 'Invalid query parameters',
            details: queryResult.error.errors,
            request_id: requestId,
          });
        }

        const { product_id: productId, ...filters } = queryResult.data;

        // First, verify the product exists and get its details
        const productCheck = await query(
          'SELECT id, title, brand, image_url, category FROM products WHERE id = $1',
          [productId]
        );

        if (productCheck.rows.length === 0) {
          requestLogger.error({ productId }, 'Product not found in database');
          return reply.code(404).send({
            error: 'Product not found',
            request_id: requestId,
          });
        }

        const product = productCheck.rows[0];

        // Get all offers for this specific product
        const productOffer = await getProductOffers(
          product,
          filters, 
          filters.current_url,
          requestLogger,
          filters.base_currency
        );

        const duration = Date.now() - startTime;

        return reply.code(200).send(productOffer);

      } catch (error) {
        const duration = Date.now() - startTime;
        requestLogger.error({ 
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          duration 
        }, 'Product offers request failed');

        return reply.code(500).send({
          error: 'Internal server error',
          request_id: requestId,
        });
      }
    },
  });
}

/**
 * Get all offers for a specific product
 */
async function getProductOffers(
  product: any,
  filters: any,
  currentUrl?: string,
  requestLogger?: any,
  baseCurrency?: string
): Promise<ProductOffer | null> {
  requestLogger?.info({ 
    productId: product.id,
    title: product.title,
    filters
  }, 'Getting offers for specific product');

  // Build query to get all offers for this product
  let offerQuery = `
    SELECT 
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
      o.last_seen_at,
      o.shipping_cost,
      o.shipping_badges,
      o.country,
      r.name as retailer_name,
      r.domain as retailer_domain
    FROM offers o
    JOIN retailers r ON o.retailer_id = r.id
    WHERE o.product_id = $1
  `;

  const offerParams: any[] = [product.id];
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

  // Exclude current URL if provided
  if (currentUrl) {
    offerQuery += ` AND o.url != $${paramIndex}`;
    offerParams.push(currentUrl);
    paramIndex++;
  }

  offerQuery += ` ORDER BY o.price ASC, o.last_seen_at DESC LIMIT $${paramIndex}`;
  offerParams.push(filters.limit);

  requestLogger?.info({ 
    offerQuery: offerQuery.replace(/\s+/g, ' ').trim(),
    offerParams 
  }, 'Executing offers query');

  const offerResult = await query(offerQuery, offerParams);

  requestLogger?.info({ 
    rawOfferCount: offerResult.rows.length,
    sampleOffers: offerResult.rows.slice(0, 3).map((o: any) => ({
      retailer: o.retailer_name,
      price: o.price,
      currency: o.currency,
      in_stock: o.in_stock
    }))
  }, 'Offers query completed');

  // If no offers found, return null
  if (offerResult.rows.length === 0) {
    requestLogger?.info({ productId: product.id }, 'No offers found for product');
    return null;
  }

  // Process offers and apply currency conversion if needed
  const offers: OfferDetails[] = [];
  
  for (const offer of offerResult.rows) {
    const price = parseFloat(offer.price);
    const originalPrice = offer.original_price ? parseFloat(offer.original_price) : undefined;
    const currency = offer.currency;
    
    // Prepare offer details object
    const offerDetails: OfferDetails = {
      retailer: offer.retailer_name,
      retailer_domain: offer.retailer_domain,
      title: offer.title || undefined, // Retailer-specific title
      image_url: offer.image_url || undefined, // Retailer-specific image
      price,
      currency,
      original_price: originalPrice,
      url: offer.url,
      affiliate_url: offer.affiliate_url || undefined,
      in_stock: offer.in_stock,
      condition: offer.condition,
      last_seen_at: offer.last_seen_at.toISOString(),
      shipping_cost: offer.shipping_cost ? parseFloat(offer.shipping_cost) : undefined,
      shipping_badges: offer.shipping_badges || undefined,
    };
    
    // Add currency conversion if base currency is specified and different from offer currency
    if (baseCurrency && baseCurrency !== currency) {
      try {
        const priceConversion = await currencyService.convertPrice(price, currency, baseCurrency);
        offerDetails.converted_price = priceConversion.convertedAmount;
        offerDetails.base_currency = baseCurrency;
        offerDetails.conversion_rate = priceConversion.rate;
        
        // Convert original price if it exists
        if (originalPrice) {
          const originalPriceConversion = await currencyService.convertPrice(originalPrice, currency, baseCurrency);
          offerDetails.converted_original_price = originalPriceConversion.convertedAmount;
        }
        
        requestLogger?.debug({
          originalPrice: price,
          originalCurrency: currency,
          convertedPrice: offerDetails.converted_price,
          baseCurrency,
          rate: offerDetails.conversion_rate,
          retailer: offer.retailer_name
        }, 'Currency conversion applied to offer');
      } catch (error) {
        requestLogger?.warn({
          error: error instanceof Error ? error.message : 'Unknown error',
          retailer: offer.retailer_name,
          fromCurrency: currency,
          toCurrency: baseCurrency
        }, 'Currency conversion failed for offer');
      }
    }
    
    offers.push(offerDetails);
  }

  return {
    product_id: product.id,
    title: product.title,
    brand: product.brand || undefined,
    image_url: product.image_url || undefined,
    category: product.category || undefined,
    offers: offers,
  };
}

