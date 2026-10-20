import { describe, it, expect } from 'vitest';
import { checkColorConsistency } from '../../src/match/resolve';

describe('Color Consistency Checks', () => {
  describe('checkColorConsistency', () => {
    it('should allow match when both colors are the same', () => {
      const result = checkColorConsistency('red', 'red');
      expect(result).toEqual({
        canMatch: true,
        matchType: 'exact'
      });
    });

    it('should allow match when both colors are null', () => {
      const result = checkColorConsistency(null, null);
      expect(result).toEqual({
        canMatch: true,
        matchType: 'exact'
      });
    });

    it('should allow match when both colors are undefined', () => {
      const result = checkColorConsistency(undefined, undefined);
      expect(result).toEqual({
        canMatch: true,
        matchType: 'exact'
      });
    });

    it('should allow match with lower confidence when new color is null', () => {
      const result = checkColorConsistency(null, 'blue');
      expect(result).toEqual({
        canMatch: true,
        matchType: 'missing'
      });
    });

    it('should allow match with lower confidence when existing color is null', () => {
      const result = checkColorConsistency('green', null);
      expect(result).toEqual({
        canMatch: true,
        matchType: 'missing'
      });
    });

    it('should allow match with lower confidence when new color is undefined', () => {
      const result = checkColorConsistency(undefined, 'yellow');
      expect(result).toEqual({
        canMatch: true,
        matchType: 'missing'
      });
    });

    it('should allow match with lower confidence when existing color is undefined', () => {
      const result = checkColorConsistency('purple', undefined);
      expect(result).toEqual({
        canMatch: true,
        matchType: 'missing'
      });
    });

    it('should disallow match when colors are different', () => {
      const result = checkColorConsistency('red', 'blue');
      expect(result).toEqual({
        canMatch: false,
        matchType: 'conflict'
      });
    });

    it('should handle case-insensitive color matching', () => {
      const result = checkColorConsistency('RED', 'red');
      expect(result).toEqual({
        canMatch: true,
        matchType: 'exact'
      });
    });

    it('should handle whitespace in color matching', () => {
      const result = checkColorConsistency(' red ', 'red');
      expect(result).toEqual({
        canMatch: true,
        matchType: 'exact'
      });
    });

    it('should treat empty string as null', () => {
      const result = checkColorConsistency('', 'blue');
      expect(result).toEqual({
        canMatch: true,
        matchType: 'missing'
      });
    });

    it('should treat whitespace-only string as null', () => {
      const result = checkColorConsistency('   ', 'orange');
      expect(result).toEqual({
        canMatch: true,
        matchType: 'missing'
      });
    });

    it('should handle complex color names', () => {
      const result = checkColorConsistency('dark blue', 'light blue');
      expect(result).toEqual({
        canMatch: false,
        matchType: 'conflict'
      });
    });

    it('should handle similar but different colors', () => {
      const result = checkColorConsistency('navy', 'blue');
      expect(result).toEqual({
        canMatch: false,
        matchType: 'conflict'
      });
    });
  });
});
