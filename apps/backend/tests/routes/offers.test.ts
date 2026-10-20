import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { offersRoutes } from '../../src/routes/offers';
import * as db from '../../src/db';

// Mock the database module
vi.mock('../../src/db', () => ({
  query: vi.fn(),
}));

// Mock the log module
vi.mock('../../src/log', () => ({
  createRequestLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
  })),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

describe('Offers Routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(offersRoutes);
    vi.clearAllMocks();
  });

  describe('GET /search/offers', () => {
    it('should return similar product offers for a valid product', async () => {
      // Mock anchor product check
      vi.mocked(db.query)
        .mockResolvedValueOnce({
          rows: [{ id: 1, title: 'Test Product', brand: 'Test Brand', embedding_text: null }],
        })
        // Mock similar products search
        .mockResolvedValueOnce({
          rows: [
            {
              product_id: 2,
              title: 'Similar Product',
              brand: 'Test Brand',
              image_url: 'https://example.com/image.jpg',
              category: 'Electronics',
              similarity_score: 0.85,
            },
          ],
        })
        // Mock offers for similar products
        .mockResolvedValueOnce({
          rows: [
            {
              product_id: 2,
              price: '99.99',
              currency: 'USD',
              original_price: '129.99',
              url: 'https://example.com/product',
              affiliate_url: null,
              in_stock: true,
              condition: 'new',
              last_seen_at: new Date('2024-01-01T00:00:00Z'),
              shipping_cost: null,
              shipping_badges: null,
              country: 'US',
              retailer_name: 'Test Store',
              retailer_domain: 'teststore.com',
            },
          ],
        });

      const response = await app.inject({
        method: 'GET',
        url: '/search/offers?product_id=1',
      });

      expect(response.statusCode).toBe(200);
      const productOffers = JSON.parse(response.body);
      expect(productOffers).toHaveLength(1);
      expect(productOffers[0]).toMatchObject({
        product_id: 2,
        title: 'Similar Product',
        brand: 'Test Brand',
        similarity_score: 0.85,
        offers: [
          {
            retailer: 'Test Store',
            retailer_domain: 'teststore.com',
            price: 99.99,
            currency: 'USD',
            original_price: 129.99,
            url: 'https://example.com/product',
            in_stock: true,
            condition: 'new',
          },
        ],
      });
    });

    it('should return 404 for non-existent product', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
      });

      const response = await app.inject({
        method: 'GET',
        url: '/search/offers?product_id=999',
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Product not found');
    });

    it('should filter offers by country', async () => {
      vi.mocked(db.query)
        .mockResolvedValueOnce({
          rows: [{ id: 1, title: 'Test Product', brand: 'Test Brand', embedding_text: null }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              product_id: 2,
              title: 'Similar Product',
              brand: 'Test Brand',
              image_url: null,
              category: null,
              similarity_score: 0.8,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              product_id: 2,
              price: '79.99',
              currency: 'GBP',
              original_price: null,
              url: 'https://uk-store.com/product',
              affiliate_url: null,
              in_stock: true,
              condition: 'new',
              last_seen_at: new Date('2024-01-01T00:00:00Z'),
              shipping_cost: null,
              shipping_badges: null,
              country: 'GB',
              retailer_name: 'UK Store',
              retailer_domain: 'uk-store.com',
            },
          ],
        });

      const response = await app.inject({
        method: 'GET',
        url: '/search/offers?product_id=1&country=GB',
      });

      expect(response.statusCode).toBe(200);
      const productOffers = JSON.parse(response.body);
      expect(productOffers).toHaveLength(1);
      expect(productOffers[0].offers[0].currency).toBe('GBP');
    });

    it('should return 400 for missing product_id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/search/offers',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Invalid query parameters');
    });

    it('should return 400 for invalid query parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/search/offers?product_id=invalid&country=INVALID&max_price=-10',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Invalid query parameters');
    });

    it('should handle database errors gracefully', async () => {
      vi.mocked(db.query).mockRejectedValueOnce(new Error('Database connection failed'));

      const response = await app.inject({
        method: 'GET',
        url: '/search/offers?product_id=1',
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Internal server error');
    });
  });
});
