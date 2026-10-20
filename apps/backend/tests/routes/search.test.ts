import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { similarRoutes } from '../../src/routes/similar';
import * as db from '../../src/db';

// Mock the database module
vi.mock('../../src/db', () => ({
  query: vi.fn(),
}));

// Mock the logger
vi.mock('../../src/log', () => ({
  createRequestLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
  })),
  generateRequestId: vi.fn(() => 'test-request-id'),
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Similar Routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(similarRoutes);
    vi.clearAllMocks();
  });

  describe('POST /similar', () => {
    it('should find similar products using embedding similarity', async () => {
      // Mock anchor product with embeddings
      vi.mocked(db.query)
        .mockResolvedValueOnce({
          rows: [{ 
            id: 1, 
            title: 'Nike Air Max', 
            brand: 'Nike', 
            image_url: 'https://example.com/nike.jpg',
            category: 'Footwear',
            embedding_text_semantic: [0.1, 0.2, 0.3], // Mock embedding
            embedding_image: [0.4, 0.5, 0.6] // Mock embedding
          }],
        })
        // Mock similarity search results
        .mockResolvedValueOnce({
          rows: [
            {
              product_id: 2,
              title: 'Adidas Ultraboost',
              brand: 'Adidas',
              image_url: 'https://example.com/shoe.jpg',
              category: 'Footwear',
              text_similarity: 0.75,
              image_similarity: 0.85,
            },
          ],
        })
        // Mock best offers query
        .mockResolvedValueOnce({
          rows: [
            {
              product_id: 2,
              title: 'Retailer Specific Title',
              image_url: 'https://retailer.com/image.jpg',
              price: '149.99',
              currency: 'USD',
              original_price: '179.99',
              url: 'https://store.com/shoe',
              affiliate_url: null,
              in_stock: true,
              condition: 'new',
              retailer_name: 'Shoe Store',
              retailer_domain: 'store.com',
            },
          ],
        });

      const response = await app.inject({
        method: 'POST',
        url: '/similar',
        payload: {
          anchor_id: 1,
          limit: 10,
        },
      });

      expect(response.statusCode).toBe(200);
      const results = JSON.parse(response.body);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        product_id: 2,
        title: 'Adidas Ultraboost',
        brand: 'Adidas',
        similarity_score: 0.85, // This should be the image_similarity score
        best_offer: {
          retailer: 'Shoe Store',
          retailer_domain: 'store.com',
          title: 'Retailer Specific Title', // Retailer-specific title
          image_url: 'https://retailer.com/image.jpg', // Retailer-specific image
          price: 149.99,
          currency: 'USD',
          original_price: 179.99,
          in_stock: true,
          condition: 'new',
        },
      });
    });

    it('should return 400 for missing anchor_id', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/similar',
        payload: {
          limit: 10,
        },
      });

      expect(response.statusCode).toBe(400);
      const error = JSON.parse(response.body);
      expect(error.error).toBe('Validation failed');
    });

    it('should handle anchor product not found', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/similar',
        payload: {
          anchor_id: 999,
        },
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Internal server error');
    });
  });
});