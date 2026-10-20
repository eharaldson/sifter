import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { query } from '../../src/db';

describe('Color-based Product Separation Integration Tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clean up test data
    await query('DELETE FROM offers WHERE retailer_id IN (SELECT id FROM retailers WHERE domain LIKE $1)', ['test-%']);
    await query('DELETE FROM products WHERE title LIKE $1', ['Test Product%']);
    await query('DELETE FROM retailers WHERE domain LIKE $1', ['test-%']);
  });

  it('should create separate products for different colors', async () => {
    const baseProduct = {
      title: 'Test Product Nike Air Max',
      brand: 'Nike',
      description: 'Classic sneaker',
      price: 120.00,
      currency: 'USD',
      images: ['https://example.com/image.jpg']
    };

    // First request - red product
    const redResponse = await app.inject({
      method: 'POST',
      url: '/api/resolve',
      payload: {
        retailerDomain: 'test-store1.com',
        pageUrl: 'https://test-store1.com/product/1',
        extracted: {
          ...baseProduct,
          color: 'Red'
        }
      }
    });

    expect(redResponse.statusCode).toBe(200);
    const redResult = JSON.parse(redResponse.body);
    expect(redResult.created).toBe(true);

    // Second request - blue product (should create new product)
    const blueResponse = await app.inject({
      method: 'POST',
      url: '/api/resolve',
      payload: {
        retailerDomain: 'test-store2.com',
        pageUrl: 'https://test-store2.com/product/1',
        extracted: {
          ...baseProduct,
          color: 'Blue'
        }
      }
    });

    expect(blueResponse.statusCode).toBe(200);
    const blueResult = JSON.parse(blueResponse.body);
    expect(blueResult.created).toBe(true);
    expect(blueResult.product_id).not.toBe(redResult.product_id);

    // Verify products exist in database with correct colors
    const products = await query(
      'SELECT id, title, color FROM products WHERE title LIKE $1 ORDER BY id',
      ['Test Product%']
    );
    
    expect(products.rows).toHaveLength(2);
    expect(products.rows[0].color).toBe('Red');
    expect(products.rows[1].color).toBe('Blue');
  });

  it('should match products with same color', async () => {
    const baseProduct = {
      title: 'Test Product Adidas Shoes',
      brand: 'Adidas',
      description: 'Running shoes',
      price: 100.00,
      currency: 'USD',
      images: ['https://example.com/image.jpg']
    };

    // First request - green product
    const firstResponse = await app.inject({
      method: 'POST',
      url: '/api/resolve',
      payload: {
        retailerDomain: 'test-store1.com',
        pageUrl: 'https://test-store1.com/product/2',
        extracted: {
          ...baseProduct,
          color: 'Green'
        }
      }
    });

    expect(firstResponse.statusCode).toBe(200);
    const firstResult = JSON.parse(firstResponse.body);
    expect(firstResult.created).toBe(true);

    // Second request - same green product from different retailer (should match)
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/api/resolve',
      payload: {
        retailerDomain: 'test-store2.com',
        pageUrl: 'https://test-store2.com/product/2',
        extracted: {
          ...baseProduct,
          color: 'Green'
        }
      }
    });

    expect(secondResponse.statusCode).toBe(200);
    const secondResult = JSON.parse(secondResponse.body);
    expect(secondResult.created).toBe(false);
    expect(secondResult.product_id).toBe(firstResult.product_id);
    expect(secondResult.matched_via).toContain('trgm');
  });

  it('should allow matching when one product has missing color', async () => {
    const baseProduct = {
      title: 'Test Product Samsung Phone',
      brand: 'Samsung',
      description: 'Smartphone',
      price: 800.00,
      currency: 'USD',
      images: ['https://example.com/image.jpg']
    };

    // First request - no color specified
    const firstResponse = await app.inject({
      method: 'POST',
      url: '/api/resolve',
      payload: {
        retailerDomain: 'test-store1.com',
        pageUrl: 'https://test-store1.com/product/3',
        extracted: baseProduct
      }
    });

    expect(firstResponse.statusCode).toBe(200);
    const firstResult = JSON.parse(firstResponse.body);
    expect(firstResult.created).toBe(true);

    // Second request - with color specified (should match with lower confidence)
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/api/resolve',
      payload: {
        retailerDomain: 'test-store2.com',
        pageUrl: 'https://test-store2.com/product/3',
        extracted: {
          ...baseProduct,
          color: 'Black'
        }
      }
    });

    expect(secondResponse.statusCode).toBe(200);
    const secondResult = JSON.parse(secondResponse.body);
    expect(secondResult.created).toBe(false);
    expect(secondResult.product_id).toBe(firstResult.product_id);
    expect(secondResult.matched_via).toContain('color-missing');
  });

  it('should handle case-insensitive color matching', async () => {
    const baseProduct = {
      title: 'Test Product Apple iPhone',
      brand: 'Apple',
      description: 'Smartphone',
      price: 999.00,
      currency: 'USD',
      images: ['https://example.com/image.jpg']
    };

    // First request - lowercase color
    const firstResponse = await app.inject({
      method: 'POST',
      url: '/api/resolve',
      payload: {
        retailerDomain: 'test-store1.com',
        pageUrl: 'https://test-store1.com/product/4',
        extracted: {
          ...baseProduct,
          color: 'white'
        }
      }
    });

    expect(firstResponse.statusCode).toBe(200);
    const firstResult = JSON.parse(firstResponse.body);
    expect(firstResult.created).toBe(true);

    // Second request - uppercase color (should match)
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/api/resolve',
      payload: {
        retailerDomain: 'test-store2.com',
        pageUrl: 'https://test-store2.com/product/4',
        extracted: {
          ...baseProduct,
          color: 'WHITE'
        }
      }
    });

    expect(secondResponse.statusCode).toBe(200);
    const secondResult = JSON.parse(secondResponse.body);
    expect(secondResult.created).toBe(false);
    expect(secondResult.product_id).toBe(firstResult.product_id);
  });

  it('should reject matches for conflicting colors even with high similarity', async () => {
    const baseProduct = {
      title: 'Test Product Exact Same Title Brand Model',
      brand: 'TestBrand',
      description: 'Identical description for high similarity',
      price: 50.00,
      currency: 'USD',
      images: ['https://example.com/same-image.jpg'],
      gtin: '1234567890123'
    };

    // First request - red product
    const redResponse = await app.inject({
      method: 'POST',
      url: '/api/resolve',
      payload: {
        retailerDomain: 'test-store1.com',
        pageUrl: 'https://test-store1.com/product/5',
        extracted: {
          ...baseProduct,
          color: 'Red'
        }
      }
    });

    expect(redResponse.statusCode).toBe(200);
    const redResult = JSON.parse(redResponse.body);
    expect(redResult.created).toBe(true);

    // Second request - yellow product with identical everything else
    const yellowResponse = await app.inject({
      method: 'POST',
      url: '/api/resolve',
      payload: {
        retailerDomain: 'test-store2.com',
        pageUrl: 'https://test-store2.com/product/5',
        extracted: {
          ...baseProduct,
          color: 'Yellow'
        }
      }
    });

    expect(yellowResponse.statusCode).toBe(200);
    const yellowResult = JSON.parse(yellowResponse.body);
    expect(yellowResult.created).toBe(true);
    expect(yellowResult.product_id).not.toBe(redResult.product_id);
    expect(yellowResult.matched_via).toContain('color-conflict');

    // Verify two separate products were created
    const products = await query(
      'SELECT id, color FROM products WHERE title = $1 ORDER BY id',
      ['Test Product Exact Same Title Brand Model']
    );
    
    expect(products.rows).toHaveLength(2);
    expect(products.rows[0].color).toBe('Red');
    expect(products.rows[1].color).toBe('Yellow');
  });
});
