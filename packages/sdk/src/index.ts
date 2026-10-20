import { z } from 'zod';
import {
  ResolveRequest,
  MatchResult,
  SimilarSearchRequest,
  SimilarSearchResponse,
  SimilarProductsRequest,
  SimilarProductsResponse,
  OffersResponse,
  ChatRequest,
  ChatResponse,
  SerpSearchRequest,
  SerpSearchResponse,
  APIError,
} from '@find/types';

// Zod validation schemas
const ResolveRequestSchema = z.object({
  retailer_domain: z.string(),
  page_url: z.string().url(),
  extracted: z.object({
    title: z.string(),
    brand: z.string().optional(),
    description: z.string().optional(),
    price: z.number().positive(),
    currency: z.string().length(3),
    originalPrice: z.number().positive().optional(),
    condition: z.enum(['new', 'used', 'refurbished']).optional(),
    images: z.array(z.string().url()).optional(),
    color: z.string().optional(),
    primaryMaterial: z.string().optional(),
    category: z.string().optional(),
    subCategory: z.string().optional(),
    gtin: z.string().optional(),
    mpn: z.string().optional(),
    sku: z.string().optional(),
  }),
  // Source and sync options for embedding prioritization
  source: z.enum(['extension', 'scraper', 'api']).optional(),
  sync_embeddings: z.boolean().optional(),
});

const SimilarSearchRequestSchema = z.object({
  anchor_id: z.number().optional(),
  text_query: z.string().optional(),
  filters: z.object({
    max_price: z.number().positive().optional(),
    min_price: z.number().positive().optional(),
    condition: z.enum(['new', 'used', 'refurbished']).optional(),
    brand: z.string().optional(),
    category: z.string().optional(),
    subCategory: z.string().optional(),
    primaryMaterial: z.string().optional(),
    country: z.string().length(2).optional(),
    currency: z.string().length(3).optional(),
    in_stock_only: z.boolean().optional(),
    exclude_product_id: z.number().optional(),
  }).optional(),
  limit: z.number().positive().max(100).optional(),
});

const SimilarProductsRequestSchema = z.object({
  anchor_id: z.number().int().positive(),
  filters: z.object({
    max_price: z.number().positive().optional(),
    min_price: z.number().positive().optional(),
    condition: z.enum(['new', 'used', 'refurbished']).default('used'),
    country: z.string().length(2).optional(),
    currency: z.string().length(3).optional(),
    in_stock_only: z.boolean().optional(),
  }).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const ChatRequestSchema = z.object({
  userQuery: z.string().min(1),
  topK: z.number().int().min(1).max(50).optional(),
  pageContext: z.object({
    productId: z.string().optional(),
  }).optional(),
  imageUrl: z.string().optional(), // Allow both URLs and base64 data URLs
  conversationHistory: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    timestamp: z.coerce.date().optional(), // Coerce string to Date (from JSON serialization)
  })).optional(),
  userLocation: z.string().optional(),
  excludeProductIds: z.array(z.string()).optional(),
});

export class FindAPIClient {
  private baseURL: string;
  private apiKey?: string;

  constructor(baseURL: string = 'http://localhost:3001/api', apiKey?: string) {
    this.baseURL = baseURL.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = apiKey;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const startTime = Date.now();
    const response = await fetch(url, {
      ...options,
      headers,
    });

    const duration = Date.now() - startTime;

    if (!response.ok) {
      console.error('[FindAPI SDK] Request failed:', {
        status: response.status,
        statusText: response.statusText,
        url
      });
      
      const error: APIError = await response.json().catch(() => ({
        error: `HTTP ${response.status}: ${response.statusText}`,
        timestamp: new Date(),
      }));
      
      console.error('[FindAPI SDK] Error details:', error);
      throw new Error(error.error || `Request failed with status ${response.status}`);
    }

    const responseData = await response.json();
    
    return responseData;
  }

  /**
   * Resolve a product from extracted information
   */
  async resolve(request: ResolveRequest): Promise<MatchResult> {
    // Validate request with Zod
    const validatedRequest = ResolveRequestSchema.parse(request);
    
    return this.request<MatchResult>('/resolve', {
      method: 'POST',
      body: JSON.stringify(validatedRequest),
    });
  }

  /**
   * Get offers for a specific product
   */
  async getOffers(productId: number, params?: {
    country?: string;
    condition?: 'new' | 'used' | 'refurbished';
    title?: string;
    image_url?: string;
    max_price?: number;
    min_price?: number;
    currency?: string;
    base_currency?: string; // Currency to convert all prices to
    in_stock_only?: boolean;
    current_url?: string;
    limit?: number;
  }): Promise<OffersResponse> {
    
    const queryParams = new URLSearchParams();
    
    // Product ID is now a required query parameter
    queryParams.append('product_id', productId.toString());
    
    if (params?.country) queryParams.append('country', params.country);
    if (params?.condition) queryParams.append('condition', params.condition);
    if (params?.max_price) queryParams.append('max_price', params.max_price.toString());
    if (params?.min_price) queryParams.append('min_price', params.min_price.toString());
    if (params?.currency) queryParams.append('currency', params.currency);
    if (params?.base_currency) queryParams.append('base_currency', params.base_currency);
    if (params?.in_stock_only !== undefined) queryParams.append('in_stock_only', params.in_stock_only.toString());
    if (params?.current_url) queryParams.append('current_url', params.current_url);
    if (params?.limit) queryParams.append('limit', params.limit.toString());

    const queryString = queryParams.toString();
    const endpoint = `/search/offers?${queryString}`;
    
    const result = await this.request<OffersResponse>(endpoint);
    
    return result;
  }

  /**
   * Search for similar products
   */
  async searchSimilar(request: SimilarSearchRequest): Promise<SimilarSearchResponse> {
    // Validate request with Zod
    const validatedRequest = SimilarSearchRequestSchema.parse(request);
    
    return this.request<SimilarSearchResponse>('/similar', {
      method: 'POST',
      body: JSON.stringify(validatedRequest),
    });
  }

  /**
   * Find similar products using embedding similarity
   * Requires 0.7+ cosine similarity in both text and image embeddings
   */
  async getSimilarProducts(request: SimilarProductsRequest): Promise<SimilarProductsResponse> {
    // Validate request with Zod
    const validatedRequest = SimilarProductsRequestSchema.parse(request);
    
    return this.request<SimilarProductsResponse>('/similar', {
      method: 'POST',
      body: JSON.stringify(validatedRequest),
    });
  }

  /**
   * Chat with AI assistant
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    
    // Validate request with Zod
    const validatedRequest = ChatRequestSchema.parse(request);

    
    const result = await this.request<ChatResponse>('/chat', {
      method: 'POST',
      body: JSON.stringify(validatedRequest),
    });
    
    return result;
  }

  /**
   * Search for products using SerpAPI Google Shopping
   */
  async serpSearch(request: SerpSearchRequest): Promise<SerpSearchResponse> {
    return this.request<SerpSearchResponse>('/serp-search', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * Health check
   */
  async health(): Promise<{ status: string; timestamp: string }> {
    return this.request<{ status: string; timestamp: string }>('/health');
  }
}

// Export types for convenience
export * from '@find/types';

// Default client instance
export const findAPI = new FindAPIClient();
