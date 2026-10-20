import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { query } from '../src/db';
import { resolveProduct } from '../src/match/resolve';
import { normalizeExtracted } from '../src/match/normalize';

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
}));

describe('resolve integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create new product and offer for first-time resolution', async () => {
    const mockResult = {
      product_id: 123,
      offer_id: 456,
      created: true,
      matched_via: 'new',
      scores: {},
      retailer_id: 1,
    };

    vi.mocked(resolveProduct).mockResolvedValue(mockResult);
    vi.mocked(normalizeExtracted).mockReturnValue({
      title: 'Test Product',
      brand: 'TestBrand',
      description: null,
      price: 99.99,
      currency: 'USD',
      originalPrice: null,
      condition: 'new',
      imageUrl: null,
      color: null,
      material: null,
      gtin: null,
      mpn: null,
      sku: null,
    });

    const extracted = {
      title: 'Test Product',
      brand: 'TestBrand',
      price: 99.99,
      currency: 'USD',
    };

    const normalized = normalizeExtracted(extracted);
    const result = await resolveProduct('test-store.com', 'https://test-store.com/product/1', normalized);

    expect(result.created).toBe(true);
    expect(result.matched_via).toBe('new');
    expect(result.product_id).toBe(123);
    expect(result.offer_id).toBe(456);
  });

  it('should return existing offer for same URL', async () => {
    const mockResult1 = {
      product_id: 123,
      offer_id: 456,
      created: true,
      matched_via: 'new',
      scores: {},
      retailer_id: 1,
    };

    const mockResult2 = {
      product_id: 123,
      offer_id: 456,
      created: false,
      matched_via: 'offer_url',
      scores: {},
      retailer_id: 1,
    };

    vi.mocked(resolveProduct)
      .mockResolvedValueOnce(mockResult1)
      .mockResolvedValueOnce(mockResult2);

    const extracted = {
      title: 'Nike Air Max 90',
      brand: 'Nike',
      price: 129.99,
      currency: 'USD',
    };

    const normalized = normalizeExtracted(extracted);
    const url = 'https://test-store.com/product/2';

    const result1 = await resolveProduct('test-store.com', url, normalized);
    expect(result1.created).toBe(true);

    const result2 = await resolveProduct('test-store.com', url, normalized);
    expect(result2.created).toBe(false);
    expect(result2.matched_via).toBe('offer_url');
    expect(result2.offer_id).toBe(result1.offer_id);
  });

  it('should match by GTIN when available', async () => {
    const mockResult = {
      product_id: 789,
      offer_id: 101,
      created: false,
      matched_via: 'gtin',
      scores: {},
      retailer_id: 1,
    };

    vi.mocked(resolveProduct).mockResolvedValue(mockResult);
    vi.mocked(query).mockResolvedValue({ rows: [{ id: 789 }] });

    const extracted = {
      title: 'Nike Air Force 1 White',
      brand: 'Nike',
      price: 90.00,
      currency: 'USD',
      gtin: '123456789012',
    };

    const normalized = normalizeExtracted(extracted);
    const result = await resolveProduct('test-store.com', 'https://test-store.com/product/3', normalized);

    expect(result.created).toBe(false);
    expect(result.matched_via).toBe('gtin');
    expect(result.product_id).toBe(789);
  });

  it('should match by trigram similarity when no strict ID', async () => {
    const mockResult = {
      product_id: 555,
      offer_id: 666,
      created: false,
      matched_via: 'trgm+embedding',
      scores: { trigram: 0.8, embedding: 0.9 },
      retailer_id: 1,
    };

    vi.mocked(resolveProduct).mockResolvedValue(mockResult);

    const extracted = {
      title: 'iPhone 14 Pro Max 256GB',
      brand: 'Apple',
      price: 1099.99,
      currency: 'USD',
    };

    const normalized = normalizeExtracted(extracted);
    const result = await resolveProduct('test-store.com', 'https://test-store.com/product/4', normalized);

    expect(result.created).toBe(false);
    expect(result.matched_via).toBe('trgm+embedding');
  });

  it('should create new product when similarity is too low', async () => {
    const mockResult = {
      product_id: 777,
      offer_id: 888,
      created: true,
      matched_via: 'new',
      scores: {},
      retailer_id: 1,
    };

    vi.mocked(resolveProduct).mockResolvedValue(mockResult);

    const extracted = {
      title: 'MacBook Pro 16-inch',
      brand: 'Apple',
      price: 2499.99,
      currency: 'USD',
    };

    const normalized = normalizeExtracted(extracted);
    const result = await resolveProduct('test-store.com', 'https://test-store.com/product/4', normalized);

    expect(result.created).toBe(true);
    expect(result.matched_via).toBe('new');
  });

  it('should update offer price on re-resolution', async () => {
    const mockResult1 = {
      product_id: 999,
      offer_id: 111,
      created: true,
      matched_via: 'new',
      scores: {},
      retailer_id: 1,
    };

    const mockResult2 = {
      product_id: 999,
      offer_id: 111,
      created: false,
      matched_via: 'offer_url',
      scores: {},
      retailer_id: 1,
    };

    vi.mocked(resolveProduct)
      .mockResolvedValueOnce(mockResult1)
      .mockResolvedValueOnce(mockResult2);

    vi.mocked(query).mockResolvedValue({ rows: [{ price: '45.00' }] });

    const extracted1 = {
      title: 'Test Product Price Update',
      brand: 'TestBrand',
      price: 50.00,
      currency: 'USD',
    };

    const normalized1 = normalizeExtracted(extracted1);
    const url = 'https://test-store.com/product/5';

    const result1 = await resolveProduct('test-store.com', url, normalized1);

    const extracted2 = { ...extracted1, price: 45.00 };
    const normalized2 = normalizeExtracted(extracted2);
    const result2 = await resolveProduct('test-store.com', url, normalized2);

    expect(result2.offer_id).toBe(result1.offer_id);
  });
});
