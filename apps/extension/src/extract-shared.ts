/*
  Product data extraction utilities using shared extraction package.
  This replaces the original extract.ts with shared logic.
*/

import { extractProductInfo as extractShared, BrowserDOMAdapter, ProductInfo, detectCategoryAndSubcategory, detectMaterial } from '@find/extraction';

/**
 * Check if the current page is on an Amazon domain (amazon.com, amazon.co.uk, etc.)
 */
function isAmazonDomain(doc: Document): boolean {
  try {
    const hostname = doc.defaultView?.location?.hostname || '';
    if (!hostname) {
      const url = new URL(doc.baseURI);
      return url.hostname.includes('amazon.');
    }
    return hostname.includes('amazon.');
  } catch {
    return false;
  }
}

/**
 * Extract price from Amazon price element
 * Format: <span class="a-price..."><span class="a-price-symbol">£</span><span class="a-price-whole">36<span class="a-price-decimal">.</span></span><span class="a-price-fraction">80</span></span>
 */
function extractAmazonPrice(doc: Document): { price: number | null; currency: string | null } {
  try {
    // Try to find the price element with class containing "priceToPay"
    const priceElement = doc.querySelector('.a-price.priceToPay, .a-price.aok-align-center.reinventPricePriceToPayMargin.priceToPay');
    if (!priceElement) {
      return { price: null, currency: null };
    }

    // Extract currency symbol
    const symbolElement = priceElement.querySelector('.a-price-symbol');
    const currencySymbol = symbolElement?.textContent?.trim() || '';
    
    // Map currency symbols to currency codes
    const currencyMap: Record<string, string> = {
      '£': 'GBP',
      '$': 'USD',
      '€': 'EUR',
      '¥': 'JPY',
      '₹': 'INR',
      'CA$': 'CAD',
      'A$': 'AUD'
    };
    const currency = currencyMap[currencySymbol] || 'USD';

    // Extract whole and fraction parts
    const wholeElement = priceElement.querySelector('.a-price-whole');
    const fractionElement = priceElement.querySelector('.a-price-fraction');
    
    // Get text content - whole part may contain nested decimal point element
    const wholeText = wholeElement?.textContent?.trim() || '0';
    const fractionText = fractionElement?.textContent?.trim() || '00';
    
    // Remove any non-numeric characters from whole part (handles nested decimal point)
    const whole = wholeText.replace(/[^\d]/g, '');
    // Remove any non-numeric characters from fraction part
    const fraction = fractionText.replace(/[^\d]/g, '');
    
    if (!whole) {
      return { price: null, currency: null };
    }

    // Combine whole and fraction parts to form decimal price
    const priceValue = parseFloat(`${whole}.${fraction || '00'}`);
    
    if (isNaN(priceValue)) {
      return { price: null, currency: null };
    }

    return { price: priceValue, currency };
  } catch (error) {
    return { price: null, currency: null };
  }
}

/**
 * Extract title from Amazon product page
 * Format: <span id="productTitle" class="a-size-large product-title-word-break">Title</span>
 */
function extractAmazonTitle(doc: Document): string | null {
  try {
    const titleElement = doc.getElementById('productTitle');
    if (!titleElement) {
      return null;
    }
    return titleElement.textContent?.trim() || null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract color from Amazon product page
 * Format: <span id="inline-twister-expanded-dimension-text-color_name" class="...">Tan</span>
 */
function extractAmazonColor(doc: Document): string | null {
  try {
    const colorElement = doc.getElementById('inline-twister-expanded-dimension-text-color_name');
    if (!colorElement) {
      return null;
    }
    return colorElement.textContent?.trim() || null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract main product image from Amazon product page
 * Handles multiple formats:
 * - <div id="imgTagWrapperId"><img id="landingImage" src="..."></div>
 * - <div class="imgTagWrapper"><img class="a-dynamic-image" src="..." data-old-hires="..."></div>
 */
function extractAmazonImage(doc: Document): string | null {
  try {
    // Collect ALL potential wrappers. Amazon sometimes keeps a placeholder wrapper
    // while rendering the real image in a different imgTagWrapper.
    const wrappers: Element[] = [];

    const byId = doc.getElementById('imgTagWrapperId');
    if (byId) wrappers.push(byId);

    wrappers.push(...Array.from(doc.querySelectorAll('.imgTagWrapper')));

    // Dedupe (same element may be added twice)
    const uniqueWrappers = Array.from(new Set(wrappers));

    if (uniqueWrappers.length === 0) {
      return null;
    }

    for (let i = 0; i < uniqueWrappers.length; i++) {
      const imgWrapper = uniqueWrappers[i];

      const hasPlaceholder = imgWrapper.querySelector('.placeHolder') !== null;
      const imgs = Array.from(imgWrapper.querySelectorAll('img'));

      // Skip obvious placeholders
      if (hasPlaceholder && imgs.length === 0) {
        continue;
      }

      // Prefer specific image selectors first, then fall back to any <img>
      const candidates: HTMLImageElement[] = [];
      const landing = imgWrapper.querySelector('img#landingImage, img[data-a-image-name="landingImage"]');
      if (landing instanceof HTMLImageElement) candidates.push(landing);
      candidates.push(
        ...imgs.filter((el): el is HTMLImageElement => el instanceof HTMLImageElement)
      );

      for (const imgEl of candidates) {
        const src = imgEl.getAttribute('src')?.trim() || '';
        const oldHires = imgEl.getAttribute('data-old-hires')?.trim() || '';

        // Selection criterion: first wrapper that actually has a usable src
        if (src) {
          // Keep our previous preference for higher-res when available
          return oldHires || src;
        }
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}
/**
 * Extract description from Amazon product page
 * Handles multiple formats:
 * - <div class="a-expander-content a-expander-partial-collapse-content a-expander-content-expanded">...</div>
 * - <div class="a-section voyager-ns-desktop-btf-ingress-container">...</div> (structured tables)
 */
function extractAmazonDescription(doc: Document): string | null {
  try {
    const descriptionParts: string[] = [];
    
    // Try old format first (expander content)
    const descriptionElement = doc.querySelector('.a-expander-content.a-expander-partial-collapse-content.a-expander-content-expanded');
    if (descriptionElement) {
      const textContent = descriptionElement.textContent?.trim() || '';
      if (textContent) {
        // Clean up excessive whitespace
        const cleaned = textContent.replace(/\s+/g, ' ').trim();
        if (cleaned) {
          descriptionParts.push(cleaned);
        }
      }
    }
    
    // Try new format (structured tables in voyager container)
    const voyagerContainer = doc.querySelector('.voyager-ns-desktop-btf-ingress-container');
    if (voyagerContainer) {
      const structuredParts: string[] = [];
      
      // Extract all sections (Style, Measurements, Materials & Care, etc.)
      const sections = voyagerContainer.querySelectorAll('.voyager-ns-desktop-btf-ingress-column');
      
      sections.forEach((section) => {
        // Get section heading
        const heading = section.querySelector('h1');
        const headingText = heading?.textContent?.trim();
        
        // Extract all key-value pairs from tables
        const tableRows = section.querySelectorAll('table.a-keyvalue tbody tr');
        const kvPairs: string[] = [];
        
        tableRows.forEach((row) => {
          const label = row.querySelector('th.voyager-ns-desktop-table-label')?.textContent?.trim();
          const value = row.querySelector('td.voyager-ns-desktop-table-value')?.textContent?.trim();
          
          if (label && value) {
            kvPairs.push(`${label}: ${value}`);
          }
        });
        
        // Combine heading and key-value pairs
        if (headingText && kvPairs.length > 0) {
          structuredParts.push(`${headingText} - ${kvPairs.join(', ')}`);
        } else if (kvPairs.length > 0) {
          structuredParts.push(kvPairs.join(', '));
        }
      });
      
      if (structuredParts.length > 0) {
        descriptionParts.push(structuredParts.join('. '));
      }
    }
    
    // Combine all parts
    if (descriptionParts.length > 0) {
      const combined = descriptionParts.join(' ');
      // Clean up excessive whitespace
      return combined.replace(/\s+/g, ' ').trim() || null;
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract product information from Amazon product pages using Amazon-specific selectors
 */
function extractAmazonProductInfo(doc: Document): ProductInfo | null {
  try {
    const url = getPageUrl(doc) || '';
    const retailer = getRetailer(doc);
    
    // Extract basic fields
    const title = extractAmazonTitle(doc);
    const { price, currency } = extractAmazonPrice(doc);
    const color = extractAmazonColor(doc);
    const imageUrl = extractAmazonImage(doc);
    const description = extractAmazonDescription(doc);
    
    // If we don't have at least a title, this might not be a product page
    if (!title) {
      return null;
    }
    
    // Use attribute detection for category and material
    const categoryDetection = detectCategoryAndSubcategory(title, description || '');
    const materialDetection = detectMaterial(title, description || '');
    
    // Build ProductInfo object
    const productInfo: ProductInfo = {
      title,
      price,
      currency,
      condition: 'new', // Amazon products are typically new
      color: color || undefined,
      images: imageUrl ? [imageUrl] : [],
      url,
      retailer,
      description: description || undefined,
      category: categoryDetection.category || undefined,
      subCategory: categoryDetection.subcategory || undefined,
      primaryMaterial: materialDetection.material || undefined,
      brand: undefined, // Could be extracted from title if needed
    };
    
    return productInfo;
  } catch (error) {
    return null;
  }
}

export function extractProductInfo(doc: Document): ProductInfo | null {
  try {
    // Check if we're on Amazon and use Amazon-specific extraction
    if (isAmazonDomain(doc)) {
      const amazonResult = extractAmazonProductInfo(doc);
      if (amazonResult) {
        return amazonResult;
      }
      // Fall through to shared extraction if Amazon extraction fails
    }
    
    // Use the shared extraction logic with BrowserDOMAdapter
    const adapter = new BrowserDOMAdapter(doc);
    const result = extractShared(adapter);
    
    if (!result) {
      return null;
    }

    // Convert from shared ProductInfo to extension ProductInfo for compatibility
    return {
      title: result.title,
      brand: result.brand,
      description: result.description,
      price: result.price,
      currency: result.currency,
      condition: result.condition,
      color: result.color,
      images: result.images,
      url: result.url,
      retailer: result.retailer,
      // Include new fields if available
      category: result.category,
      subCategory: result.subCategory,
      primaryMaterial: result.primaryMaterial
    };
  } catch (error) {
    return null;
  }
}

// Keep these utility functions for any code that might still use them directly
export function getPageUrl(doc: Document): string | null {
  try {
    const href = doc.defaultView?.location?.href;
    return typeof href === 'string' ? href : doc.baseURI || null;
  } catch {
    return doc.baseURI || null;
  }
}

export function getRetailer(doc: Document): string {
  try {
    const host = doc.defaultView?.location?.hostname || '';
    if (host) return host.replace(/^www\./, '');
    const url = new URL(doc.baseURI);
    return (url.hostname || '').replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Export shared types and functions for direct access if needed  
export type { ProductInfo as SharedProductInfo, DOMAdapter, ElementAdapter } from '@find/extraction';
