import { describe, it, expect } from 'vitest';
import {
  normalizeExtracted,
  normalizeTitle,
  normalizeBrand,
  normalizeText,
  normalizeCode,
  normalizeCondition,
  createSearchText,
  extractDomain,
} from '../src/match/normalize';

describe('normalize', () => {
  describe('normalizeTitle', () => {
    it('should remove trademark symbols', () => {
      expect(normalizeTitle('Nike™ Air Max®')).toBe('Nike Air Max');
    });

    it('should remove size indicators', () => {
      expect(normalizeTitle('T-Shirt Size: Large')).toBe('T-Shirt');
      expect(normalizeTitle('Shoes sz 42')).toBe('Shoes');
    });

    it('should remove SKU references', () => {
      expect(normalizeTitle('Product SKU: ABC123')).toBe('Product');
      expect(normalizeTitle('Item: XYZ789 Jacket')).toBe('Jacket');
    });

    it('should normalize whitespace', () => {
      expect(normalizeTitle('  Multiple   Spaces  ')).toBe('Multiple Spaces');
    });
  });

  describe('normalizeBrand', () => {
    it('should lowercase and trim', () => {
      expect(normalizeBrand('  NIKE  ')).toBe('nike');
    });

    it('should remove trademark symbols', () => {
      expect(normalizeBrand('Adidas®')).toBe('adidas');
    });

    it('should return null for empty strings', () => {
      expect(normalizeBrand('')).toBe(null);
      expect(normalizeBrand(null)).toBe(null);
      expect(normalizeBrand(undefined)).toBe(null);
    });
  });

  describe('normalizeCode', () => {
    it('should uppercase and remove special characters', () => {
      expect(normalizeCode('abc-123')).toBe('ABC-123');
      expect(normalizeCode('xyz.456')).toBe('XYZ456');
    });

    it('should return null for empty codes', () => {
      expect(normalizeCode('')).toBe(null);
      expect(normalizeCode(null)).toBe(null);
    });
  });

  describe('normalizeCondition', () => {
    it('should normalize condition values', () => {
      expect(normalizeCondition('used')).toBe('used');
      expect(normalizeCondition('second hand')).toBe('used');
      expect(normalizeCondition('refurbished')).toBe('refurbished');
      expect(normalizeCondition('renewed')).toBe('refurbished');
      expect(normalizeCondition('brand new')).toBe('new');
      expect(normalizeCondition(undefined)).toBe('new');
    });
  });

  describe('normalizeExtracted', () => {
    it('should normalize a complete product', () => {
      const extracted = {
        title: '  Nike™ Air Max Size: 42  ',
        brand: '  NIKE  ',
        description: 'Great shoes',
        price: 99.99,
        currency: 'usd',
        originalPrice: 129.99,
        condition: 'brand new',
        images: ['https://example.com/image1.jpg', 'https://example.com/image2.jpg'],
        color: 'Black',
        material: 'Leather',
        gtin: 'abc-123',
      };

      const result = normalizeExtracted(extracted);

      expect(result).toEqual({
        title: 'Nike Air Max',
        brand: 'nike',
        description: 'Great shoes',
        price: 99.99,
        currency: 'USD',
        originalPrice: 129.99,
        condition: 'new',
        imageUrl: 'https://example.com/image1.jpg',
        color: 'Black',
        material: 'Leather',
        gtin: 'ABC-123',
        mpn: null,
        sku: null,
      });
    });
  });

  describe('createSearchText', () => {
    it('should combine relevant fields', () => {
      const normalized = {
        title: 'Nike Air Max',
        brand: 'nike',
        description: 'Running shoes',
        color: 'Black',
        material: 'Leather',
        price: 99.99,
        currency: 'USD',
        originalPrice: null,
        condition: 'new',
        imageUrl: null,
        gtin: null,
        mpn: null,
        sku: null,
      };

      const result = createSearchText(normalized);
      expect(result).toBe('Nike Air Max nike Black Leather Running shoes');
    });
  });

  describe('extractDomain', () => {
    it('should extract domain from URL', () => {
      expect(extractDomain('https://www.example.com/path')).toBe('example.com');
      expect(extractDomain('http://subdomain.example.com')).toBe('subdomain.example.com');
    });

    it('should handle invalid URLs', () => {
      expect(extractDomain('not-a-url')).toBe('not-a-url');
    });
  });
});
