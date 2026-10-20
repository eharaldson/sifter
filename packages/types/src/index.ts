// Product and Offer Types
export interface Product {
  id: string;
  title: string;
  brand?: string;
  description?: string;
  images?: string[];
  color?: string;
  material?: string;
  gtin?: string;
  mpn?: string;
  attributes?: Record<string, any>;
  embedding_text?: number[];
  embedding_image?: number[];
  created_at: Date;
  updated_at: Date;
}

export interface Offer {
  id: string;
  product_id: string;
  retailer_id: string;
  url: string;
  price: number;
  currency: string;
  original_price?: number;
  condition: 'new' | 'used' | 'refurbished';
  availability: 'in_stock' | 'out_of_stock' | 'limited';
  sku?: string;
  created_at: Date;
  updated_at: Date;
}

export interface Retailer {
  id: string;
  name: string;
  domain: string;
  logo_url?: string;
  affiliate_network?: string;
  created_at: Date;
}

// API Request/Response Types
export interface ResolveRequest {
  retailer_domain: string;
  page_url: string;
  extracted: ExtractedProductInfo;
  // Source indicator for prioritization (extension requests get priority)
  source?: 'extension' | 'scraper' | 'api';
  // Whether to wait for embeddings before responding (defaults based on source)
  sync_embeddings?: boolean;
}

export interface MatchResult {
  product_id: number;
  offer_id: number;
  created: boolean;
  matched_via: string;
  scores: Record<string, number>;
  retailer_id: number;
}

// Keep ResolveResponse for backward compatibility if needed elsewhere
export interface ResolveResponse {
  success: boolean;
  product_id: string;
  offer_id: string;
  is_new_product: boolean;
  is_new_offer: boolean;
  request_id: string;
  processing_time_ms: number;
}

// Unified extracted product information interface
// This replaces all the scattered ProductInfo/ExtractedProduct interfaces
export interface ExtractedProductInfo {
  title: string;
  brand?: string | null;
  description?: string | null;
  price: number;
  currency: string;
  originalPrice?: number | null;
  condition?: 'new' | 'used' | 'refurbished' | null;
  images?: string[];
  color?: string | null;
  primaryMaterial?: string | null; // Renamed from 'material' for consistency
  category?: string | null;
  subCategory?: string | null;
  gender?: string | null; // 'male', 'female', or 'unisex'
  gtin?: string | null;
  mpn?: string | null;
  sku?: string | null;
  url?: string; // Optional URL for context
  retailer?: string; // Optional retailer for context
}

// Search Types
export interface SimilarSearchRequest {
  anchor_id?: number;
  text_query?: string;
  filters?: {
    max_price?: number;
    min_price?: number;
    condition?: 'new' | 'used' | 'refurbished';
    brand?: string;
    category?: string;
    country?: string;
    currency?: string;
    in_stock_only?: boolean;
    exclude_product_id?: number;
  };
  limit?: number;
}

// New Similar Products API Types
export interface SimilarProductsRequest {
  anchor_id: number;
  filters?: {
    max_price?: number;
    min_price?: number;
    condition?: 'new' | 'used' | 'refurbished';
    country?: string;
    currency?: string;
    in_stock_only?: boolean;
  };
  limit?: number;
}

export interface SimilarProductsResponse {
  results: Array<{
    product_id: number;
    title: string;
    brand?: string;
    image_url?: string;
    category?: string;
    similarity_score?: number; // Image similarity score (0-1)
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
  }>;
}

export interface SimilarSearchResponse {
  results: Array<{
    product_id: number;
    title: string;
    brand?: string;
    description?: string;
    images?: string[];
    similarity_score: number;
    best_offer?: OfferResponse;
  }>;
  total: number;
  request_id: string;
  processing_time_ms: number;
}

// Alias for backward compatibility
export type SearchResponse = SimilarSearchResponse;

export interface ProductWithOffers extends Product {
  offers: Offer[];
  similarity_score?: number;
}

// Offers API Types - Updated for /search/offers endpoint
export interface OffersRequest {
  product_id: number; // Product ID as query parameter
  country?: string; // ISO 2-letter country code
  condition?: 'new' | 'used' | 'refurbished';
  max_price?: number;
  min_price?: number;
  currency?: string; // ISO 3-letter currency code
  base_currency?: string; // Currency to convert all prices to
  brand?: string;
  category?: string;
  in_stock_only?: boolean;
  current_url?: string; // URL to exclude from results
  limit?: number;
  similarity_threshold?: number; // Minimum similarity score (0-1)
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

export interface SimilarProductOffer {
  product_id: number;
  title: string;
  brand?: string;
  image_url?: string;
  category?: string;
  similarity_score: number;
  offers: OfferDetails[];
}

export interface ProductOffer {
  product_id: number;
  title: string;
  brand?: string;
  image_url?: string;
  category?: string;
  offers: OfferDetails[];
}

// Updated to return single product with offers (or null if no offers found)
export type OffersResponse = ProductOffer | null;

// Keep old OfferResponse for backward compatibility
export interface OfferResponse {
  retailer: string;
  retailer_domain: string;
  price: number;
  currency: string;
  original_price?: number;
  url: string;
  affiliate_url?: string;
  condition: 'new' | 'used' | 'refurbished';
  availability: 'in_stock' | 'out_of_stock' | 'limited';
  last_updated: string;
}

export interface OfferWithRetailer extends Offer {
  retailer: Retailer;
}

// Extension Types
export interface ProductDetectionResult {
  isProduct: boolean;
  confidence: number;
  signals: string[];
}

// Removed duplicate ProductInfo interface - use ExtractedProductInfo instead
// or import ProductInfo from @find/extraction for extraction-specific use cases

// Chat/AI Types
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  context?: {
    current_product?: Product;
    search_results?: ProductWithOffers[];
  };
}

export interface ChatRequest {
  userQuery: string;
  topK?: number;
  pageContext?: {
    productId?: string;
  };
  imageUrl?: string;
  conversationHistory?: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp?: Date;
  }>;
  userLocation?: string; // Country code for SerpAPI
  excludeProductIds?: string[]; // For "show more" functionality
}

export interface ChatParsedQuery {
  freeText: string;
  filters: Record<string, any>;
  limit: number;
  confidence: number;
}

export interface ChatFacets {
  brand?: Array<[string, number]>;
  color?: Array<[string, number]>;
  [key: string]: Array<[string, number]> | undefined;
}

export interface ChatWhyExplanation {
  [productId: string]: string[];
}

export interface ChatResponse {
  type: 'search_results' | 'follow_up_question' | 'chat_response' | 'fashion_advice';
  results?: Array<{
    product_id: number | string; // Can be number (database) or string (SerpAPI)
    title: string;
    brand?: string;
    image_url?: string;
    category?: string;
    similarity_score?: number;
    _source?: 'serpapi' | 'database'; // Metadata to distinguish source
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
  }>;
  message?: string; // For follow-up questions or chat responses
  advice?: string; // For fashion advice responses
  suggestions?: Array<{ item: string; reasoning: string }>; // Fashion suggestions with reasoning
  followUpPrompt?: string; // Optional follow-up prompt after fashion advice
  parsed?: ChatParsedQuery;
  facets?: ChatFacets;
  why?: ChatWhyExplanation;
  relaxedSteps?: string[];
  traceId: string;
  finalImageEmbedding?: number[] | null; // Returned for SerpAPI search if needed
  searchKeywords?: string; // Keywords for SerpAPI search
  parsedQuery?: string; // Parsed query text
  searchFilters?: Record<string, any>; // Filters for SerpAPI
}

export interface SerpSearchRequest {
  imageEmbedding?: number[]; // Optional - can use searchKeywords instead
  searchKeywords?: string; // Keywords for Google Shopping search
  contextSearchText?: string;
  parsedSearchText?: string;
  minPrice?: number;
  maxPrice?: number;
  neededCount?: number;
  filters?: {
    attributes?: {
      condition?: string | null;
    };
  };
  topK?: number;
}

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

// Error Types
export interface APIError {
  error: string;
  details?: any;
  request_id?: string;
  timestamp: Date;
}

// Embedding Job Types
export interface EmbeddingJob {
  product_id: string;
  type: 'text' | 'image' | 'both';
  priority?: number;
}

export interface EmbeddingJobResult {
  product_id: string;
  text_embedding?: number[];
  image_embedding?: number[];
  success: boolean;
  error?: string;
}
