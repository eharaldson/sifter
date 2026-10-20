import { z } from 'zod';
import { createRequestLogger } from '../log';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
// Removed complex structured output parser - using simple JSON parsing instead
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';

// LangSmith configuration - Enable tracing
if (process.env.LANGCHAIN_API_KEY) {
  process.env.LANGCHAIN_TRACING_V2 = 'true';
  process.env.LANGCHAIN_PROJECT = process.env.LANGCHAIN_PROJECT || 'find-intent-parser';
  console.log('🔍 LangChain tracing enabled for project:', process.env.LANGCHAIN_PROJECT);
}

// ============================================
// Zod Schema for Structured Intent Parsing
// ============================================

const PriceRangeSchema = z.object({
  min: z.number().positive().optional(),
  max: z.number().positive().optional(),
  currency: z.enum(['USD', 'GBP', 'EUR', 'CAD', 'AUD']).optional(),
});

const FiltersSchema = z.object({
  brand: z.array(z.string()).nullable().optional(),
  category: z.string().nullable().optional(),
  subcategory: z.string().nullable().optional(),
  attributes: z.object({
    color: z.array(z.string()).nullable().optional(),
    material: z.array(z.string()).nullable().optional(),
    size: z.array(z.string()).nullable().optional(),
    condition: z.enum(['new', 'used', 'refurbished']).nullable().optional(),
  }).optional(),
  price: PriceRangeSchema.nullable().optional(),
});

export const ParsedIntentSchema = z.object({
  freeText: z.string().describe("The cleaned search query without filters"),
  filters: FiltersSchema.describe("Structured filters extracted from the query"),
  limit: z.number().int().min(1).max(100).default(8).describe("Number of results to return"),
  useContext: z.boolean().describe("Whether to use page context (true for contextual queries like 'similar', false for absolute queries)"),
  clipText: z.string().describe("Short caption (4-12 tokens) for vision-language model (SigLIP/CLIP)"),
  searchText: z.string().describe("Structured, field-tagged text for semantic text embedding"),
});

export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;

// ============================================
// Color Synonym Mapping
// ============================================

const COLOR_SYNONYMS: Record<string, string> = {
  // Green variations
  'olive': 'green',
  'forest': 'green',
  'emerald': 'green',
  'lime': 'green',
  'mint': 'green',
  'sage': 'green',
  'khaki': 'green',
  
  // Blue variations
  'navy': 'blue',
  'royal': 'blue',
  'sky': 'blue',
  'teal': 'blue',
  'cyan': 'blue',
  'turquoise': 'blue',
  'cobalt': 'blue',
  
  // Red variations
  'crimson': 'red',
  'scarlet': 'red',
  'maroon': 'red',
  'burgundy': 'red',
  'cherry': 'red',
  'rose': 'red',
  'pink': 'red',
  
  // Brown variations
  'tan': 'brown',
  'beige': 'brown',
  'chocolate': 'brown',
  'coffee': 'brown',
  'camel': 'brown',
  'rust': 'brown',
  'cognac': 'brown',
  
  // Gray variations
  'grey': 'gray',
  'silver': 'gray',
  'charcoal': 'gray',
  'slate': 'gray',
  
  // Yellow variations
  'gold': 'yellow',
  'amber': 'yellow',
  'mustard': 'yellow',
  'cream': 'yellow',
  'ivory': 'yellow',
  
  // Purple variations
  'violet': 'purple',
  'lavender': 'purple',
  'plum': 'purple',
  'magenta': 'purple',
  
  // Black/White variations
  'onyx': 'black',
  'ebony': 'black',
  'jet': 'black',
  'snow': 'white',
  'pearl': 'white',
  'bone': 'white',
};

// ============================================
// Currency Detection
// ============================================

const CURRENCY_SYMBOLS: Record<string, string> = {
  '$': 'USD',
  '£': 'GBP', 
  '€': 'EUR',
  'C$': 'CAD',
  'A$': 'AUD',
};

const CURRENCY_NAMES: Record<string, string> = {
  'dollar': 'USD',
  'dollars': 'USD',
  'bucks': 'USD',
  'usd': 'USD',
  'pound': 'GBP',
  'pounds': 'GBP',
  'gbp': 'GBP',
  'euro': 'EUR',
  'euros': 'EUR',
  'eur': 'EUR',
};

// ============================================
// Basic Intent Parser (Regex-based fallback)
// ============================================

export async function parseIntentBasic(
  userQuery: string,
  requestLogger?: any
): Promise<ParsedIntent> {
  requestLogger?.info({ userQuery }, 'Parsing intent with basic regex approach');

  const filters: z.infer<typeof FiltersSchema> = {};
  let freeText = userQuery.toLowerCase().trim();
  let confidence = 0.5; // Base confidence for regex parsing

  // Extract price range with currency detection
  const priceMatches = [
    // £200-£300, $50-$100, €20-€50
    /([£$€C?A?\$?])(\d+)[-–—]([£$€C?A?\$?])(\d+)/g,
    // £200 to £300, $50 to $100
    /([£$€C?A?\$?])(\d+)\s+to\s+([£$€C?A?\$?])(\d+)/g,
    // between £200 and £300, between $50 and $100
    /between\s+([£$€C?A?\$?])(\d+)\s+and\s+([£$€C?A?\$?])(\d+)/gi,
    // under £300, over $50, below €100
    /(under|below|less than)\s+([£$€C?A?\$?])(\d+)/gi,
    /(over|above|more than)\s+([£$€C?A?\$?])(\d+)/gi,
  ];

  for (const regex of priceMatches) {
    const matches = Array.from(userQuery.matchAll(regex));
    for (const match of matches) {
      if (match[1] && match[2] && match[4]) {
        // Range pattern (between X and Y, X-Y, X to Y)
        const currency1 = detectCurrency(match[1]);
        const currency2 = detectCurrency(match[3]);
        const currency = currency1 || currency2;
        const min = parseInt(match[2]);
        const max = parseInt(match[4]);
        
        filters.price = {
          min: Math.min(min, max),
          max: Math.max(min, max),
          currency: currency as any,
        };
        
        freeText = freeText.replace(match[0].toLowerCase(), '').trim();
        confidence += 0.2;
        requestLogger?.info({ priceRange: filters.price }, 'Extracted price range');
      } else if (match[1] && match[2] && match[3]) {
        // Single bound pattern (under/over X)
        const currency = detectCurrency(match[2]);
        const price = parseInt(match[3]);
        
        if (match[1].includes('under') || match[1].includes('below') || match[1].includes('less')) {
          filters.price = { max: price, currency: currency as any };
        } else {
          filters.price = { min: price, currency: currency as any };
        }
        
        freeText = freeText.replace(match[0].toLowerCase(), '').trim();
        confidence += 0.15;
        requestLogger?.info({ priceFilter: filters.price }, 'Extracted price filter');
      }
    }
  }

  // Extract colors
  const colorPattern = /\b(green|red|blue|black|white|brown|grey|gray|yellow|orange|purple|pink|navy|olive|forest|emerald|lime|mint|sage|khaki|royal|sky|teal|cyan|turquoise|cobalt|crimson|scarlet|maroon|burgundy|cherry|rose|tan|beige|chocolate|coffee|camel|rust|cognac|silver|charcoal|slate|gold|amber|mustard|cream|ivory|violet|lavender|plum|magenta|onyx|ebony|jet|snow|pearl|bone)\b/gi;
  const colorMatches = Array.from(userQuery.matchAll(colorPattern));
  
  if (colorMatches.length > 0) {
    const colors = colorMatches.map(match => {
      const color = match[0].toLowerCase();
      return COLOR_SYNONYMS[color] || color;
    });
    
    filters.attributes = { color: [...new Set(colors)] }; // Remove duplicates
    confidence += 0.2;
    requestLogger?.info({ colors: filters.attributes.color }, 'Extracted colors');
    
    // Remove color mentions from free text
    freeText = freeText.replace(colorPattern, '').replace(/\s+/g, ' ').trim();
  }

  // Extract brands (basic patterns)
  const brandPattern = /\b(nike|adidas|alpha industries|rolex|apple|samsung|zara|h&m|uniqlo|levi'?s?|calvin klein|tommy hilfiger|polo ralph lauren|gucci|prada|louis vuitton|chanel|hermès|balenciaga|off-white|supreme|stone island|cp company|moncler|canada goose|patagonia|north face|columbia|timberland|dr martens|converse|vans|new balance|asics|puma|reebok|under armour|lululemon|gymshark|omega)\b/gi;
  const brandMatches = Array.from(userQuery.matchAll(brandPattern));
  
  if (brandMatches.length > 0) {
    filters.brand = [...new Set(brandMatches.map(match => {
      let brand = match[0].toLowerCase();
      // Normalize Levi's variations
      if (brand.includes('levi')) {
        brand = 'levi';
      }
      return brand;
    }))];
    confidence += 0.2;
    requestLogger?.info({ brands: filters.brand }, 'Extracted brands');
    
    // Remove brand mentions from free text
    freeText = freeText.replace(brandPattern, '').replace(/\s+/g, ' ').trim();
  }

  // Extract categories
  const categoryPattern = /\b(jacket|jackets|bomber|bombers|t-shirt|t-shirts|shirt|shirts|jeans|pants|trousers|dress|dresses|skirt|skirts|shoes|sneakers|trainers|boots|sandals|watch|watches|bag|bags|handbag|handbags|purse|purses|wallet|wallets|backpack|backpacks|hat|hats|cap|caps|sweater|sweaters|jumper|jumpers|hoodie|hoodies|coat|coats)\b/gi;
  const categoryMatches = Array.from(userQuery.matchAll(categoryPattern));
  
  if (categoryMatches.length > 0) {
    // Take the most specific category
    const category = categoryMatches[0][0].toLowerCase();
    filters.category = mapToStandardCategory(category);
    confidence += 0.15;
    requestLogger?.info({ category: filters.category }, 'Extracted category');
  }

  // Extract condition
  const conditionPattern = /\b(new|used|refurbished|pre-owned|second-hand|secondhand)\b/gi;
  const conditionMatch = userQuery.match(conditionPattern);
  
  if (conditionMatch) {
    const condition = conditionMatch[0].toLowerCase();
    const standardCondition = condition === 'pre-owned' || condition.includes('second') ? 'used' : condition;
    
    if (['new', 'used', 'refurbished'].includes(standardCondition)) {
      if (!filters.attributes) filters.attributes = {};
      filters.attributes.condition = standardCondition as 'new' | 'used' | 'refurbished';
      confidence += 0.1;
      requestLogger?.info({ condition: standardCondition }, 'Extracted condition');
      
      freeText = freeText.replace(conditionPattern, '').replace(/\s+/g, ' ').trim();
    }
  }

  // Extract limit hints
  let limit = 8; // default changed to 8
  const limitPattern = /\b(?:show|find|get|want|need)\s+(?:me\s+)?(\d+)\b/gi;
  const limitMatch = userQuery.match(limitPattern);
  
  if (limitMatch) {
    const extractedLimit = parseInt(limitMatch[0].match(/\d+/)?.[0] || '8');
    limit = Math.min(Math.max(extractedLimit, 1), 100); // Clamp between 1-100
    confidence += 0.05;
    requestLogger?.info({ limit }, 'Extracted result limit');
  }

  // Detect if query is contextual (should use page context)
  const contextualKeywords = [
    'similar', 'like this', 'this', 'same', 'alternative', 'alternatives',
    'different', 'another', 'other', 'comparable', 'equivalent', 'matching',
    'related', 'alike', 'resembling', 'corresponding'
  ];
  
  const contextPattern = new RegExp(`\\b(${contextualKeywords.join('|')})\\b`, 'gi');
  const useContext = contextPattern.test(userQuery);
  
  if (useContext) {
    confidence += 0.1;
    requestLogger?.info({ contextualMatch: true }, 'Detected contextual query - will use page context');
  } else {
    requestLogger?.info({ contextualMatch: false }, 'Detected absolute query - will not use page context');
  }

  // Clean up free text
  freeText = freeText
    .replace(/\b(show|find|get|want|need|me|some|any|can|you|help|what|about|i'm|looking|for|a|an|the|in|on|with|from|to|of|and|or|between|range|under|over|above|below)\b/g, '')
    .replace(/['']s\b/g, '') // Remove possessive 's
    .replace(/\s+/g, ' ')
    .trim();

  // Generate clipText and searchText for basic parsing
  const clipText = generateClipText(freeText, filters, useContext);
  const searchText = generateSearchText(freeText, filters, useContext);

  // Calculate final confidence
  const hasFilters = Object.keys(filters).length > 0;
  const hasCleanText = freeText.length > 0;
  
  if (hasFilters && hasCleanText) {
    confidence = Math.min(confidence, 0.8); // Cap at 0.8 for regex parsing
  } else if (hasFilters || hasCleanText) {
    confidence = Math.min(confidence, 0.6);
  } else {
    confidence = 0.2; // Very low confidence if nothing extracted
  }

  const result: ParsedIntent = {
    freeText: freeText || userQuery, // Fallback to original if empty
    filters,
    limit,
    useContext,
    clipText,
    searchText,
  };

  return result;
}

// ============================================
// LangChain-based Intent Parser (Advanced)
// ============================================

// Initialize Gemini model with optimized settings
const createLLM = (modelName?: string) => {
  const config = {
    model: modelName || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    temperature: 0, // Deterministic parsing
    maxOutputTokens: 200, // Further reduced for speed
    maxRetries: 1, // Allow 1 retry for better reliability
    apiKey: process.env.GEMINI_API_KEY,
  };
  
  console.log('Creating LLM with config:', {
    model: config.model,
    maxOutputTokens: config.maxOutputTokens,
    hasApiKey: !!config.apiKey,
    apiKeyPrefix: config.apiKey ? config.apiKey.substring(0, 7) + '...' : 'none'
  });
  
  return new ChatGoogleGenerativeAI(config);
};

// Simple JSON output parser (no complex schema validation)
const createSimpleParser = () => {
  return {
    parse: (text: string) => {
      try {
        // Extract JSON from markdown code blocks if present
        const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        const jsonText = jsonMatch ? jsonMatch[1] : text.trim();
        
        const parsed = JSON.parse(jsonText);
        
        // Basic validation - ensure required fields exist
        // New format: expects 'description' instead of 'freeText', 'clipText', 'searchText'
        if (parsed.description === undefined || parsed.description === null) {
          parsed.description = ''; // Allow empty description
        }
        if (typeof parsed.description !== 'string') {
          throw new Error('Invalid description - must be a string');
        }
        if (typeof parsed.useContext !== 'boolean') {
          throw new Error('Missing or invalid useContext');
        }
        if (!parsed.filters || typeof parsed.filters !== 'object') {
          parsed.filters = {};
        }
        if (typeof parsed.limit !== 'number') {
          parsed.limit = 8;
        }
        
        return parsed;
      } catch (error) {
        throw new Error(`Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
};


// Create a simple, direct prompt template
const createSimplePrompt = () => {
  return new PromptTemplate({
    template: `You are an e-commerce search query parser. Your job is to extract user intent into a clean JSON object for semantic search.

    - Convert the user's query into a rich, descriptive phrase in "description" that captures ALL meaningful details.
    - Extract structured "filters" like color, brand, or price.
    - Determine if the user is referring to the current product ("useContext: true").

    RULES FOR "description":
    - Include ALL descriptive details the user mentions: style (vintage, retro, modern), era (90s, 80s), fit (oversized, slim, cropped), feel (soft, structured, flowy), construction (distressed, raw hem), finish (matte, glossy), and functionality (pockets, lined, adjustable).
    - DO NOT include: "similar", price amounts, brand names (unless they're describing a style like "preppy" or "minimalist").
    - Keep it natural and descriptive - this will be used for semantic embedding search.
    - For apparel: capture fit, silhouette, fabric feel, construction details, color undertones, care needs, lining/functionality.
    - For footwear: capture comfort features, toe box shape, sole type, material feel, fastening type.
    - For accessories: capture weight, organization features, clasp type, finish quality, hardware details.

    RULES FOR "filters":
    - Extract ONLY explicit facts: exact colors, brands, price ranges, product types.
    - Normalize colors using: olive→green, khaki→green, burgundy→red, navy→blue, silver→gray.
    - DO NOT invent a "product_type" if the user doesn't specify one.

    RULES FOR "useContext":
    - Set to true ONLY if user says "similar", "this", "like this", "same", "alternatives", etc.
    - Otherwise false.

    ---
    EXAMPLES:

    Query: "vintage black t shirts from the 90s with big graphics and cropped"
    json
    {{
      "description": "vintage black t shirt from the 90s with big graphics and cropped fit",
      "useContext": false,
      "filters": {{
        "color": ["black"],
        "product_type": "t shirt"
      }},
      "limit": 8
    }}

    Query: "oversized soft hoodie with a relaxed fit and heavy brushed fleece"
    {{
      "description": "oversized soft hoodie with relaxed fit and heavy brushed fleece",
      "useContext": false,
      "filters": {{}},
      "limit": 8
    }}

    Query: "Green bomber jackets £200-£300"
    {{
      "description": "green bomber jacket",
      "useContext": false,
      "filters": {{
        "price": {{"min": 200, "max": 300, "currency": "GBP"}},
        "color": ["green"],
        "product_type": "bomber jacket"
      }},
      "limit": 8
    }}

    Query: "leather boots with wide toe box and good arch support"
    {{
      "description": "leather boots with wide toe box and good arch support",
      "useContext": false,
      "filters": {{
        "product_type": "boots"
      }},
      "limit": 8
    }}

    Query: "Show me similar alternatives in a warm navy with matte finish"
    {{
      "description": "warm navy with matte finish",
      "useContext": true,
      "filters": {{
        "color": ["blue"]
      }},
      "limit": 8
    }}

    Query: "lightweight tote bag that holds a 15 inch laptop with zipper closure"
    {{
      "description": "lightweight tote bag that holds 15 inch laptop with zipper closure",
      "useContext": false,
      "filters": {{
        "product_type": "bag"
      }},
      "limit": 8
    }}

    Query: "15 Nike sneakers under $150"
    {{
      "description": "sneakers",
      "useContext": false,
      "filters": {{
        "brand": ["nike"],
        "price": {{"max": 150, "currency": "USD"}},
        "product_type": "sneaker"
      }},
        "limit": 15
    }}

    Now parse this query:
    Query: "{query}"

Return only the JSON in a code block:`,
    inputVariables: ['query'],
  });
};

export async function parseIntentAdvanced(
  userQuery: string, 
  requestLogger?: any,
  modelName?: string
): Promise<ParsedIntent> {
  const startTime = Date.now();
  requestLogger?.info({ 
    userQuery, 
    model: modelName || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    hasApiKey: !!process.env.GEMINI_API_KEY,
    apiKeyPrefix: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.substring(0, 7) + '...' : 'none'
  }, 'Parsing intent with LangChain (advanced)');

  // Set a hard timeout of 10 seconds total
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('LangChain parsing timeout after 10 seconds')), 10000);
  });

  try {
    // Initialize components
    const llm = createLLM(modelName);
    
    const parser = createSimpleParser();
    
    const prompt = createSimplePrompt();
    
    // Log the prompt template for debugging
    // requestLogger?.info({ 
    //   templatePreview: prompt.template.substring(0, 200),
    //   hasQueryVariable: prompt.template.includes('{query}'),
    //   templateLength: prompt.template.length
    // }, 'Created prompt template');
    
    // Create simplified parsing chain
    const chain = RunnableSequence.from([
      prompt,
      llm as any,
    ]);
    // requestLogger?.info('Parsing chain created successfully');

    // Execute the chain with retries
    let attempts = 0;
    const maxAttempts = 2; // Reduced for faster processing

    const parsePromise = (async () => {
      while (attempts < maxAttempts) {
        let attemptStartTime = Date.now();
        try {
          attempts++;
          requestLogger?.info({ 
            attempt: attempts,
            userQuery,
            queryLength: userQuery.length
          }, 'Invoking LangChain parsing chain');
          
          const llmResponse = await chain.invoke({ query: userQuery });
          
          // Parse the LLM response manually
          const responseText = (llmResponse as any).content || String(llmResponse);
          // requestLogger?.info({ 
          //   responseLength: responseText.length,
          //   responsePreview: responseText.substring(0, 200)
          // }, 'Received LLM response');
          
          const validatedResult = parser.parse(responseText);
          const processedResult = postProcessLangChainResult(validatedResult, requestLogger);
          
          // Log the extracted clipText and searchText from LangChain
          // requestLogger?.info({
          //   userQuery,
          //   langchainClipText: processedResult.clipText,
          //   langchainSearchText: processedResult.searchText,
          //   useContext: processedResult.useContext,
          //   extractedFilters: processedResult.filters
          // }, '🤖 PARSING DEBUG: Generated clipText and searchText (LangChain parsing)');
          
          return processedResult;
          
        } catch (error) {
          const attemptDuration = Date.now() - (attemptStartTime || startTime);
          const errorDetails = {
            message: error instanceof Error ? error.message : String(error),
            name: error instanceof Error ? error.name : 'Unknown',
            stack: error instanceof Error ? error.stack : undefined,
            attempt: attempts,
            maxAttempts,
            attemptDuration
          };
          
          // requestLogger?.warn(errorDetails, 'LangChain parsing attempt failed');
          
          // Log specific Gemini API errors
          if (error instanceof Error) {
            if (error.message.includes('timeout') || error.message.includes('TIMEOUT')) {
              requestLogger?.error({ timeout: true, attemptDuration }, 'Gemini API timeout detected');
            } else if (error.message.includes('401') || error.message.includes('Unauthorized')) {
              requestLogger?.error({ authError: true }, 'Gemini API authentication error');
            } else if (error.message.includes('429') || error.message.includes('rate limit')) {
              requestLogger?.error({ rateLimitError: true }, 'Gemini API rate limit error');
            } else if (error.message.includes('500') || error.message.includes('502') || error.message.includes('503')) {
              requestLogger?.error({ serverError: true }, 'Gemini API server error');
            }
          }
          
          if (attempts === maxAttempts) {
            throw error;
          }
          
          // Wait before retry (increased wait time for better reliability)
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      throw new Error('All parsing attempts failed');
    })();

    // Race between parsing and timeout
    const finalResult = await Promise.race([parsePromise, timeoutPromise]);
    return finalResult as ParsedIntent;
    
  } catch (error) {
    const duration = Date.now() - startTime;
    requestLogger?.error({ 
      error: error instanceof Error ? error.message : String(error),
      duration,
      userQuery 
    }, 'LangChain parsing failed, falling back to basic parsing');
    
    // Fallback to regex parsing
    return parseIntentBasic(userQuery, requestLogger);
  }
}

/**
 * Post-process LangChain results for consistency and quality
 */
function postProcessLangChainResult(
  result: any, // Accept raw LLM result with 'description'
  requestLogger?: any
): ParsedIntent {
  // Extract description from new format
  const description = result.description || '';
  const useContext = result.useContext === true;
  const filters = result.filters || {};
  
  // Clean up null values - convert to undefined for optional fields
  if (filters.category === null) {
    filters.category = undefined;
  }
  if (filters.subcategory === null) {
    filters.subcategory = undefined;
  }
  if (filters.price === null) {
    filters.price = undefined;
  }
  if (filters.brand === null) {
    filters.brand = undefined;
  }
  
  // Clean up attributes object
  if (filters.attributes) {
    if (filters.attributes.condition === null) {
      filters.attributes.condition = undefined;
    }
    if (filters.attributes.color === null) {
      filters.attributes.color = undefined;
    }
    if (filters.attributes.material === null) {
      filters.attributes.material = undefined;
    }
    if (filters.attributes.size === null) {
      filters.attributes.size = undefined;
    }
    
    // Remove attributes object if all fields are undefined
    const hasAnyAttribute = filters.attributes.color || 
                           filters.attributes.material || 
                           filters.attributes.size || 
                           filters.attributes.condition;
    if (!hasAnyAttribute) {
      filters.attributes = undefined;
    }
  }
  
  // Ensure arrays are properly formatted
  if (filters.brand && !Array.isArray(filters.brand)) {
    filters.brand = [filters.brand as any];
  }
  
  if (filters.attributes?.color && !Array.isArray(filters.attributes.color)) {
    filters.attributes.color = [filters.attributes.color as any];
  }
  
  // Normalize brands to lowercase
  if (filters.brand) {
    filters.brand = filters.brand.map((brand: string) => {
      let normalized = brand.toLowerCase();
      // Handle special cases
      if (normalized.includes('levi')) normalized = 'levi';
      return normalized;
    });
  }
  
  // Apply color synonyms
  if (filters.attributes?.color) {
    filters.attributes.color = filters.attributes.color.map((color: string) => {
      const normalizedColor = color.toLowerCase();
      return COLOR_SYNONYMS[normalizedColor] || normalizedColor;
    });
    
    // Remove duplicates
    filters.attributes.color = [...new Set(filters.attributes.color)];
  }
  
  // Ensure limit is within bounds
  const limit = Math.min(Math.max(result.limit || 8, 1), 100);
  
  // Generate clipText and searchText from description
  const clipText = generateClipTextFromDescription(description, useContext);
  const searchText = generateSearchTextFromDescription(description, useContext);
  
  // Set freeText to description for backward compatibility
  const freeText = description;
  
  const processed: ParsedIntent = {
    freeText,
    filters,
    limit,
    useContext,
    clipText,
    searchText,
  };
  
  requestLogger?.info({ 
    originalResult: result,
    processedResult: processed 
  }, 'Post-processed LangChain result');
  
  return processed;
}

// ============================================
// Main Parser Entry Point
// ============================================

export async function parseIntent(
  userQuery: string,
  useAdvanced: boolean = true, // Default to LangChain parser
  requestLogger?: any
): Promise<ParsedIntent> {
  try {
    // Use advanced LangChain parser by default if API key is available
    const hasApiKey = !!process.env.GEMINI_API_KEY;
    
    if (useAdvanced && hasApiKey) {
      return await parseIntentAdvanced(userQuery, requestLogger);
    } else {
      if (useAdvanced && !hasApiKey) {
        requestLogger?.warn('Gemini API key not found, falling back to basic parsing');
      }
      return await parseIntentBasic(userQuery, requestLogger);
    }
  } catch (error) {
    requestLogger?.error({ error, userQuery }, 'Intent parsing failed, using fallback');
    
    // Minimal fallback parsing
    const fallbackResult = {
      freeText: userQuery,
      filters: {},
      limit: 8,
      useContext: false, // Default to false for safety
      clipText: `a photo of ${userQuery}`,
      searchText: `desc: ${userQuery}`,
    };
    
    requestLogger?.info({
      userQuery,
      fallbackClipText: fallbackResult.clipText,
      fallbackSearchText: fallbackResult.searchText,
      reason: 'parsing_failed'
    }, '⚠️ PARSING DEBUG: Using fallback clipText and searchText');
    
    return fallbackResult;
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Generate clipText for vision-language model (SigLIP/CLIP) from description
 */
function generateClipTextFromDescription(description: string, useContext: boolean): string {
  // If description is empty and useContext is true, return empty string (will use context only)
  if (!description || description.trim().length === 0) {
    if (useContext) {
      return ''; // Empty - will use context product vectors only
    }
    return 'a photo of an item'; // Fallback for absolute queries
  }
  
  const cleanDescription = description.trim();
  
  if (useContext) {
    // For contextual queries: "a photo of a {description} {context_product_subcategory}"
    const result = `a photo of a ${cleanDescription} {context_product_subcategory}`;
    return result;
  }
  
  // For absolute queries: "a photo of a {description}"
  const result = `a photo of a ${cleanDescription}`;
  return result;
}

/**
 * Generate searchText for semantic text embedding from description
 */
function generateSearchTextFromDescription(description: string, useContext: boolean): string {
  // If description is empty and useContext is true, return empty string (will use context only)
  if (!description || description.trim().length === 0) {
    if (useContext) {
      return ''; // Empty - will use context product vectors only
    }
    return 'an item'; // Fallback for absolute queries
  }
  
  const cleanDescription = description.trim();
  
  if (useContext) {
    // For contextual queries: "a {description} {context_product_subcategory}"
    const result = `a ${cleanDescription} {context_product_subcategory}`;
    return result;
  }
  
  // For absolute queries: "a {description}"
  const result = `a ${cleanDescription}`;
  return result;
}

/**
 * Generate clipText for vision-language model (SigLIP/CLIP) - legacy function for basic parser
 */
function generateClipText(freeText: string, filters: any, useContext: boolean): string {
  if (useContext) {
    // For contextual queries, use placeholder that will be replaced with context product type
    const colors = filters.attributes?.color || [];
    const colorText = colors.length > 0 ? colors[0] + ' ' : '';
    const result = `a photo of ${colorText}{context_product_type}`;
    return result;
  }

  // Extract key visual elements
  const colors = filters.attributes?.color || [];
  const category = filters.category || '';
  const subcategory = filters.subcategory || '';
  
  let clipText = 'a photo of ';
  
  // Add color if present
  if (colors.length > 0) {
    clipText += colors[0] + ' ';
  }
  
  // Add product type (prefer subcategory, then category, then freeText)
  if (subcategory) {
    clipText += subcategory;
  } else if (category) {
    clipText += category;
  } else if (freeText) {
    // Extract main product type from freeText
    const productTypes = ['jacket', 'shirt', 'pants', 'jeans', 'dress', 'skirt', 'shoes', 'sneakers', 'boots', 'watch', 'bag', 'hat'];
    const foundType = productTypes.find(type => freeText.toLowerCase().includes(type));
    clipText += foundType || freeText.split(' ').slice(0, 2).join(' ');
  }
  
  const result = clipText.trim();
  return result;
}

/**
 * Generate searchText for semantic text embedding - legacy function for basic parser
 */
function generateSearchText(freeText: string, filters: any, useContext: boolean): string {
  const lines: string[] = [];
  
  // Add brand if present
  if (filters.brand && filters.brand.length > 0) {
    lines.push(`brand: ${filters.brand.join(', ')}`);
  }
  
  // Add product type
  if (useContext) {
    lines.push('product_type: {context_product_type}');
  } else if (filters.subcategory) {
    lines.push(`product_type: ${filters.subcategory}`);
  } else if (filters.category) {
    lines.push(`product_type: ${filters.category}`);
  }
  
  // Add attributes
  const attributes: string[] = [];
  if (filters.attributes?.color) {
    attributes.push(...filters.attributes.color);
  }
  if (filters.attributes?.material) {
    attributes.push(...filters.attributes.material);
  }
  if (filters.attributes?.condition) {
    attributes.push(filters.attributes.condition);
  }
  if (attributes.length > 0) {
    lines.push(`attributes: ${attributes.join(', ')}`);
  }
  
  // Add color separately if not in attributes
  if (filters.attributes?.color && filters.attributes.color.length > 0) {
    lines.push(`color: ${filters.attributes.color.join(', ')}`);
  }
  
  // Add category if present
  if (filters.category) {
    lines.push(`category: ${filters.category}`);
  }
  
  // Add description
  if (freeText) {
    let desc = freeText;
    if (filters.price) {
      if (filters.price.min && filters.price.max) {
        desc += ` between ${filters.price.min} and ${filters.price.max} ${filters.price.currency || 'USD'}`;
      } else if (filters.price.max) {
        desc += ` under ${filters.price.max} ${filters.price.currency || 'USD'}`;
      } else if (filters.price.min) {
        desc += ` over ${filters.price.min} ${filters.price.currency || 'USD'}`;
      }
    }
    lines.push(`desc: ${desc.toLowerCase()}`);
  }
  
  const result = lines.join('\n');
  console.log(`📝 searchText generation: useContext=${useContext}, brand=${filters.brand?.join(',') || 'none'}, attributes=${attributes.join(',') || 'none'} → "${result.replace(/\n/g, '\\n')}"`);
  return result;
}

/**
 * Replace context placeholders in clipText and searchText with actual product subcategory
 */
export function replaceContextPlaceholders(text: string, contextProductSubcategory: string): string {
  // Replace both old and new placeholder formats for backward compatibility
  return text
    .replace(/{context_product_subcategory}/g, contextProductSubcategory)
    .replace(/{context_product_type}/g, contextProductSubcategory);
}

/**
 * Extract product type from search_text field
 */
export function extractProductTypeFromSearchText(searchText: string): string {
  if (!searchText) return 'item';
  
  // Look for product_type field
  const productTypeMatch = searchText.match(/product_type:\s*([^\n]+)/i);
  if (productTypeMatch) {
    return productTypeMatch[1].trim();
  }
  
  // Fallback: look for common product types in the text
  const productTypes = ['jacket', 'shirt', 'pants', 'jeans', 'dress', 'skirt', 'shoes', 'sneakers', 'boots', 'watch', 'bag', 'hat', 'sweater', 'hoodie', 'coat'];
  const foundType = productTypes.find(type => searchText.toLowerCase().includes(type));
  
  return foundType || 'item';
}

function detectCurrency(symbol: string): string {
  const cleaned = symbol.trim().toLowerCase();
  
  // Check symbol mapping
  for (const [sym, currency] of Object.entries(CURRENCY_SYMBOLS)) {
    if (cleaned.includes(sym)) {
      return currency;
    }
  }
  
  // Check name mapping
  for (const [name, currency] of Object.entries(CURRENCY_NAMES)) {
    if (cleaned.includes(name)) {
      return currency;
    }
  }
  
  // Default to USD if unknown
  return 'USD';
}

function mapToStandardCategory(category: string): string {
  const categoryMap: Record<string, string> = {
    'jacket': 'clothing',
    'jackets': 'clothing',
    'bomber': 'clothing',
    'bombers': 'clothing',
    't-shirt': 'clothing',
    't-shirts': 'clothing',
    'shirt': 'clothing',
    'shirts': 'clothing',
    'jeans': 'clothing',
    'pants': 'clothing',
    'trousers': 'clothing',
    'dress': 'clothing',
    'dresses': 'clothing',
    'skirt': 'clothing',
    'skirts': 'clothing',
    'sweater': 'clothing',
    'sweaters': 'clothing',
    'jumper': 'clothing',
    'jumpers': 'clothing',
    'hoodie': 'clothing',
    'hoodies': 'clothing',
    'coat': 'clothing',
    'coats': 'clothing',
    'shoes': 'footwear',
    'sneakers': 'footwear',
    'trainers': 'footwear',
    'boots': 'footwear',
    'sandals': 'footwear',
    'watch': 'accessories',
    'watches': 'accessories',
    'bag': 'accessories',
    'bags': 'accessories',
    'handbag': 'accessories',
    'handbags': 'accessories',
    'purse': 'accessories',
    'purses': 'accessories',
    'wallet': 'accessories',
    'wallets': 'accessories',
    'backpack': 'accessories',
    'backpacks': 'accessories',
    'hat': 'accessories',
    'hats': 'accessories',
    'cap': 'accessories',
    'caps': 'accessories',
  };
  
  return categoryMap[category.toLowerCase()] || 'clothing';
}
