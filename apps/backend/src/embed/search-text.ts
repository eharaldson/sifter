import { logger } from '../log';
import { NormalizedProduct } from '../match/normalize';
import OpenAI from 'openai';

/**
 * Regex-based fallback size extraction when LLM is unavailable
 */
function extractSizesWithRegex(text: string): string[] {
  const sizes: string[] = [];
  const textLower = text.toLowerCase();
  
  // Pattern 1: Alpha sizes (S, M, L, XL, etc.) - word boundaries to avoid partial matches
  const alphaPattern = /\b(xxs|xs|small|s|medium|m|large|l|xl|xxl|xxxl|extra\s*small|extra\s*large)\b/gi;
  const alphaMatches = text.match(alphaPattern);
  if (alphaMatches) {
    // Deduplicate and add
    alphaMatches.forEach(match => {
      const normalized = match.trim().toLowerCase();
      if (!sizes.some(s => s.toLowerCase() === normalized)) {
        sizes.push(match.trim());
      }
    });
  }
  
  // Pattern 2: "size X" patterns (e.g., "size 10", "size M", "size UK 9")
  const sizePattern = /size\s+([a-z0-9.]+)/gi;
  const sizeMatches = [...text.matchAll(sizePattern)];
  sizeMatches.forEach(match => {
    const size = match[1].trim();
    if (!sizes.includes(size)) {
      sizes.push(size);
    }
  });
  
  // Pattern 3: Region-prefixed shoe sizes (US 10, UK 9.5, EU 42)
  const regionSizePattern = /\b(us|uk|eu|jp)\s*(\d+(?:\.\d+)?)\b/gi;
  const regionMatches = [...text.matchAll(regionSizePattern)];
  regionMatches.forEach(match => {
    const fullSize = `${match[1].toUpperCase()} ${match[2]}`;
    if (!sizes.includes(fullSize)) {
      sizes.push(fullSize);
    }
  });
  
  // Pattern 4: Waist x Length (e.g., "32x34", "30x32")
  const waistLengthPattern = /\b(\d{2})\s*x\s*(\d{2})\b/gi;
  const waistMatches = [...text.matchAll(waistLengthPattern)];
  waistMatches.forEach(match => {
    const size = `${match[1]}x${match[2]}`;
    if (!sizes.includes(size)) {
      sizes.push(size);
    }
  });
  
  // Pattern 5: Standalone numeric sizes in clothing context (28-50 range for waist/numeric)
  // Only if we haven't found other sizes and text mentions clothing terms
  if (sizes.length === 0 && /\b(jeans?|pants?|trousers?|dress|skirt)\b/i.test(text)) {
    const numericPattern = /\b(2[8-9]|[3-4][0-9]|50)\b/g;
    const numericMatches = text.match(numericPattern);
    if (numericMatches && numericMatches.length <= 3) {
      // Only add if reasonable number (avoid adding random numbers)
      numericMatches.forEach(match => {
        if (!sizes.includes(match)) {
          sizes.push(match);
        }
      });
    }
  }
  
  return sizes.slice(0, 5); // Limit to 5 sizes max to avoid noise
}

// Lazy-initialize OpenAI client to ensure env vars are loaded
let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.error('OPENAI_API_KEY environment variable is missing');
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

export interface LLMProductExtraction {
  metadata: {
    brand?: string | null;
    product_type?: string | null;
    category?: string | null;
    sub_category?: string | null;
    color?: string | null;
    gender?: string | null;
    available_sizes?: string[] | null;
  };
  description: string;
}

// ============================================
// Rich Search Text Generation Pipeline
// ============================================

/**
 * Check if an error is a retryable OpenAI API error
 */
function isRetryableError(error: any): boolean {
  if (!error) return false;
  
  // Check for status code in error (handling different SDK error shapes)
  const status = error.status || error.response?.status || error.statusCode;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  
  // Check error message
  const errorMessage = (error.message || String(error)).toLowerCase();
  return (
    errorMessage.includes('429') || 
        errorMessage.includes('rate limit') || 
        errorMessage.includes('quota') ||
    errorMessage.includes('resource exhausted') ||
    errorMessage.includes('overloaded') ||
    errorMessage.includes('internal error') ||
    errorMessage.includes('server error')
  );
}

/**
 * Extract retry-after delay from error response
 */
function getRetryAfterDelay(error: any): number | null {
  if (!error) return null;
  
  // Check for retry-after header if available
  const headers = error.response?.headers || error.headers;
  if (headers && headers['retry-after']) {
    const retryAfter = parseInt(headers['retry-after']);
    if (!isNaN(retryAfter) && retryAfter > 0) {
      return retryAfter * 1000;
    }
  }
  
  return null;
}

/**
 * Calculate exponential backoff delay
 */
function calculateBackoffDelay(attempt: number, baseDelay: number = 1000, maxDelay: number = 60000): number {
  // Exponential backoff: baseDelay * 2^(attempt-1)
  const delay = baseDelay * Math.pow(2, attempt - 1);
  
  // Add jitter (random 0-25% of delay) to avoid thundering herd
  const jitter = delay * 0.25 * Math.random();
  const totalDelay = delay + jitter;
  
  // Cap at max delay
  return Math.min(totalDelay, maxDelay);
}

/**
 * Call OpenAI API with exponential backoff retry logic
 */
async function callOpenAIWithRetry(
  requestFn: () => Promise<any>,
  maxRetries: number = 5,
  baseDelay: number = 1000
): Promise<any> {
  let lastError: any = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await requestFn();
      return result;
    } catch (error: any) {
      lastError = error;
      
      const isRetryable = isRetryableError(error);
      const isLastAttempt = attempt === maxRetries;
      
      if (!isRetryable || isLastAttempt) {
        throw error;
      }
      
      const retryAfterDelay = getRetryAfterDelay(error);
      const delay = retryAfterDelay || calculateBackoffDelay(attempt, baseDelay);
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * Extract clean description using OpenAI API
 */
async function extractCleanDescription(messyText: string, productTitle?: string): Promise<string> {
  const systemPrompt = `You are an e-commerce product description cleaner. You will be given a messy product description and need to extract a clean, descriptive summary.

## RULES FOR DESCRIPTION:
- Used for visual vector embedding
- Clean, natural language description (under 25 words)
- Describe a single specific item, not a general category
- Include only descriptive fashion attributes: colour, type of item, material, aesthetic, style, fit, defining features
- EXCLUDE: opinions ("beautiful", "high-quality"), marketing statements, brand names, size information, use cases ("perfect for winter"), temporal info ("2017 collection"), seller text ("free shipping")

## EXAMPLES:
- Input: "Nike Air Max 90 men's running shoes - white/black colorway size 10 brand new"
  Output: "white and black sneakers with air cushioning"

- Input: "Vintage Levi's 501 jeans dark wash straight leg 32x34 great condition"
  Output: "dark wash straight leg jeans with vintage detailing"

- Input: "Carhartt WIP Detroit Jacket Hamilton Brown size L workwear style"
  Output: "brown workwear jacket with collar and multiple pockets"

- Input: "Adidas Ultraboost available in sizes M 9, M 9.5, M 10"
  Output: "boosted running shoes with responsive cushioning"

Return ONLY the clean description text, nothing else.`;

  try {
    const model = 'gpt-4.1-mini';

    const response = await callOpenAIWithRetry(async () => {
      const client = getOpenAIClient();

      const response = await client.responses.create({
        model: model,
        input: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `MESSY TEXT: "${messyText}"`
              },
            ],
          },
        ],
        max_output_tokens: 500
      });

      return response;
    });

    const content = response.output_text.trim();

    if (content && content.length > 0) {
      // Ensure description is under 25 words
      const words = content.split(/\s+/);
      if (words.length > 25) {
        return words.slice(0, 25).join(' ');
      }
      return content;
    }
  } catch (error) {
    logger.error('Error extracting clean description:', error);
  }

  return productTitle || 'product';
}

/**
 * Extract categorical metadata as JSON using OpenAI API
 */
async function extractProductMetadata(messyText: string): Promise<LLMProductExtraction['metadata']> {
  const systemPrompt = `You are an e-commerce product metadata extractor. You will be given a messy product description and need to extract categorical metadata as JSON.

**CRITICAL: You MUST return ONLY this exact JSON structure:**

{
  "brand": "string or null",
  "product_type": "string or null",
  "color": "string or null",
  "gender": "string or null",
  "category": "string or null",
  "sub_category": "string or null",
  "available_sizes": ["array of size strings"] or null
}

**DO NOT add any other fields. DO NOT wrap in additional objects.**

## EXAMPLES:

### Example 1:
Input: "Nike Air Max 90 men's running shoes - white/black colorway size 10 brand new"
Output:
{
  "brand": "Nike",
  "product_type": "sneakers",
  "color": "white",
  "gender": "male",
  "category": "shoes",
  "sub_category": "running shoes",
  "available_sizes": ["10"]
}

### Example 2:
Input: "Vintage Levi's 501 jeans dark wash straight leg 32x34 great condition"
Output:
{
  "brand": "Levi's",
  "product_type": "jeans",
  "color": "blue",
  "gender": null,
  "category": "bottoms",
  "sub_category": "denim",
  "available_sizes": ["32x34"]
}

### Example 3:
Input: "Carhartt WIP Detroit Jacket Hamilton Brown size L workwear style"
Output:
{
  "brand": "Carhartt",
  "product_type": "jacket",
  "color": "brown",
  "gender": null,
  "category": "outerwear",
  "sub_category": "jacket",
  "available_sizes": ["L"]
}

### Example 4:
Input: "Adidas Ultraboost available in sizes M 9, M 9.5, M 10"
Output:
{
  "brand": "Adidas",
  "product_type": "sneakers",
  "color": null,
  "gender": "male",
  "category": "shoes",
  "sub_category": "running shoes",
  "available_sizes": ["9", "9.5", "10"]
}

## RULES:
- Extract ONLY: brand, product_type, color, gender, category, sub_category, available_sizes
- Normalize values (e.g., "navy" -> "blue", "hooded sweatshirt" -> "hoodie", "trainers" -> "sneakers")
- If not found or ambiguous, set to null
- For available_sizes: Extract all size mentions as an array of strings (e.g., ["M", "L", "XL"] or ["10", "10.5", "11"])
  - Include region prefixes if present (e.g., ["UK 9", "UK 9.5"])
  - For ranges, extract individual sizes (e.g., "sizes 8-11" -> ["8", "9", "10", "11"])
  - If no size info, set to null
- DO NOT extract: material, condition, price, seller info
- Return ONLY valid JSON matching the exact structure above`;

  try {
    const model = 'gpt-4.1-mini';

    const response = await callOpenAIWithRetry(async () => {
      const client = getOpenAIClient();

      const response = await client.responses.create({
        model: model,
        input: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `MESSY TEXT: "${messyText}"`
              },
            ],
          },
        ],
        max_output_tokens: 800
      });

      return response;
    });

    const content = response.output_text.trim();

    if (content) {
      try {
        const parsed = JSON.parse(content);
        // Validate the structure and return only expected fields
        return {
          brand: parsed.brand || null,
          product_type: parsed.product_type || null,
          category: parsed.category || null,
          sub_category: parsed.sub_category || null,
          color: parsed.color || null,
          gender: parsed.gender || null,
          available_sizes: parsed.available_sizes || null,
        };
      } catch (parseError) {
        logger.error('Error parsing metadata JSON:', parseError);
      }
    }
  } catch (error) {
    logger.error('Error extracting product metadata:', error);
  }

  // Fallback: use regex to extract sizes
  const extractedSizes = extractSizesWithRegex(messyText);
  return {
    available_sizes: extractedSizes.length > 0 ? extractedSizes : null,
  };
}

/**
 * Generate clean description and metadata using OpenAI API
 */
export async function generateSearchText(product: NormalizedProduct): Promise<LLMProductExtraction> {
  const messyText = `${product.title || ''} ${product.description || ''}`.trim();

  if (!messyText) {
    return {
      metadata: {},
      description: 'product'
    };
  }

  try {
    // Make two separate LLM calls
    const [description, metadata] = await Promise.all([
      extractCleanDescription(messyText, product.title),
      extractProductMetadata(messyText)
    ]);

    return {
      metadata,
      description
    };
  } catch (error) {
    logger.error('Error in generateSearchText:', error);

    // Fallback to regex extraction for sizes
    const extractedSizes = extractSizesWithRegex(messyText);

    return {
      metadata: {
        available_sizes: extractedSizes.length > 0 ? extractedSizes : null,
      },
      description: product.title || 'product'
    };
  }
}