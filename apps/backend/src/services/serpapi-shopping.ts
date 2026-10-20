import OpenAI from 'openai';
import * as cheerio from 'cheerio';
import { logger } from '../log';
import { query } from '../db';
import { NormalizedProduct } from '../match/normalize';
import { generateSemanticTextEmbedding, ProductData, validateTextEmbeddingDimension, validateSigLipEmbeddingDimension } from '../embeddings';
import { generateSearchText, LLMProductExtraction } from '../embed/search-text';
import { generateCleanTitle } from '../embed/title-clean';
import { generateClipCaption } from '../embed/text-caption';
import { currencyService } from './currencyService';

// Lazy-initialize OpenAI client
let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

const SIGLIP_SERVICE_URL = process.env.SIGLIP_SERVICE_URL || 'http://127.0.0.1:8002';

export interface SerpApiShoppingResult {
  position: number;
  title: string;
  product_id: string;
  product_link: string;
  source: string;
  price: string;
  extracted_price: number;
  rating?: number;
  reviews?: number;
  thumbnail: string;
  serpapi_thumbnail?: string;
}

export interface SerpApiShoppingResponse {
  shopping_results?: SerpApiShoppingResult[];
}

export interface ScrapedProductDetails {
  imageUrl: string;
  description: string;
  buyLinks: Array<{
    url: string;
    price: string;
  }>;
}

export interface SerpApiProductWithDetails extends SerpApiShoppingResult {
  similarity_score: number;
  scrapedDetails?: ScrapedProductDetails;
}

/**
 * Generate search keywords using GPT-4o-mini from context product search_text and parsed searchText
 */
async function generateSearchKeywords(
  contextSearchText?: string,
  parsedSearchText?: string
): Promise<string> {
  try {
    const prompt = `You are a search query optimizer. Generate a concise, effective search query (5-10 words max) for Google Shopping based on the following information:

${contextSearchText ? `Context product description: ${contextSearchText}` : ''}
${parsedSearchText ? `User search query: ${parsedSearchText}` : ''}

Return ONLY the search keywords, no explanation or additional text. Focus on the most important product attributes like brand, product type, color, and key features.`;

    const response = await getOpenAIClient().chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a search query optimizer. Return only the search keywords, nothing else.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 50,
      temperature: 0.3
    });

    const keywords = response.choices[0]?.message?.content?.trim() || '';
    
    // Fallback to parsed searchText if GPT fails
    if (!keywords && parsedSearchText) {
      return parsedSearchText;
    }
    
    if (!keywords && contextSearchText) {
      // Extract first 10 words from context search text
      return contextSearchText.split(/\s+/).slice(0, 10).join(' ');
    }

    return keywords || 'product';
  } catch (error) {
    logger.error({ error }, 'Failed to generate search keywords with GPT');
    // Fallback
    return parsedSearchText || contextSearchText?.split(/\s+/).slice(0, 10).join(' ') || 'product';
  }
}

/**
 * Search Google Shopping using SerpAPI with optional site filter
 */
export async function searchGoogleShopping(
  query: string,
  minPrice?: number,
  maxPrice?: number,
  num: number = 50,
  site?: string,
  location?: string
): Promise<SerpApiShoppingResult[]> {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    throw new Error('SERPAPI_API_KEY environment variable is required');
  }

  const params = new URLSearchParams({
    engine: 'google_shopping',
    q: query,
    num: num.toString(),
    api_key: apiKey
  });

  if (minPrice !== undefined) {
    params.append('min_price', minPrice.toString());
  }
  if (maxPrice !== undefined) {
    params.append('max_price', maxPrice.toString());
  }

  // Add location (country code) if specified (e.g., "us", "gb", "ca")
  if (location) {
    params.append('gl', location); // Google Shopping uses 'gl' parameter for country
  }

  // Add site filter if specified (e.g., "site:depop.com")
  if (site) {
    params.set('q', `${query} site:${site}`);
  }

  const url = `https://serpapi.com/search.json?${params.toString()}`;

  try {
    logger.info({ query, minPrice, maxPrice, num, site, location }, 'Searching Google Shopping via SerpAPI');
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SerpAPI error: ${response.status} ${response.statusText}: ${errorText}`);
    }

    const data = await response.json() as SerpApiShoppingResponse;
    const results = data.shopping_results || [];

    logger.info({ resultCount: results.length, site }, 'SerpAPI search completed');
    return results;
  } catch (error) {
    const errorDetails = {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : 'Unknown',
      stack: error instanceof Error ? error.stack : undefined,
      query,
      site,
      url: `https://serpapi.com/search.json?${params.toString().replace(/api_key=[^&]+/, 'api_key=***')}`, // Hide API key in logs
      hasApiKey: !!apiKey,
      status: error instanceof Error && 'status' in error ? (error as any).status : undefined,
      response: error instanceof Error && 'response' in error ? String((error as any).response) : undefined
    };
    logger.error(errorDetails, 'SerpAPI search failed');
    throw error;
  }
}

/**
 * Scrape product details from Google Shopping product page
 */
export async function scrapeProductDetails(productLink: string): Promise<ScrapedProductDetails | null> {
  try {
    logger.info({ productLink }, 'Scraping product details from Google Shopping page');

    const response = await fetch(productLink, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract description from element with id="description_full_container"
    const descriptionElement = $('#description_full_container');
    const description = descriptionElement.text().trim() || '';

    // Extract buy links from element with role="list"
    const buyLinks: Array<{ url: string; price: string }> = [];
    
    // Find all elements with role="list"
    $('[role="list"]').each((_, listEl) => {
      // Find all anchor tags within this list
      $(listEl).find('a[href]').each((_, anchorEl) => {
        const href = $(anchorEl).attr('href');
        if (!href) return;

        // Look for price element with aria-label="Current price: ..." in the same container
        // Check the anchor element itself and its parent/siblings
        let price = '';
        
        // First, check if the anchor or its parent has the aria-label
        const priceElement = $(anchorEl).closest('[aria-label*="Current price"]').first();
        if (priceElement.length === 0) {
          // Try finding a sibling or child element with the aria-label
          const siblingPrice = $(anchorEl).siblings('[aria-label*="Current price"]').first();
          if (siblingPrice.length > 0) {
            const ariaLabel = siblingPrice.attr('aria-label') || '';
            const priceMatch = ariaLabel.match(/Current price:\s*([£$€]\s*\d+[\d.,]*)/i);
            if (priceMatch) {
              price = priceMatch[1].trim();
            }
          }
        } else {
          const ariaLabel = priceElement.attr('aria-label') || '';
          const priceMatch = ariaLabel.match(/Current price:\s*([£$€]\s*\d+[\d.,]*)/i);
          if (priceMatch) {
            price = priceMatch[1].trim();
          }
        }

        // If still no price, try to find it in nearby text
        if (!price) {
          const container = $(anchorEl).closest('div, li, span').first();
          const containerText = container.text();
          const textPriceMatch = containerText.match(/[£$€]\s*\d+[\d.,]*/);
          if (textPriceMatch) {
            price = textPriceMatch[0].trim();
          }
        }

        if (href && (href.startsWith('http') || href.startsWith('/'))) {
          const fullUrl = href.startsWith('http') ? href : `https://www.google.com${href}`;
          
          // Avoid duplicates
          if (!buyLinks.some(link => link.url === fullUrl)) {
            buyLinks.push({
              url: fullUrl,
              price: price || 'Price not available'
            });
          }
        }
      });
    });

    return {
      imageUrl: '', // Will be set from thumbnail
      description,
      buyLinks
    };
  } catch (error) {
    logger.error({ error, productLink }, 'Failed to scrape product details');
    return null;
  }
}

/**
 * Calculate cosine similarity between two embeddings
 */
function cosineSimilarity(embedding1: number[], embedding2: number[]): number {
  if (embedding1.length !== embedding2.length) {
    throw new Error(`Embedding dimensions don't match: ${embedding1.length} vs ${embedding2.length}`);
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < embedding1.length; i++) {
    dotProduct += embedding1[i] * embedding2[i];
    norm1 += embedding1[i] * embedding1[i];
    norm2 += embedding2[i] * embedding2[i];
  }

  const magnitude = Math.sqrt(norm1) * Math.sqrt(norm2);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

export interface SerpApiSearchResult {
  products: SerpApiProductWithDetails[];
  imageEmbeddings: Map<string, number[]>;
}

/**
 * Search Google Shopping and filter by image similarity
 * Supports second-hand marketplace searches (Depop, Vinted, Vestiaire) when condition is 'used'
 */
export async function searchAndFilterByImageSimilarity(
  searchImageEmbedding: number[],
  contextSearchText?: string,
  parsedSearchText?: string,
  minPrice?: number,
  maxPrice?: number,
  requiredCount: number = 12,
  similarityThreshold: number = 0.1,
  filters?: { attributes?: { condition?: string | null } },
  location?: string
): Promise<SerpApiSearchResult> {
  const countryCode = location; // Use location parameter
  try {
    // Check if we're looking for second-hand/used items
    const isSecondHand = filters?.attributes?.condition === 'used';
    const secondHandMarketplaces = ['depop.com', 'vinted.com', 'vestiairecollective.com'];
    
    // Generate search keywords
    const searchQuery = await generateSearchKeywords(contextSearchText, parsedSearchText);
    logger.info({ searchQuery, contextSearchText, parsedSearchText, isSecondHand }, 'Generated search keywords');

    // Collect all shopping results
    let allShoppingResults: SerpApiShoppingResult[] = [];

    // If second-hand, also search specific marketplaces
    if (isSecondHand) {
      logger.info({ marketplaces: secondHandMarketplaces }, 'Performing second-hand marketplace searches');
      
      const marketplaceSearches = await Promise.allSettled(
        secondHandMarketplaces.map(site => 
          searchGoogleShopping(searchQuery, minPrice, maxPrice, 20, site, countryCode)
        )
      );

      marketplaceSearches.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          allShoppingResults.push(...result.value);
          logger.info({ 
            site: secondHandMarketplaces[index], 
            resultCount: result.value.length 
          }, 'Marketplace search completed');
        } else {
          logger.warn({ 
            site: secondHandMarketplaces[index], 
            error: result.reason 
          }, 'Marketplace search failed');
        }
      });
    }
    else {
      // Regular Google Shopping search
      try {
        const regularResults = await searchGoogleShopping(searchQuery, minPrice, maxPrice, 50, undefined, countryCode);
        allShoppingResults.push(...regularResults);
        logger.info({ resultCount: regularResults.length, location: countryCode }, 'Regular Google Shopping search completed');
      } catch (error) {
        const errorDetails = {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : 'Unknown',
          stack: error instanceof Error ? error.stack : undefined,
          searchQuery,
          minPrice,
          maxPrice,
          hasApiKey: !!process.env.SERPAPI_API_KEY,
          apiKeyPrefix: process.env.SERPAPI_API_KEY ? process.env.SERPAPI_API_KEY.substring(0, 7) + '...' : 'none'
        };
        logger.warn(errorDetails, 'Regular Google Shopping search failed, continuing');
      }
    }

    if (allShoppingResults.length === 0) {
      logger.warn({ 
        searchQuery,
        contextSearchText,
        parsedSearchText,
        minPrice,
        maxPrice,
        isSecondHand,
        hasApiKey: !!process.env.SERPAPI_API_KEY,
        requiredCount,
        similarityThreshold
      }, 'No results from SerpAPI - check search query and API key');
      return {
        products: [],
        imageEmbeddings: new Map<string, number[]>()
      };
    }

    // Remove duplicates by product_id
    const uniqueResults = new Map<string, SerpApiShoppingResult>();
    allShoppingResults.forEach(result => {
      if (!uniqueResults.has(result.product_id)) {
        uniqueResults.set(result.product_id, result);
      }
    });
    const deduplicatedResults = Array.from(uniqueResults.values());

    logger.info({ 
      totalResults: allShoppingResults.length,
      uniqueResults: deduplicatedResults.length,
      isSecondHand,
      marketplaceSearches: isSecondHand ? secondHandMarketplaces.length : 0
    }, 'All SerpAPI searches completed');

    // Get image embeddings for all thumbnails
    const thumbnailUrls = deduplicatedResults.map(result => result.thumbnail || result.serpapi_thumbnail).filter(Boolean) as string[];
    
    logger.info({ 
      thumbnailCount: thumbnailUrls.length,
      totalProducts: deduplicatedResults.length,
      siglipServiceUrl: SIGLIP_SERVICE_URL
    }, 'Getting SigLIP embeddings for thumbnails');

    // Get embeddings in batches (max 32 per batch for SigLIP service)
    const batchSize = 32;
    const allEmbeddings: Array<number[] | null> = [];
    let embeddingSuccessCount = 0;
    let embeddingFailureCount = 0;
    const embeddingErrors: Array<{ url: string; error: string; status?: number }> = [];
    
    for (let i = 0; i < thumbnailUrls.length; i += batchSize) {
      const batch = thumbnailUrls.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(thumbnailUrls.length / batchSize);
      
      logger.info({ 
        batchNumber,
        totalBatches,
        batchSize: batch.length,
        startIndex: i,
        endIndex: Math.min(i + batchSize, thumbnailUrls.length)
      }, `Processing embedding batch ${batchNumber}/${totalBatches}`);
      
      const batchEmbeddings = await Promise.all(
        batch.map(async (url, indexInBatch) => {
          try {
            logger.debug({ 
              url: url.substring(0, 100) + '...',
              batchNumber,
              indexInBatch: indexInBatch + 1,
              totalInBatch: batch.length
            }, 'Requesting embedding for thumbnail');
            
            // Call image-service to get embedding
            const response = await fetch(`${SIGLIP_SERVICE_URL}/embed-image-url`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ url, timeout: 15 })
            });

            if (!response.ok) {
              const errorText = await response.text().catch(() => 'Unable to read error response');
              const errorDetails = {
                url: url.substring(0, 100) + '...',
                status: response.status,
                statusText: response.statusText,
                errorText: errorText.substring(0, 200)
              };
              logger.warn(errorDetails, 'Failed to get embedding for thumbnail (HTTP error)');
              embeddingErrors.push({ url, error: `HTTP ${response.status}: ${response.statusText}`, status: response.status });
              embeddingFailureCount++;
              return null;
            }

            const result = await response.json() as { embedding: number[] };
            if (!result.embedding || !Array.isArray(result.embedding)) {
              logger.warn({ url: url.substring(0, 100) + '...' }, 'Invalid embedding response format');
              embeddingErrors.push({ url, error: 'Invalid embedding response format' });
              embeddingFailureCount++;
              return null;
            }
            
            embeddingSuccessCount++;
            logger.debug({ 
              embeddingLength: result.embedding.length,
              url: url.substring(0, 100) + '...'
            }, 'Successfully got embedding for thumbnail');
            return result.embedding;
          } catch (error) {
            const errorDetails = {
              url: url.substring(0, 100) + '...',
              message: error instanceof Error ? error.message : String(error),
              name: error instanceof Error ? error.name : 'Unknown',
              stack: error instanceof Error ? error.stack?.substring(0, 300) : undefined,
              type: error instanceof TypeError ? 'TypeError' : error instanceof Error ? error.constructor.name : typeof error
            };
            logger.warn(errorDetails, 'Error getting embedding for thumbnail (exception)');
            embeddingErrors.push({ 
              url, 
              error: error instanceof Error ? error.message : String(error) 
            });
            embeddingFailureCount++;
            return null;
          }
        })
      );
      
      allEmbeddings.push(...batchEmbeddings);
      
      logger.info({
        batchNumber,
        totalBatches,
        batchSuccessCount: batchEmbeddings.filter(e => e !== null).length,
        batchFailureCount: batchEmbeddings.filter(e => e === null).length,
        cumulativeSuccessCount: embeddingSuccessCount,
        cumulativeFailureCount: embeddingFailureCount
      }, `Completed embedding batch ${batchNumber}/${totalBatches}`);
    }
    
    logger.info({
      totalThumbnails: thumbnailUrls.length,
      successfulEmbeddings: embeddingSuccessCount,
      failedEmbeddings: embeddingFailureCount,
      successRate: thumbnailUrls.length > 0 ? ((embeddingSuccessCount / thumbnailUrls.length) * 100).toFixed(2) + '%' : '0%',
      errorCount: embeddingErrors.length,
      sampleErrors: embeddingErrors.slice(0, 5) // Log first 5 errors as samples
    }, 'Completed all embedding requests');

    // Calculate similarities and filter
    const productsWithSimilarity: SerpApiProductWithDetails[] = [];
    const imageEmbeddingsMap = new Map<string, number[]>(); // Store embeddings for later use
    let skippedNoEmbedding = 0;
    let skippedLowSimilarity = 0;
    const similarityScores: number[] = [];

    logger.info({
      totalProducts: deduplicatedResults.length,
      totalEmbeddings: allEmbeddings.length,
      embeddingsWithValue: allEmbeddings.filter(e => e !== null).length,
      similarityThreshold
    }, 'Starting similarity calculation and filtering');

    for (let i = 0; i < deduplicatedResults.length; i++) {
      const result = deduplicatedResults[i];
      const embedding = allEmbeddings[i];

      if (!embedding) {
        skippedNoEmbedding++;
        continue; // Skip if embedding failed
      }

      // Store embedding for this product
      imageEmbeddingsMap.set(result.product_id, embedding);

      const similarity = cosineSimilarity(searchImageEmbedding, embedding);
      similarityScores.push(similarity);

      if (similarity >= similarityThreshold) {
        productsWithSimilarity.push({
          ...result,
          similarity_score: similarity
        });
      } else {
        skippedLowSimilarity++;
      }
    }

    logger.info({
      totalProducts: deduplicatedResults.length,
      skippedNoEmbedding,
      skippedLowSimilarity,
      passedSimilarityFilter: productsWithSimilarity.length,
      similarityThreshold,
      minSimilarity: similarityScores.length > 0 ? Math.min(...similarityScores).toFixed(4) : 'N/A',
      maxSimilarity: similarityScores.length > 0 ? Math.max(...similarityScores).toFixed(4) : 'N/A',
      avgSimilarity: similarityScores.length > 0 ? (similarityScores.reduce((a, b) => a + b, 0) / similarityScores.length).toFixed(4) : 'N/A'
    }, 'Similarity filtering completed');

    // Sort by similarity (highest first)
    productsWithSimilarity.sort((a, b) => b.similarity_score - a.similarity_score);

    // Limit to required count
    const limitedResults = productsWithSimilarity.slice(0, requiredCount);
    
    logger.info({
      beforeLimit: productsWithSimilarity.length,
      afterLimit: limitedResults.length,
      requiredCount
    }, 'Limited results to required count');

    // Scrape product details for each result
    logger.info({ count: limitedResults.length }, 'Scraping product details');
    const resultsWithDetails = await Promise.all(
      limitedResults.map(async (product) => {
        try {
          const details = await scrapeProductDetails(product.product_link);
          if (details) {
            // Set imageUrl from thumbnail
            details.imageUrl = product.thumbnail || product.serpapi_thumbnail || '';
          }
          return {
            ...product,
            scrapedDetails: details || undefined
          };
        } catch (error) {
          logger.warn({ productLink: product.product_link, error }, 'Failed to scrape product details');
          return product;
        }
      })
    );

    logger.info({ 
      totalResults: deduplicatedResults.length,
      filteredCount: productsWithSimilarity.length,
      finalCount: resultsWithDetails.length,
      isSecondHand,
      marketplaceCount: isSecondHand ? secondHandMarketplaces.length : 0
    }, 'SerpAPI search and filtering completed');

    // Filter embeddings map to only include products that passed similarity threshold
    const filteredEmbeddingsMap = new Map<string, number[]>();
    resultsWithDetails.forEach(product => {
      const embedding = imageEmbeddingsMap.get(product.product_id);
      if (embedding) {
        filteredEmbeddingsMap.set(product.product_id, embedding);
      }
    });

    return {
      products: resultsWithDetails,
      imageEmbeddings: filteredEmbeddingsMap
    };
  } catch (error) {
    logger.error({ error }, 'Failed to search and filter by image similarity');
    throw error;
  }
}

/**
 * Convert SerpAPI product to NormalizedProduct format
 */
function convertSerpApiToNormalizedProduct(
  serpProduct: SerpApiProductWithDetails,
  imageEmbedding: number[]
): NormalizedProduct {
  // Extract price from string (e.g., "£139.00" -> 139.00)
  const priceMatch = serpProduct.price?.match(/[£$€]?\s*([\d,]+\.?\d*)/);
  const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : serpProduct.extracted_price || 0;
  
  // Detect currency from price string
  let currency = 'USD';
  if (serpProduct.price?.includes('£')) currency = 'GBP';
  else if (serpProduct.price?.includes('€')) currency = 'EUR';
  else if (serpProduct.price?.includes('$')) currency = 'USD';

  // Extract brand from title if possible (first word often)
  const titleWords = serpProduct.title.split(' ');
  const brand = titleWords.length > 1 ? titleWords[0] : null;

  return {
    title: serpProduct.title,
    brand: brand,
    description: serpProduct.scrapedDetails?.description || null,
    search_text: null, // Will be generated
    price: price,
    currency: currency,
    originalPrice: null,
    condition: 'new', // Default to new, could be enhanced later
    imageUrl: serpProduct.scrapedDetails?.imageUrl || serpProduct.thumbnail || serpProduct.serpapi_thumbnail || null,
    color: null, // Could be extracted from title/description later
    primaryMaterial: null,
    category: null,
    subCategory: null,
    gender: null,
    gtin: null,
    mpn: null,
    sku: null,
  };
}

/**
 * Get or create retailer by domain
 */
async function getOrCreateRetailer(domain: string): Promise<number> {
  const result = await query(
    `INSERT INTO retailers (name, domain) VALUES ($1, $2) 
     ON CONFLICT (domain) DO UPDATE SET name = EXCLUDED.name 
     RETURNING id`,
    [domain, domain]
  );
  return result.rows[0].id;
}

/**
 * Create product from SerpAPI result
 */
async function createSerpApiProduct(
  normalized: NormalizedProduct,
  textEmbedding: number[],
  imageEmbedding: number[]
): Promise<number> {
  // Generate all text variants using LLM
  const clipCaption = generateClipCaption(normalized);
  const titleClean = generateCleanTitle(normalized);
  const llmExtraction = await generateSearchText(normalized);
  
  // Use LLM-generated description for search_text
  const searchText = llmExtraction.description;
  
  // Fill missing fields from LLM metadata
  const brand = normalized.brand || llmExtraction.metadata.brand || null;
  const category = normalized.category || llmExtraction.metadata.category || null;
  const subCategory = normalized.subCategory || llmExtraction.metadata.sub_category || null;
  const color = normalized.color || llmExtraction.metadata.color || null;
  
  // Store metadata in attributes column
  const attributes = JSON.stringify(llmExtraction.metadata);

  const result = await query(`
    INSERT INTO products (
      gtin, mpn, brand, title, description, title_clean, search_text, 
      color, primary_material, category, sub_category, image_url, embedding_text_semantic, embedding_image, attributes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING id
  `, [
    normalized.gtin,
    normalized.mpn,
    brand,
    normalized.title,
    normalized.description,
    titleClean,
    searchText,
    color,
    normalized.primaryMaterial,
    category,
    subCategory,
    normalized.imageUrl,
    JSON.stringify(textEmbedding),
    JSON.stringify(imageEmbedding),
    attributes
  ]);

  return result.rows[0].id;
}

/**
 * Create or update offer for SerpAPI product
 */
async function upsertSerpApiOffer(
  productId: number,
  retailerId: number,
  url: string,
  normalized: NormalizedProduct,
  buyLinkPrice?: string
): Promise<number> {
  const baseCurrency = process.env.DEFAULT_CURRENCY || 'USD';

  // Use buyLinkPrice if available, otherwise use normalized price
  let price = normalized.price;
  if (buyLinkPrice) {
    const priceMatch = buyLinkPrice.match(/[£$€]?\s*([\d,]+\.?\d*)/);
    if (priceMatch) {
      price = parseFloat(priceMatch[1].replace(/,/g, ''));
    }
  }

  let priceUsd = price;
  if (normalized.currency !== baseCurrency) {
    try {
      const priceConversion = await currencyService.convertPrice(price, normalized.currency, baseCurrency);
      priceUsd = priceConversion.convertedAmount;
    } catch (error) {
      logger.warn({ error, currency: normalized.currency }, 'Failed to convert currency, using original price');
      priceUsd = price;
    }
  }

  const result = await query(`
    INSERT INTO offers (
      product_id, retailer_id, title, url, sku, condition, currency, 
      price, price_usd, original_price, in_stock, image_url, last_seen_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
    ON CONFLICT (retailer_id, url) 
    DO UPDATE SET 
      price = EXCLUDED.price,
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
    price,
    priceUsd,
    normalized.originalPrice,
    true, // assume in stock
    normalized.imageUrl
  ]);

  return result.rows[0].id;
}

/**
 * Store SerpAPI search results in the database
 * Returns an object with product and offer IDs (for future use)
 */
export async function storeSerpApiResults(
  serpApiResults: SerpApiProductWithDetails[],
  imageEmbeddings: Map<string, number[]> // Map of product_id -> image embedding
): Promise<Array<{ productId: number; offerIds: number[] }>> {
  const storedResults: Array<{ productId: number; offerIds: number[] }> = [];

  for (const serpProduct of serpApiResults) {
    try {
      // Get the image embedding we already computed
      const imageEmbedding = imageEmbeddings.get(serpProduct.product_id);
      if (!imageEmbedding) {
        logger.warn({ productId: serpProduct.product_id }, 'No image embedding found for SerpAPI product, skipping');
        continue;
      }

      // Convert to normalized product
      const normalized = convertSerpApiToNormalizedProduct(serpProduct, imageEmbedding);

      // Generate text embedding
      const productData: ProductData = {
        id: 0,
        title: normalized.title,
        brand: normalized.brand || '',
        color: normalized.color || '',
        description: normalized.description || '',
        image_url: normalized.imageUrl || '',
      };

      const textEmbedding = await generateSemanticTextEmbedding(productData);
      if (!validateTextEmbeddingDimension(textEmbedding)) {
        logger.warn({ productId: serpProduct.product_id }, 'Invalid text embedding dimension, skipping');
        continue;
      }

      if (!validateSigLipEmbeddingDimension(imageEmbedding)) {
        logger.warn({ productId: serpProduct.product_id }, 'Invalid image embedding dimension, skipping');
        continue;
      }

      // Create product
      const productId = await createSerpApiProduct(normalized, textEmbedding, imageEmbedding);

      // Get or create retailer for the source
      const retailerDomain = serpProduct.source.toLowerCase().replace(/\s+/g, '');
      const retailerId = await getOrCreateRetailer(retailerDomain);

      // Create offer for the main product link
      const offerIds: number[] = [];
      const mainOfferId = await upsertSerpApiOffer(
        productId,
        retailerId,
        serpProduct.product_link,
        normalized,
        serpProduct.price
      );
      offerIds.push(mainOfferId);

      // Create offers for each buy link from scraped details
      if (serpProduct.scrapedDetails?.buyLinks) {
        for (const buyLink of serpProduct.scrapedDetails.buyLinks) {
          try {
            // Extract domain from URL
            const urlObj = new URL(buyLink.url);
            const buyLinkDomain = urlObj.hostname.replace('www.', '');
            const buyLinkRetailerId = await getOrCreateRetailer(buyLinkDomain);
            
            const buyLinkOfferId = await upsertSerpApiOffer(
              productId,
              buyLinkRetailerId,
              buyLink.url,
              normalized,
              buyLink.price
            );
            offerIds.push(buyLinkOfferId);
          } catch (error) {
            logger.warn({ url: buyLink.url, error }, 'Failed to create offer for buy link');
          }
        }
      }

      storedResults.push({ productId, offerIds });

      logger.info({
        productId,
        offerCount: offerIds.length,
        title: normalized.title.substring(0, 50)
      }, 'Stored SerpAPI product and offers');

    } catch (error) {
      logger.error({ 
        productId: serpProduct.product_id,
        error: error instanceof Error ? error.message : String(error)
      }, 'Failed to store SerpAPI product');
    }
  }

  return storedResults;
}

