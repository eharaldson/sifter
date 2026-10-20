/**
 * Browser-specific exports that don't include Cheerio dependencies
 * This allows the package to be used in browser environments without Cheerio
 */

// Export everything except Cheerio-specific adapters
export * from './types.js';
export * from './utils.js';
export * from './parsers.js';
export * from './scoring.js';

// Export only browser-compatible adapters
export { BrowserDOMAdapter, BrowserElementAdapter } from './adapters.js';

// Export main extraction functions
export { extractProductInfo, extractProductInfoWithMetadata } from './index.js';
