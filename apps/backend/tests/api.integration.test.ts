import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { resolveRoutes } from '../src/routes/resolve';
import { offersRoutes } from '../src/routes/offers';
import { similarRoutes } from '../src/routes/similar';

// Mock the database module
vi.mock('../src/db', () => ({
  query: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

// Mock the resolve module
vi.mock('../src/match/resolve', () => ({
  resolveProduct: vi.fn(),
}));

// Mock the normalize module
vi.mock('../src/match/normalize', () => ({
  normalizeExtracted: vi.fn((data) => data),
  extractDomain: vi.fn((domain) => domain),
}));

// Mock the log module
vi.mock('../src/log', () => ({
  createRequestLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
  })),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

describe('API integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    
    // Register all routes
    await app.register(resolveRoutes, { prefix: '/api' });
    await app.register(offersRoutes, { prefix: '/api' });
    await app.register(similarRoutes, { prefix: '/api' });
    
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/resolve', () => {
    it('should resolve a valid product request', async () => {
      const { resolveProduct } = await import('../src/match/resolve');
      vi.mocked(resolveProduct).mockResolvedValueOnce({
        product_id: 123,
        offer_id: 456,
        created: true,
        matched_via: 'new',
        scores: {},
        retailer_id: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/resolve',
        payload: {
          retailer_domain: 'example.com',
          page_url: 'https://example.com/product/123',
          extracted: {
            title: 'Nike Air Max 90',
            brand: 'Nike',
            price: 99.99,
            currency: 'USD',
            color: 'Black',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      
      expect(result).toHaveProperty('product_id');
      expect(result).toHaveProperty('offer_id');
      expect(result).toHaveProperty('created');
      expect(result).toHaveProperty('matched_via');
      expect(result).toHaveProperty('scores');
      
      expect(typeof result.product_id).toBe('number');
      expect(typeof result.offer_id).toBe('number');
      expect(typeof result.created).toBe('boolean');
    });

    it('should return 400 for invalid payload', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/resolve',
        payload: {
          retailer_domain: 'example.com',
          // Missing required fields
        },
      });

      expect(response.statusCode).toBe(400);
      const result = JSON.parse(response.payload);
      expect(result).toHaveProperty('error');
    });

    it('should handle missing required fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/resolve',
        payload: {
          // Missing all required fields
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should be idempotent for same URL', async () => {
      const { resolveProduct } = await import('../src/match/resolve');
      const mockResult = {
        product_id: 123,
        offer_id: 456,
        created: false,
        matched_via: 'offer_url',
        scores: {},
        retailer_id: 1,
      };
      
      vi.mocked(resolveProduct).mockResolvedValue(mockResult);

      const payload = {
        retailer_domain: 'example.com',
        page_url: 'https://example.com/product/same-url',
        extracted: {
          title: 'Test Product',
          brand: 'TestBrand',
          price: 50.0,
          currency: 'USD',
        },
      };

      const response1 = await app.inject({
        method: 'POST',
        url: '/api/resolve',
        payload,
      });

      expect(response1.statusCode).toBe(200);
      const result1 = JSON.parse(response1.payload);

      const response2 = await app.inject({
        method: 'POST',
        url: '/api/resolve',
        payload,
      });

      expect(response2.statusCode).toBe(200);
      const result2 = JSON.parse(response2.payload);

      expect(result1.product_id).toBe(result2.product_id);
      expect(result1.offer_id).toBe(result2.offer_id);
    });

    it('should handle price updates for existing offers', async () => {
      const { resolveProduct } = await import('../src/match/resolve');
      vi.mocked(resolveProduct).mockResolvedValueOnce({
        product_id: 123,
        offer_id: 456,
        created: false,
        matched_via: 'offer_url',
        scores: {},
        retailer_id: 1,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/resolve',
        payload: {
          retailer_domain: 'example.com',
          page_url: 'https://example.com/product/price-update',
          extracted: {
            title: 'Test Product',
            brand: 'TestBrand',
            price: 75.0, // Updated price
            currency: 'USD',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      expect(result.created).toBe(false);
    });
  });

  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
      });

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.payload);
      expect(result).toHaveProperty('status', 'ok');
      expect(result).toHaveProperty('timestamp');
    });
  });
});
