import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { HumanMessage, AIMessage, ToolMessage, BaseMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { fetchContextProduct} from './context-utils';
import { determineSearchStrategy, performManagedSearch, SearchInput } from './search-tools';
import { enrichWithBestOffers } from '../search/search';
import { normalizeFilters } from './filter-normalizer';
import { logger } from '../log';

// Re-using interfaces from the original file for compatibility
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: Date;
}

export interface OrchestratorContext {
  pageContext?: {
    productId?: string;
  };
  imageUrl?: string;
  userLocation?: string;
  topK?: number;
  excludeProductIds?: string[];
}

export interface ToolCallResult {
  toolName: string;
  result: any;
  shouldContinue?: boolean;
}

/**
 * Structured output from synthesizeSearchIntent
 * Separates semantic search text from user-stated filters
 */
export interface SynthesizedIntent {
  searchText: string;           // Rich description for semantic search (includes context)
  userFilters: {                // Only filters USER explicitly stated in conversation
    brand?: string[];
    color?: string[];
    material?: string[];
    gender?: 'male' | 'female' | 'unisex';
    condition?: 'new' | 'used' | 'refurbished';
    price?: { min?: number; max?: number; currency?: string };
    size?: { values: string[]; region?: string; type?: string };
  };
}

/**
 * Get system prompt based on context
 */
function getSystemPrompt(hasPageContext: boolean, hasSelectedProduct: boolean, contextProduct?: any): string {
  const base = `You are a concise, friendly fashion stylist. Goal: get the user to relevant products fast.

Decision rules (apply in order):
- If user provided an IMAGE or there is a CONTEXT PRODUCT → always use search_products (bypass is expected).
- If text-only:
  - clear intent + item type + any detail (color/brand/style/price/fit/etc.) → search_products
  - asking for suggestions/advice/opinion → provide_fashion_advice
  - missing item type or detail → ask_follow_up_question (one focused question)

Conversation:
- Review the entire conversation to combine details; refinements may span multiple turns.
- If user says "this" but no context product exists, treat it as a fresh search using the combined conversation details.

search_products expectations:
- Use searchMode="fresh" for text-only or image uploads.
- With context product: context_unchanged for "more like this", context_modified for changes (color/price/material/etc.).
- Provide valid JSON matching the tool schema: searchMode, userQuery, optional limit, searchText/clipCaption when needed, filters, serpSearchKeywords, friendlyMessage.
- Extract all explicit brands/colors/materials/price/size mentions as arrays where applicable.

Advice vs search:
- "show me / find / looking for" → search
- "what do you recommend / any suggestions / what should I get" → advice`;

  if ((hasPageContext || hasSelectedProduct) && contextProduct) {
    const priceDisplay = contextProduct.price
      ? `${contextProduct.currency || 'GBP'} ${contextProduct.price}`
      : 'N/A';

    const productDesc = `
🎯 CONTEXT PRODUCT AVAILABLE:
- Title: ${contextProduct.title}
- Brand: ${contextProduct.brand || 'N/A'}
- Category: ${contextProduct.sub_category || contextProduct.category || 'N/A'}
- Color: ${contextProduct.color || 'N/A'}
- Material: ${contextProduct.primary_material || 'N/A'}
- Price: ${priceDisplay}
- Description: ${contextProduct.search_text || contextProduct.title}

CRITICAL: When user asks for modifications (e.g., "similar in navy", "like this but cheaper"):
1. Use searchMode="context_modified"
2. Generate NEW searchText by MODIFYING the context product description above
3. Example: If context is "grey wide-leg trousers" and user asks "similar in navy":
   - searchText: "navy wide-leg trousers"
   - clipCaption: "a photo of navy wide-leg trousers"
4. ALWAYS base your modifications on the actual context product description, not generic text
5. PRICE MODIFICATIONS: If user asks for "cheaper", "less expensive", "more affordable":
   - The context product costs ${priceDisplay}
   - Set filters.price.max to a value BELOW the context product price
   - Example: If context is £200 and user says "cheaper" → set max: 150 or max: 180

When user just wants "more like this" with NO modifications → use searchMode="context_unchanged" and omit searchText/clipCaption.`;

    if (hasPageContext) {
      return base + productDesc + `\n\nUser is viewing this product on a webpage. References to "this" mean this exact product.`;
    } else {
      return base + productDesc + `\n\nUser has selected this product from search results. References to "this" mean this exact product.`;
    }
  }


  return base;
}

/**
 * Validate and normalize search parameters before executing search
 */
function validateAndNormalizeSearchParams(
  rawParams: any,
  context: OrchestratorContext,
  hasContextProduct: boolean,
  fallbackSearchText?: string
): { normalized: any; issues: string[] } {
  const params = { ...rawParams };
  const issues: string[] = [];

  // searchMode sanity
  const allowedModes = new Set(['fresh', 'context_modified', 'context_unchanged']);
  if (!allowedModes.has(params.searchMode)) {
    issues.push('invalid_search_mode');
    params.searchMode = 'fresh';
  }

  // Image forces fresh mode
  if (context.imageUrl && params.searchMode !== 'fresh') {
    params.searchMode = 'fresh';
  }

  // Trim strings
  if (typeof params.searchText === 'string') params.searchText = params.searchText.trim();
  if (typeof params.clipCaption === 'string') params.clipCaption = params.clipCaption.trim();
  if (typeof params.serpSearchKeywords === 'string') params.serpSearchKeywords = params.serpSearchKeywords.trim();
  if (typeof params.userQuery === 'string') params.userQuery = params.userQuery.trim();

  // Limit normalization
  if (params.limit !== undefined) {
    const parsedLimit = Number(params.limit);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
      issues.push('invalid_limit');
      params.limit = undefined;
    } else {
      params.limit = Math.round(parsedLimit);
    }
  }

  // Filters normalization
  if (params.filters && typeof params.filters === 'object') {
    const filters = { ...params.filters };
    const normalizeToArray = (val: any) => {
      if (Array.isArray(val)) return val;
      if (val === undefined || val === null) return undefined;
      return [val];
    };
    filters.brand = normalizeToArray(filters.brand);
    filters.color = normalizeToArray(filters.color);
    filters.material = normalizeToArray(filters.material);
    filters.subcategory = normalizeToArray(filters.subcategory);

    if (filters.price && typeof filters.price === 'object') {
      if (filters.price.min !== undefined) {
        const minVal = Number(filters.price.min);
        filters.price.min = Number.isFinite(minVal) ? minVal : undefined;
      }
      if (filters.price.max !== undefined) {
        const maxVal = Number(filters.price.max);
        filters.price.max = Number.isFinite(maxVal) ? maxVal : undefined;
      }
      if (!filters.price.min && !filters.price.max && !filters.price.currency) {
        delete filters.price;
      } else if (!filters.price.currency) {
        filters.price.currency = 'GBP';
      }
    }

    if (filters.size && typeof filters.size === 'object') {
      if (filters.size.values && !Array.isArray(filters.size.values)) {
        filters.size.values = [filters.size.values].filter(Boolean);
      }
      if (!filters.size.values || filters.size.values.length === 0) {
        delete filters.size;
      }
    }

    // Drop empties
    if (filters.brand?.length === 0) delete filters.brand;
    if (filters.color?.length === 0) delete filters.color;
    if (filters.material?.length === 0) delete filters.material;
    if (filters.subcategory?.length === 0) delete filters.subcategory;

    if (Object.keys(filters).length === 0) {
      delete params.filters;
    } else {
      params.filters = filters;
    }
  }

  // If context_* was chosen but we lack context product, downgrade to fresh and keep text
  if ((params.searchMode === 'context_modified' || params.searchMode === 'context_unchanged') && !hasContextProduct) {
    params.searchMode = 'fresh';
    if (!params.searchText) {
      params.searchText = fallbackSearchText || params.userQuery;
    }
    if (params.searchText && !params.clipCaption) {
      params.clipCaption = `a photo of ${params.searchText}`;
    }
    issues.push('downgraded_context_to_fresh');
  }

  // Validation: fresh search without text/image/context
  const hasText = !!params.searchText?.trim();
  const hasImage = !!context.imageUrl;
  if (params.searchMode === 'fresh' && !hasText && !hasImage && !hasContextProduct) {
    issues.push('missing_search_text');
  }

  // Derive serp keywords if missing
  if (!params.serpSearchKeywords) {
    params.serpSearchKeywords = params.searchText || params.userQuery;
  }

  // Fallback to user query if search text is empty
  if (!params.searchText) {
    params.searchText = params.userQuery;
  }

  // Ensure clip caption aligns when searchText exists
  if (params.searchText && !params.clipCaption && params.searchMode === 'fresh') {
    params.clipCaption = `a photo of ${params.searchText}`;
  }

  return { normalized: params, issues };
}

function buildFollowUpQuestion(issues: string[]): string {
  if (issues.includes('missing_search_text')) {
    return 'To search, what item are you looking for and one detail (e.g., color, brand, price, style)?';
  }
  if (issues.includes('missing_context_for_context_mode')) {
    return 'Should I search for something new? Tell me the item type plus one detail (color, brand, price, style).';
  }
  return 'What item can I find for you? Please share the item type and one detail like color, brand, style, or budget.';
}

/**
 * Synthesize search intent from conversation history
 * Returns both a rich search description AND user-stated filters (separated)
 * 
 * Key distinction:
 * - searchText: Rich description for semantic similarity (can include context product details)
 * - userFilters: ONLY filters the USER explicitly stated in conversation (NOT from context product)
 */
async function synthesizeSearchIntent(
  userMessage: string,
  conversationHistory: ConversationMessage[],
  contextProductDetails: any | null,
  requestLogger?: any
): Promise<SynthesizedIntent> {

  const emptyFilters: SynthesizedIntent['userFilters'] = {};

  // If no history, return the original message with empty filters
  if (conversationHistory.length === 0) {
    return { searchText: userMessage, userFilters: emptyFilters };
  }

  // NOTE: We removed the early return for "similar" queries here.
  // Previously this would return empty filters for queries like "similar items under £50",
  // which incorrectly discarded explicit user filters (like price).
  // Now we always let the LLM extract filters from the full query.

  // Check if this looks like a refinement (short message modifying previous search)
  const refinementPatterns = [
    /^more\s+\w+/i,           // "more white", "more casual"
    /^in\s+\w+/i,             // "in leather", "in blue"
    /^but\s+/i,               // "but cheaper", "but in red"
    /^with\s+/i,              // "with pockets"
    /^(cheaper|less expensive|more affordable)/i,
    /^(longer|shorter|bigger|smaller)/i,
    /^(darker|lighter|brighter)/i,
    /^\w+\s+(color|colour|version)/i,  // "blue version"
  ];

  const looksLikeRefinement = refinementPatterns.some(p => p.test(userMessage.trim()));
  const wordCount = userMessage.split(' ').length;

  // If it doesn't look like a refinement and is a substantial query, return as-is with empty filters
  if (!looksLikeRefinement && wordCount > 5) {
    return { searchText: userMessage, userFilters: emptyFilters };
  }

  const synthesisLLM = new ChatOpenAI({
    model: 'gpt-4.1-mini',
    temperature: 0.1,
    maxTokens: 600,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });

  // Build history string focusing on search-relevant messages (last 3 exchanges max)
  const relevantHistory = conversationHistory
    .slice(-6)
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  // Context product info for searchText (but NOT for filters)
  const contextInfo = contextProductDetails
    ? `CONTEXT PRODUCT (for searchText reference, NOT for filters):
- Title: ${contextProductDetails.title}
- Description: ${contextProductDetails.search_text || contextProductDetails.title}
- Brand: ${contextProductDetails.brand || 'N/A'}
- Color: ${contextProductDetails.color || 'N/A'}
- Material: ${contextProductDetails.primary_material || 'N/A'}`
    : 'CONTEXT PRODUCT: None';

  const prompt = `Given this conversation about finding fashion items, extract TWO things:
1. A synthesized search description (for semantic similarity search)
2. Filters the USER explicitly requested (accumulated across their messages in this conversation)

CONVERSATION HISTORY:
${relevantHistory}

${contextInfo}

CURRENT USER MESSAGE: "${userMessage}"

RULES FOR searchText:
- Combine context product description with user's modifications for rich semantic matching
- Include style, color, material, pattern details for similarity search
- If user says "like this but X", base searchText on context product description + their modification

RULES FOR userFilters (CRITICAL):
- ONLY include filters the USER explicitly stated in their messages
- DO NOT copy attributes from the context product into filters
- Accumulate filters across conversation turns (if user said "brand X" earlier, keep it)
- If user says "similar to this" without specifying brand/color/etc, leave those filters empty

EXAMPLES:
1. Context: "Nike leather jacket" + User: "find similar" 
   → searchText: "leather jacket", userFilters: {} (user didn't ask for Nike specifically)

2. Context: "Nike leather jacket" + User: "but from Adidas"
   → searchText: "leather jacket", userFilters: { "brand": ["adidas"] }

3. Previous user message: "jacket from Brand A" + Current: "in red"
   → searchText: "red jacket", userFilters: { "brand": ["brand a"], "color": ["red"] }

4. Context: "wool coat £250" + User: "similar but cheaper"
   → searchText: "wool coat", userFilters: { "price": { "max": 200 } }

5. User only: "show me Nike sneakers in black or white"
   → searchText: "Nike sneakers", userFilters: { "brand": ["nike"], "color": ["black", "white"] }

Output ONLY valid JSON (no markdown, no explanation):
{
  "searchText": "descriptive text for semantic search",
  "userFilters": {
    "brand": ["array of brands user explicitly mentioned"] or undefined,
    "color": ["array of colors user explicitly mentioned"] or undefined,
    "material": ["array of materials user explicitly mentioned"] or undefined,
    "gender": "male" | "female" | "unisex" or undefined,
    "condition": "new" | "used" | "refurbished" or undefined,
    "price": { "min": number, "max": number, "currency": "GBP" } or undefined,
    "size": { "values": ["array"], "region": "US|UK|EU|JP", "type": "alpha|numeric|shoe" } or undefined
  }
}`;

  try {
    const result = await synthesisLLM.invoke(prompt);
    const responseText = result.content.toString().trim();

    // Parse JSON (handle markdown code blocks)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      requestLogger?.warn({ responseText }, '🔄 [SYNTHESIS] No JSON found, using fallback');
      return { searchText: userMessage, userFilters: emptyFilters };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    // Validate and clean the response
    const searchText = typeof parsed.searchText === 'string' ? parsed.searchText.trim() : userMessage;
    const userFilters: SynthesizedIntent['userFilters'] = {};

    if (parsed.userFilters && typeof parsed.userFilters === 'object') {
      const uf = parsed.userFilters;
      
      // Normalize array fields
      if (Array.isArray(uf.brand) && uf.brand.length > 0) {
        userFilters.brand = uf.brand.map((b: any) => String(b).toLowerCase());
      }
      if (Array.isArray(uf.color) && uf.color.length > 0) {
        userFilters.color = uf.color.map((c: any) => String(c).toLowerCase());
      }
      if (Array.isArray(uf.material) && uf.material.length > 0) {
        userFilters.material = uf.material.map((m: any) => String(m).toLowerCase());
      }
      
      // Single-value fields
      if (uf.gender && ['male', 'female', 'unisex'].includes(uf.gender)) {
        userFilters.gender = uf.gender;
      }
      if (uf.condition && ['new', 'used', 'refurbished'].includes(uf.condition)) {
        userFilters.condition = uf.condition;
      }
      
      // Price object
      if (uf.price && typeof uf.price === 'object') {
        const price: { min?: number; max?: number; currency?: string } = {};
        if (typeof uf.price.min === 'number') price.min = uf.price.min;
        if (typeof uf.price.max === 'number') price.max = uf.price.max;
        if (typeof uf.price.currency === 'string') price.currency = uf.price.currency;
        if (Object.keys(price).length > 0) userFilters.price = price;
      }
      
      // Size object
      if (uf.size && typeof uf.size === 'object' && Array.isArray(uf.size.values) && uf.size.values.length > 0) {
        userFilters.size = {
          values: uf.size.values.map((v: any) => String(v)),
          ...(uf.size.region && { region: uf.size.region }),
          ...(uf.size.type && { type: uf.size.type }),
        };
      }
    }

    requestLogger?.info({
      step: 'SYNTHESIS_COMPLETE',
      searchText,
      userFilters,
      originalMessage: userMessage,
    }, '🔄 [SYNTHESIS] Extracted intent and user filters');

    return { searchText, userFilters };
  } catch (error) {
    requestLogger?.error({
      step: 'ERROR',
      error: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      fallback: userMessage,
    }, '🔄 [SYNTHESIS] ❌ LLM synthesis failed, using original message');
    return { searchText: userMessage, userFilters: emptyFilters };
  }
}

/**
 * Generate search parameters using LLM (bypass version - skips tool selection)
 * Uses the same schema as search_products tool for consistency
 */
async function generateSearchParamsWithLLM(
  userMessage: string,
  context: OrchestratorContext,
  contextProductDetails: any | null,
  requestLogger?: any
): Promise<any> {
  // Create a focused LLM for parameter extraction
  const paramLLM = new ChatOpenAI({
    model: 'gpt-4.1-mini',
    temperature: 0.1,
    maxTokens: 400,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });

  // Build context-aware prompt
  let promptContext = '';

  if (context.imageUrl) {
    promptContext = `User has uploaded an image for visual search.
- For image-only: Leave searchText and clipCaption undefined
- For image + descriptive text: Provide searchText and clipCaption for hybrid search`;
  } else if (contextProductDetails) {
    const priceInfo = contextProductDetails.price
      ? `- Price: ${contextProductDetails.currency || 'GBP'} ${contextProductDetails.price}`
      : '- Price: N/A';

    promptContext = `CONTEXT PRODUCT:
- Title: ${contextProductDetails.title}
- Description: ${contextProductDetails.search_text || contextProductDetails.title}
- Brand: ${contextProductDetails.brand || 'N/A'}
- Category: ${contextProductDetails.sub_category || contextProductDetails.category || 'N/A'}
- Color: ${contextProductDetails.color || 'N/A'}
- Material: ${contextProductDetails.primary_material || 'N/A'}
${priceInfo}

For modifications: Base your searchText on the Description field, then apply user's changes.
For price modifications ("cheaper", "less expensive", "more affordable"): Set filters.price.max to a value BELOW ${contextProductDetails.price || 'the context product price'}.`;
  }

  const prompt = `Extract search parameters from user query. Output VALID JSON only (no comments, no trailing text).

${promptContext}

USER QUERY: "${userMessage}"

Extract the following parameters:

1. **searchMode**:
   - "fresh" if new search or image uploaded
   - "context_unchanged" if "more like this", "similar", "alternatives" with NO modifications
   - "context_modified" if context exists + modifications requested

2. **limit**: Number of results (e.g., "30 products" → 30, "show me 20" → 20)

3. **searchText**:
   - context_unchanged: undefined
   - context_modified: Modify the Description with user changes
   - fresh with image only: undefined
   - fresh with descriptive text: Use user query

4. **clipCaption**: "a photo of [description]" (same rules as searchText)

5. **filters**:
   CRITICAL: ONLY extract filters that the USER explicitly stated in their query.
   DO NOT copy attributes from the context product into filters.
   - If user says "similar items under £50", only include price filter, NOT brand/color from context
   - If user says "similar but in red", only include color: ["red"], NOT brand from context
   - If user says "find me Nike alternatives", include brand: ["nike"] because user mentioned it
   
   Filter fields:
   - brand: Array of brand names (e.g., ["nike", "adidas"]) - ONLY if user explicitly mentions brands. Use [] if none.
   - color: Array of colors (e.g., ["black", "white", "navy"]) - ONLY if user explicitly mentions colors. Use [] if none.
   - material: Array of materials (e.g., ["leather", "cotton", "wool"]) - ONLY if user explicitly mentions materials. Use [] if none.
   - gender: "male" | "female" | "unisex" (single value) - ONLY if user explicitly mentions
   - condition: "new" | "used" | "refurbished" (single value) - ONLY if user explicitly mentions
   - price: {min, max, currency} (single price range) - extract from "under £50", "cheaper", "less than $100", etc.
   - size: {values: ["array"], region: "US|UK|EU|JP" (OPTIONAL), type: "alpha|numeric|shoe" (OPTIONAL)}
     CRITICAL: Only include "region" if user EXPLICITLY mentions it (e.g., "UK size 10", "US 9.5", "EU 42")
     DO NOT include region if user just says "size 10" or "size L" - omit region field entirely

   IMPORTANT: When user mentions multiple values (e.g., "black or white", "nike and adidas", "size 10 or 10.5"), extract ALL of them into arrays.

6. **serpSearchKeywords**: Keywords for fallback

7. **friendlyMessage**: Natural response

EXAMPLES:

"show me 30 like this" (context: "grey wide-leg trousers")
{
  "searchMode": "context_unchanged",
  "limit": 30,
  "filters": {},
  "serpSearchKeywords": "grey wide-leg trousers",
  "friendlyMessage": "Here are 30 more items like this!"
}

"something like this but in red" (context Description: "green and orange piece of art cap")
{
  "searchMode": "context_modified",
  "searchText": "red and orange piece of art cap",
  "clipCaption": "a photo of a red cap",
  "filters": {},
  "serpSearchKeywords": "red cap",
  "friendlyMessage": "Here are some similar items in red!"
}

"show me similar under £300" (context: "vintage leather jacket")
{
  "searchMode": "context_unchanged",
  "filters": {
    "price": {"max": 300, "currency": "GBP"}
  },
  "serpSearchKeywords": "vintage leather jacket",
  "friendlyMessage": "Here are similar vintage leather jackets under £300!"
}

"something similar but cheaper" (context: "cashmere sweater", context price: £250)
{
  "searchMode": "context_unchanged",
  "filters": {
    "price": {"max": 200, "currency": "GBP"}
  },
  "serpSearchKeywords": "cashmere sweater",
  "friendlyMessage": "Here are similar cashmere sweaters at a lower price!"
}

"like this but more affordable" (context: "leather boots", context price: £180)
{
  "searchMode": "context_unchanged",
  "filters": {
    "price": {"max": 130, "currency": "GBP"}
  },
  "serpSearchKeywords": "leather boots",
  "friendlyMessage": "Here are similar leather boots at a more affordable price!"
}

"show me jackets in black or navy" (no context)
{
  "searchMode": "fresh",
  "searchText": "jackets",
  "clipCaption": "a photo of jackets",
  "filters": {
    "color": ["black", "navy"]
  },
  "serpSearchKeywords": "jackets black navy",
  "friendlyMessage": "Here are some jackets in black or navy!"
}

"find nike or adidas sneakers in leather or canvas" (no context)
{
  "searchMode": "fresh",
  "searchText": "sneakers",
  "clipCaption": "a photo of sneakers",
  "filters": {
    "brand": ["nike", "adidas"],
    "material": ["leather", "canvas"]
  },
  "serpSearchKeywords": "nike adidas sneakers leather canvas",
  "friendlyMessage": "Here are some Nike or Adidas sneakers in leather or canvas!"
}

"show me size 10 or 10.5 running shoes" (no context)
{
  "searchMode": "fresh",
  "searchText": "running shoes",
  "clipCaption": "a photo of running shoes",
  "filters": {
    "size": {
      "values": ["10", "10.5"],
      "type": "shoe"
    }
  },
  "serpSearchKeywords": "running shoes size 10",
  "friendlyMessage": "Here are some running shoes in size 10 or 10.5!"
}

"t-shirt size L" (no context)
{
  "searchMode": "fresh",
  "searchText": "t-shirt",
  "clipCaption": "a photo of a t-shirt",
  "filters": {
    "size": {
      "values": ["L"]
    }
  },
  "serpSearchKeywords": "t-shirt size L",
  "friendlyMessage": "Here are some t-shirts in size L!"
}

Return ONLY valid JSON:
{
  "searchMode": "...",
  "userQuery": "${userMessage}",
  "limit": number or null,
  "searchText": "..." or null,
  "clipCaption": "..." or null,
  "filters": {...},
  "serpSearchKeywords": "...",
  "friendlyMessage": "..."
}`;

  try {
    
    const result = await paramLLM.invoke(prompt);

    const responseText = result.content.toString();

    // Parse JSON (handle markdown code blocks)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.error('no json found in llm response');
      throw new Error('No JSON found in LLM response');
    }

    logger.info('Response text: ' + responseText);

    const params = JSON.parse(jsonMatch[0]);

    logger.info('Params: ' + JSON.stringify(params));

    // Ensure required shape alignment with search_products tool schema
    params.searchMode = params.searchMode || 'fresh';
    if (params.limit !== undefined && params.limit !== null) {
      const parsedLimit = Number(params.limit);
      params.limit = Number.isFinite(parsedLimit) ? parsedLimit : undefined;
    }
    // normalize filters container
    if (params.filters && typeof params.filters === 'object') {
      const filters = params.filters;
      const normalizeToArray = (val: any) => {
        if (Array.isArray(val)) return val;
        if (val === undefined || val === null) return undefined;
        return [val];
      };
      filters.brand = normalizeToArray(filters.brand);
      filters.color = normalizeToArray(filters.color);
      filters.material = normalizeToArray(filters.material);
      filters.subcategory = normalizeToArray(filters.subcategory);
      if (filters.price && typeof filters.price === 'object') {
        if (filters.price.min !== undefined) filters.price.min = Number(filters.price.min);
        if (filters.price.max !== undefined) filters.price.max = Number(filters.price.max);
        if (Number.isNaN(filters.price.min)) delete filters.price.min;
        if (Number.isNaN(filters.price.max)) delete filters.price.max;
        if (!filters.price.currency && context.userLocation) {
          filters.price.currency = 'GBP';
        }
      }
      if (filters.size && typeof filters.size === 'object') {
        if (filters.size.values && !Array.isArray(filters.size.values)) {
          filters.size.values = [filters.size.values].filter(Boolean);
        }
      }
      // Remove empty arrays/objects
      if (filters.brand?.length === 0) delete filters.brand;
      if (filters.color?.length === 0) delete filters.color;
      if (filters.material?.length === 0) delete filters.material;
      if (filters.subcategory?.length === 0) delete filters.subcategory;
      if (filters.price && !filters.price.min && !filters.price.max && !filters.price.currency) delete filters.price;
      if (filters.size && (!filters.size.values || filters.size.values.length === 0)) delete filters.size;
      if (Object.keys(filters).length === 0) delete params.filters;
    }

    // Clean up null values to undefined for optional fields
    if (params.limit === null) params.limit = undefined;
    if (params.searchText === null) params.searchText = undefined;
    if (params.clipCaption === null) params.clipCaption = undefined;

    // Ensure userQuery is set
    params.userQuery = userMessage;

    return params;

  } catch (error) {
    requestLogger?.error({
      error: error instanceof Error ? error.message : String(error),
    }, '❌ LLM parameter extraction failed in bypass');
    throw error;
  }
}

/**
 * Create the stylist orchestrator with OpenAI
 */
export async function createStylistOrchestratorOpenAI(
  context: OrchestratorContext,
  requestLogger?: any
) {
  const llm = new ChatOpenAI({
    model: 'gpt-4.1-mini',
    temperature: 0.3, // Balanced for both tool calling and creativity
    maxTokens: 1000,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });

  const askFollowUpQuestionTool = new DynamicStructuredTool({
    name: 'ask_follow_up_question',
    description: `Use this when missing important information or the user is not sure about the item they are looking for after reviewing conversation history. Take the users query and ask a follow-up question to help them narrow down their search.

    Critical information includes: item type (jacket, dress, shoes, etc.) + at least ONE detail (color, style, price, occasion, brand).

    DO NOT use this if:
    - A context product is available (you have product context - search immediately!)
    - You have item type + any detail from conversation history
    - User is greeting or thanking you
    - User is asking for suggestions/advice (use provide_fashion_advice instead!)

    Examples of good follow-up questions:
    - "What type of item are you looking for? Are you looking for a jacket, dress, shoes, etc.?"
    - "What's your budget range?"
    - "Any specific color or style in mind?"`,
    schema: z.object({
      question_text: z.string().describe('The follow-up question to ask. Keep it conversational and specific.'),
    }),
    func: async ({ question_text }: { question_text: string }) => {
      return JSON.stringify({
        type: 'follow_up_question',
        question: question_text,
      });
    },
  });

  const provideFashionAdviceTool = new DynamicStructuredTool({
    name: 'provide_fashion_advice',
    description: `Use when user asks for suggestions, advice, or recommendations about fashion choices.

    Trigger phrases: "suggestions", "recommend", "advice", "what should I", "help me decide", "what do you think"

    Keep responses CONCISE:
    - advice_text: 1-2 short sentences max
    - item: Brief item name (e.g., "Light blue Oxford shirt")
    - reasoning: One short sentence explaining why`,
    schema: z.object({
      advice_text: z.string().describe('Brief intro (1-2 sentences max). E.g., "For a summer wedding, breathable fabrics are key."'),
      suggestions: z.array(z.object({
        item: z.string().describe('Concise item name (e.g., "Light blue Oxford shirt")'),
        reasoning: z.string().describe('One sentence why (e.g., "Classic, breathable, pairs well with any blazer")'),
      })).min(2).max(3).describe('2-3 specific suggestions'),
      follow_up_prompt: z.string().optional().describe('Short follow-up (e.g., "Want me to show you some options?")'),
    }),
    func: async ({ advice_text, suggestions, follow_up_prompt }: {
      advice_text: string;
      suggestions: Array<{ item: string; reasoning: string }>;
      follow_up_prompt?: string
    }) => {
      return JSON.stringify({
        type: 'fashion_advice',
        advice: advice_text,
        suggestions: suggestions,
        followUpPrompt: follow_up_prompt,
      });
    },
  });

  const searchProductsTool = new DynamicStructuredTool({
    name: 'search_products',
    description: `Use this to search for products based on user query. Use it when you have enough information from the user in the conversation history to search for the product they are looking for. This needs to be at least a product category and a detail.

    PRIMARY USE: Fresh searches (e.g., "red dress", "nike shoes", "vintage jacket", "jacket with thermal insulation")

    Use this tool when you have:
    1. Item type (e.g., "jacket", "shoes")
    2. Any detail (color, brand, style, price, fit, or more specific detail

    LIMIT PARSING:
    Always check if user specifies number of results:
    - "show me 30" → limit=30
    - "find 20 items" → limit=20
    - No number mentioned → leave limit undefined
    - Do NOT copy attributes from a context product into filters. Only include a filter (brand, color, material, size, etc.) if the USER explicitly asked for it in this turn. For example if the user didn’t say a brand, leave brand undefined.

    FILTER EXTRACTION:
    - Extract ALL values when user mentions multiple options (e.g., "black or white" → color: ["black", "white"])
    - Common patterns: "X or Y", "X and Y", "X, Y", "either X or Y"
    - brand, color, material, and size.values accept arrays - extract all mentioned values
    - gender and condition are single values (use the most appropriate one if multiple mentioned)
    - For size: extract values array (e.g., "size 10 or 10.5" → size: {values: ["10", "10.5"]})
    - Infer size type from context: shoes → "shoe", S/M/L → "alpha", numeric waist → "numeric"

    PARAMETERS:
    - searchMode: Usually "fresh" (unless user expresses a modification based on a context product e.g., "like this but in red", "similar to this but cheaper")
    - searchText: Full descriptive text of what the user wants
    - clipCaption: "a photo of [searchText]"

    Price filters ALWAYS override any existing price constraints.`,
    schema: z.object({
      searchMode: z.enum(['fresh', 'context_modified', 'context_unchanged']).describe('Type of search. Default to "fresh" for new queries.'),
      //userQuery: z.string().describe('The complete user query'),
      limit: z.number().int().min(1).max(50).optional().describe('Number of results to return. Parse from query (e.g. "show 30" -> 30).'),
      searchText: z.string().describe('Full descriptive text for search (e.g. "vintage brown leather bomber jacket"). If you are not sure about what the item is use the word item (e.g., "black item", "green second hand item"'),
      clipCaption: z.string().optional().describe('CLIP caption format: "a photo of [searchText]"'),
      filters: z.object({
        brand: z.array(z.string()).optional().describe('Array of brand names - extract ALL brands mentioned by the user in the query (e.g., ["nike", "adidas"] for "nike or adidas")'),
        category: z.string().optional(),
        subcategory: z.array(z.string()).optional().describe('Array of subcategories - extract ALL subcategories mentioned by the user in the query (e.g., ["jacket", "coat"] for "jacket or coat")'),
        color: z.array(z.string()).optional().describe('Array of colors - extract ALL colors mentioned by the user in the query (e.g., ["black", "white"] for "black or white")'),
        material: z.array(z.string()).optional().describe('Array of materials - extract ALL materials mentioned by the user in the query (e.g., ["leather", "cotton"] for "leather or cotton")'),
        gender: z.enum(['male', 'female', 'unisex']).optional().describe('Single gender value'),
        condition: z.enum(['new', 'used', 'refurbished']).optional().describe('Single condition value'),
        price: z.object({
          min: z.number().optional(),
          max: z.number().optional(),
          currency: z.string().default('GBP').optional()
        }).optional(),
        size: z.object({
          values: z.array(z.string()).describe('Array of size values mentioned (e.g., ["10", "10.5"] or ["M", "L"])'),
          region: z.enum(['US', 'UK', 'EU', 'JP']).optional().describe('Size region if specified (e.g., "UK 9" -> region: UK)'),
          type: z.enum(['alpha', 'numeric', 'shoe']).optional().describe('Size type: alpha (S/M/L), numeric (32/34), or shoe')
        }).optional().describe('Size filter - extract all size values mentioned')
      }).optional().describe('Structured filters - extract multiple values for brand, color, and material when user mentions them'),
      excludeProductIds: z.array(z.string()).optional(),
      serpSearchKeywords: z.string().describe('Keywords for Google Shopping fallback'),
      friendlyMessage: z.string().describe('Friendly response to show before results')
    }),
    func: async (params) => {

      logger.info('Raw search product filters: ' + JSON.stringify(params.filters));

      // Declare contextProduct at the top so it's accessible in catch block
      let contextProduct = null;
      let hasContextProduct = false;

      // Override searchMode to 'fresh' if image is uploaded
      // The LLM sometimes incorrectly chooses 'context_modified' when user says "similar to this image"
      // but actually uploaded a NEW image (not referencing a context product)
      if (context.imageUrl && params.searchMode !== 'fresh') {
        params.searchMode = 'fresh';
      }

      try {
        // Determine context product if needed
        let searchInput: SearchInput = {};

        if (params.searchMode !== 'fresh') {
          // We need context - check page context first, then selected product
          const contextProductId = context.pageContext?.productId;

          if (contextProductId) {
            contextProduct = await fetchContextProduct(contextProductId);
            hasContextProduct = !!contextProduct;

            if (!contextProduct) {
              throw new Error(`Context product ${contextProductId} not found`);
            }
          }
        }

        logger.info('1. Param filters: ' + JSON.stringify(params.filters));

        // Validate + normalize params now that we know if context exists
        const { normalized, issues } = validateAndNormalizeSearchParams(
          params,
          context,
          hasContextProduct,
          params.searchText || params.userQuery
        );
        params = normalized;

        logger.info('2. Normalized filters: ' + JSON.stringify(params.filters));

        if (issues.includes('missing_search_text') || issues.includes('missing_context_for_context_mode')) {
          throw new Error(`malformed_params:${issues.join(',')}`);
        }

        // Set up search input based on mode
        if (params.searchMode === 'fresh') {
          searchInput = {
            userText: params.searchText || params.userQuery,
            userImage: context.imageUrl // If user uploaded an image
          };
        } else if (params.searchMode === 'context_modified' && contextProduct) {
          searchInput = {
            contextProduct: {
              searchText: contextProduct.search_text,
              embedding_text_semantic: contextProduct.embedding_text_semantic,
              embedding_image: contextProduct.embedding_image
            },
            modifiedSearchText: params.searchText,
            modifiedClipCaption: params.clipCaption
          };
        } else if (params.searchMode === 'context_unchanged' && contextProduct) {
          // For context_unchanged, we ONLY use existing embeddings - no new text generation
          // Validate that LLM didn't accidentally provide searchText/clipCaption

          searchInput = {
            contextProduct: {
              searchText: contextProduct.search_text,
              embedding_text_semantic: contextProduct.embedding_text_semantic,
              embedding_image: contextProduct.embedding_image
            }
            // Explicitly NOT setting modifiedSearchText or modifiedClipCaption
          };
        }

        // Determine search strategy
        const searchStrategy = await determineSearchStrategy(searchInput);


        logger.info('Unnormalized filters: ' + JSON.stringify(params.filters));

        // Normalize filters before search (pass user location for size region inference)
        const normalizedFilters = normalizeFilters(params.filters, context.userLocation);

        logger.info('Normalized filters: ' + JSON.stringify(normalizedFilters));

        // A context search should return alternatives, not the selected item itself.
        const allExcludedIds = [
          ...(params.excludeProductIds || []),
          ...(context.excludeProductIds || []),
          ...(contextProduct && params.searchMode !== 'fresh' ? [String(contextProduct.id)] : [])
        ];

        const searchResults = await performManagedSearch(
          searchStrategy,
          params.limit || context.topK || 10,
          allExcludedIds.length > 0 ? allExcludedIds : undefined,
          normalizedFilters
        );

        // Enrich with offers
        const enrichedResults = await enrichWithBestOffers(
          searchResults,
          normalizedFilters || {},
          requestLogger
        );

        // If we have a context product and didn't get explicit keywords, generate them
        let finalSearchKeywords = params.serpSearchKeywords;
        if (!finalSearchKeywords && contextProduct && params.searchMode !== 'fresh') {
          const keywords: string[] = [];

          // For modified searches, use the modified searchText as keywords
          if (params.searchMode === 'context_modified' && params.searchText) {
            // Use the LLM-generated searchText as base keywords
            keywords.push(params.searchText);
          } else {
            // For unchanged context, build keywords from context product
            if (contextProduct.brand) keywords.push(contextProduct.brand);

            if (contextProduct.sub_category) {
              keywords.push(contextProduct.sub_category);
            } else if (contextProduct.category) {
              keywords.push(contextProduct.category);
            }

            if (contextProduct.color) keywords.push(contextProduct.color);
            if (contextProduct.primary_material) keywords.push(contextProduct.primary_material);
          }

          finalSearchKeywords = keywords.join(' ');
        }

        return JSON.stringify({
          type: 'search_results',
          results: enrichedResults,
          message: params.friendlyMessage,
          searchKeywords: finalSearchKeywords,
          filters: params.filters,
          limit: params.limit,
          totalFound: enrichedResults.length,
          searchStrategy: searchStrategy.strategy
        });

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;

        requestLogger?.error({
          error: errorMessage,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorStack: errorStack,
          searchMode: params.searchMode,
          hasSearchText: !!params.searchText,
          hasClipCaption: !!params.clipCaption,
          hasContextProduct: !!contextProduct,
          contextProductId: contextProduct?.id,
          userQuery: params.userQuery,
        }, 'Search products tool failed');

        throw error;
      }
    },
  });

  // Bind tools to the model
  const llmWithTools = llm.bindTools([askFollowUpQuestionTool, provideFashionAdviceTool, searchProductsTool]);

  return { llmWithTools, tools: [askFollowUpQuestionTool, provideFashionAdviceTool, searchProductsTool] };
}

/**
 * Execute the orchestrator
 */
export async function executeOrchestratorOpenAI(
  userMessage: string,
  conversationHistory: ConversationMessage[],
  context: OrchestratorContext,
  requestLogger?: any,
  traceId?: string,
  selectedProductId?: string // Can be from web/extension selected product
): Promise<ToolCallResult> {
  try {
    const hasPageContext = !!context.pageContext?.productId;
    const hasSelectedProduct = !!selectedProductId;

    // Fetch context product details upfront if available
    let contextProductDetails = null;
    const contextProductId = context.pageContext?.productId || selectedProductId;

    if (contextProductId) {
      contextProductDetails = await fetchContextProduct(contextProductId);
    }

    // Unify "context product id" into the context object used by tools.
    // The `search_products` tool currently reads context from `context.pageContext.productId`.
    // When a user selects a product (selectedProductId) without being on a product page,
    // we still want the tool to be able to fetch the context product.
    const contextForTools: OrchestratorContext = contextProductId
      ? {
          ...context,
          pageContext: {
            ...(context.pageContext || {}),
            productId: contextProductId,
          },
        }
      : context;

    // Get appropriate system prompt
    const systemPrompt = getSystemPrompt(hasPageContext, hasSelectedProduct, contextProductDetails);

    // Create orchestrator with context
    const { llmWithTools, tools } = await createStylistOrchestratorOpenAI(contextForTools, requestLogger);

    // 1. Prepare messages
    // Build complete system prompt with all context information
    let completeSystemPrompt = systemPrompt;

    if (context.imageUrl) {
      completeSystemPrompt += `\n\n🖼️ IMAGE UPLOADED: User has uploaded an image for visual search.
CRITICAL: ALWAYS use searchMode="fresh" when user uploads an image, even if they say "similar to this image".
The phrase "this image" refers to the uploaded image, NOT a context product.

For searchText and clipCaption:
- Image only (no specific text) → Leave undefined
- Image + descriptive text (e.g., "brown boots") → Provide searchText and clipCaption
- Image + price filter (e.g., "under £300") → Leave undefined, only set price filter

EXAMPLES:
✓ "Show me something similar to this image but under £300" → searchMode="fresh", searchText=undefined, clipCaption=undefined, filters.price.max=300
✓ "show me 30 products similar to this" → searchMode="fresh", limit=30, searchText=undefined, clipCaption=undefined
✓ "brown leather boots" + image → searchMode="fresh", searchText="brown leather boots", clipCaption="a photo of brown leather boots"
✗ NEVER use searchMode="context_modified" when image is uploaded

The backend will automatically use the uploaded image for visual similarity search.`;
    }

    const messages: BaseMessage[] = [
      new SystemMessage(completeSystemPrompt)
    ];

    // History
    conversationHistory.forEach(msg => {
      if (msg.role === 'user') {
        messages.push(new HumanMessage(msg.content));
      } else {
        messages.push(new AIMessage(msg.content));
      }
    });

    // Synthesize search intent for conversation continuity
    // This helps the LLM understand cumulative refinements (e.g., "90s shirt" -> "more white")
    // Also extracts user-stated filters (NOT from context product)
    let synthesizedIntent: SynthesizedIntent = { searchText: userMessage, userFilters: {} };
    if (conversationHistory.length > 0) {
      synthesizedIntent = await synthesizeSearchIntent(
        userMessage,
        conversationHistory,
        contextProductDetails,
        requestLogger
      );
    }
    const synthesizedQuery = synthesizedIntent.searchText;
    const userFilters = synthesizedIntent.userFilters;

    // Current message - use synthesized query if different, otherwise original
    // Include original in parentheses for context if synthesized
    const currentMessage = synthesizedQuery !== userMessage
      ? `${synthesizedQuery} (user said: "${userMessage}")`
      : userMessage;
    messages.push(new HumanMessage(currentMessage));

    // 2. Check if we can bypass LLM tool selection and go directly to search
    // If user uploaded an image OR has a context product, we have enough info to search
    // BUT: Don't bypass if user is asking for suggestions/advice
    const hasImageOrContext = !!context.imageUrl || !!contextProductId;

    // Detect if user is asking for advice/suggestions (should NOT bypass in this case)
    // const advicePatterns = [
    //   /\b(do you have|any|got any|have any)\s*(suggestions?|advice|recommendations?|tips?)\b/i,
    //   /\bwhat (would you|do you|should I)\s*(recommend|suggest|think|advise)\b/i,
    //   /\bhelp me (decide|choose|pick)\b/i,
    //   /\bwhat should I (look for|get|go for|choose)\b/i,
    //   /\bany ideas\b/i,
    //   /\bwhat('?s| is| are) (the )?best\b/i,
    //   /\bcan you (suggest|recommend|help)\b/i,
    //   /\byour (opinion|thoughts|advice)\b/i,
    // ];
    // const isAskingForAdvice = advicePatterns.some(pattern => pattern.test(userMessage));

    // if (hasImageOrContext && !isAskingForAdvice) {

    if (hasImageOrContext) {
      const searchTool = tools.find(t => t.name === 'search_products')!;

      try {
        // Use LLM to extract all parameters with full schema
        // synthesizedQuery already contains the combined intent from conversation history
        const searchParams = await generateSearchParamsWithLLM(
          synthesizedQuery,
          contextForTools,
          contextProductDetails,
          requestLogger
        );

        // The UI's explicit action must keep the selected product's embeddings.
        // History synthesis can otherwise turn it into a fresh text search.
        if (contextProductDetails && /^more like this[.!?]?$/i.test(userMessage.trim())) {
          searchParams.searchMode = 'context_unchanged';
          delete searchParams.searchText;
          delete searchParams.clipCaption;
        }

        // Merge filters: userFilters (from synthesizeSearchIntent) take priority as these are
        // explicitly stated by the user. LLM-extracted filters are kept as fallback for cases
        // where the synthesizeSearchIntent didn't extract them (e.g., price constraints).
        // This ensures "similar items under £50" keeps the price filter.
        if (Object.keys(userFilters).length > 0) {
          // User has explicit filters from synthesis - merge with LLM filters (user takes priority)
          searchParams.filters = { ...searchParams.filters, ...userFilters };
        }
        // If userFilters is empty, keep the LLM-extracted filters as-is
        // (the LLM prompt now instructs to only extract user-stated filters, not context product attributes)

        const { normalized: validatedParams, issues } = validateAndNormalizeSearchParams(
          searchParams,
          contextForTools,
          !!contextProductDetails,
          synthesizedQuery
        );

        if (issues.includes('missing_search_text')) {
          const question = buildFollowUpQuestion(issues);
          return {
            toolName: 'ask_follow_up_question',
            result: {
              type: 'follow_up_question',
              question,
            },
            shouldContinue: false,
          };
        }

        // Execute search with LLM-extracted parameters
        logger.info('Invoking search_products tool with validated params: ' + JSON.stringify(validatedParams));
        const toolResult = await searchTool.func(validatedParams);
        const parsedResult = JSON.parse(toolResult);

        return {
          toolName: 'search_products',
          result: parsedResult,
          shouldContinue: false,
        };

      } catch (error) {
        requestLogger?.error({
          error: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        }, '❌ Bypass failed, falling back to full LLM tool-calling flow');
        // Fall through to full LLM invocation
      }
    }

    // 3. Invoke LLM (if not bypassed or if bypass failed)
    const result = await llmWithTools.invoke(messages);

    // 4. Handle Tool Calls
    if (result.tool_calls && result.tool_calls.length > 0) {
      const toolCall = result.tool_calls[0];

      if (toolCall.name === 'ask_follow_up_question') {
        const args = toolCall.args as { question_text: string };

        return {
          toolName: 'ask_follow_up_question',
          result: {
            type: 'follow_up_question',
            question: args.question_text,
          },
          shouldContinue: false,
        };
      }

      if (toolCall.name === 'provide_fashion_advice') {
        const args = toolCall.args as {
          advice_text: string;
          suggestions: Array<{ item: string; reasoning: string }>;
          follow_up_prompt?: string;
        };

        return {
          toolName: 'provide_fashion_advice',
          result: {
            type: 'fashion_advice',
            advice: args.advice_text,
            suggestions: args.suggestions,
            followUpPrompt: args.follow_up_prompt,
          },
          shouldContinue: false,
        };
      }

      if (toolCall.name === 'search_products') {
        try {
          const mergedArgs = {
            ...toolCall.args,
            userQuery: (toolCall.args as any).userQuery || synthesizedQuery || userMessage,
          };
          const { normalized: validatedParams, issues } = validateAndNormalizeSearchParams(
            mergedArgs as any,
            context,
            !!contextProductDetails,
            synthesizedQuery || userMessage
          );
          if (issues.includes('missing_search_text')) {
            const question = buildFollowUpQuestion(issues);
            return {
              toolName: 'ask_follow_up_question',
              result: {
                type: 'follow_up_question',
                question,
              },
              shouldContinue: false,
            };
          }

          const searchTool = tools.find(t => t.name === 'search_products')!;
          const toolResult = await searchTool.func(validatedParams as any); // Type cast for LangChain compatibility
          const parsedResult = JSON.parse(toolResult);

          return {
            toolName: 'search_products',
            result: parsedResult,
            shouldContinue: false,
          };
        } catch (toolError) {
          const errMsg = toolError instanceof Error ? toolError.message : String(toolError);
          requestLogger?.error({
            error: errMsg,
            errorStack: toolError instanceof Error ? toolError.stack : undefined,
            toolArgs: toolCall.args,
          }, '❌ search_products tool execution failed');
          throw toolError;
        }
      }
    }

    // 4. Handle Text Response (Fallback if no tool called)
    // This should rarely happen with the improved prompting
    return {
      toolName: 'generate_chat_response',
      result: {
        type: 'chat_response',
        message: result.content.toString() || "I can help you find what you're looking for! Could you tell me what type of item you're interested in?",
      },
      shouldContinue: false,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // const errorStack = error instanceof Error ? error.stack : undefined;

    return {
      toolName: 'error',
      result: {
        type: 'error',
        message: "I'm having trouble connecting right now. Please try again.",
        debug: errorMessage
      },
      shouldContinue: false
    };
  }
}
