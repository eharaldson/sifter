import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { resolveRoutes } from '../../src/routes/resolve';
import * as resolveModule from '../../src/match/resolve';

// Mock the resolve module
vi.mock('../../src/match/resolve', () => ({
  resolveProduct: vi.fn(),
}));

// Mock the normalize module
vi.mock('../../src/match/normalize', () => ({
  normalizeExtracted: vi.fn((data) => data),
  extractDomain: vi.fn((domain) => domain),
}));

// Mock the log module
vi.mock('../../src/log', () => ({
  createRequestLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
  })),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

describe('Resolve Routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(resolveRoutes);
    vi.clearAllMocks();
  });

  describe('POST /resolve', () => {
    const validPayload = {
      retailer_domain: 'example.com',
      page_url: 'https://example.com/product/123',
      extracted: {
        title: 'Test Product',
        brand: 'Test Brand',
        price: 99.99,
        currency: 'USD',
        images: ['https://example.com/image.jpg'],
      },
    };

    it('should resolve product successfully', async () => {
      const mockResult = {
        product_id: 123,
        offer_id: 456,
        created: false,
        matched_via: 'trgm+embedding',
        scores: { trgm: 0.55, cosine: 0.87 },
        retailer_id: 1,
      };

      vi.mocked(resolveModule.resolveProduct).mockResolvedValueOnce(mockResult);

      const response = await app.inject({
        method: 'POST',
        url: '/resolve',
        payload: validPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toMatchObject({
        product_id: 123,
        offer_id: 456,
        created: false,
        matched_via: 'trgm+embedding',
        scores: { trgm: 0.55, cosine: 0.87 },
      });
    });

    it('should create new product when no match found', async () => {
      const mockResult = {
        product_id: 789,
        offer_id: 101,
        created: true,
        matched_via: 'new',
        scores: {},
        retailer_id: 1,
      };

      vi.mocked(resolveModule.resolveProduct).mockResolvedValueOnce(mockResult);

      const response = await app.inject({
        method: 'POST',
        url: '/resolve',
        payload: validPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.created).toBe(true);
      expect(body.matched_via).toBe('new');
    });

    it('should return 400 for missing required fields', async () => {
      const invalidPayload = {
        retailer_domain: 'example.com',
        // Missing page_url and extracted
      };

      const response = await app.inject({
        method: 'POST',
        url: '/resolve',
        payload: invalidPayload,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 for invalid URL format', async () => {
      const invalidPayload = {
        ...validPayload,
        page_url: 'not-a-valid-url',
      };

      const response = await app.inject({
        method: 'POST',
        url: '/resolve',
        payload: invalidPayload,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 for invalid price', async () => {
      const invalidPayload = {
        ...validPayload,
        extracted: {
          ...validPayload.extracted,
          price: -10, // Negative price
        },
      };

      const response = await app.inject({
        method: 'POST',
        url: '/resolve',
        payload: invalidPayload,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Validation failed');
    });

    it('should return 400 for invalid currency code', async () => {
      const invalidPayload = {
        ...validPayload,
        extracted: {
          ...validPayload.extracted,
          currency: 'INVALID', // Not 3 characters
        },
      };

      const response = await app.inject({
        method: 'POST',
        url: '/resolve',
        payload: invalidPayload,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Validation failed');
    });

    it('should handle optional fields correctly', async () => {
      const payloadWithOptionals = {
        ...validPayload,
        extracted: {
          ...validPayload.extracted,
          description: 'Product description',
          originalPrice: 129.99,
          condition: 'new' as const,
          color: 'Blue',
          material: 'Cotton',
          gtin: '1234567890123',
          mpn: 'TEST-MPN-123',
          sku: 'TEST-SKU-456',
        },
      };

      const mockResult = {
        product_id: 123,
        offer_id: 456,
        created: false,
        matched_via: 'gtin',
        scores: { gtin: 1.0 },
        retailer_id: 1,
      };

      vi.mocked(resolveModule.resolveProduct).mockResolvedValueOnce(mockResult);

      const response = await app.inject({
        method: 'POST',
        url: '/resolve',
        payload: payloadWithOptionals,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.matched_via).toBe('gtin');
    });

    it('should handle database errors gracefully', async () => {
      vi.mocked(resolveModule.resolveProduct).mockRejectedValueOnce(
        new Error('Database connection failed')
      );

      const response = await app.inject({
        method: 'POST',
        url: '/resolve',
        payload: validPayload,
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Internal server error');
      expect(body.request_id).toBe('test-request-id');
    });

    it('should validate condition enum correctly', async () => {
      const invalidPayload = {
        ...validPayload,
        extracted: {
          ...validPayload.extracted,
          condition: 'invalid_condition',
        },
      };

      const response = await app.inject({
        method: 'POST',
        url: '/resolve',
        payload: invalidPayload,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Validation failed');
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });
  });
});
