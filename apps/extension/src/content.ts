import { isProductPage } from './detect';
import { extractProductInfo } from './extract-shared';
import { IframeExtensionWrapper } from './iframe-extension-wrapper';
import { extensionAPI } from './api-messaging';
import type { ResolveRequest } from '@find/types';

// TypeScript declarations for Chrome extension APIs
declare const chrome: any;

// Remove unused import - now using extension messaging

let logged = false;
let processing = false; // Track if processing is in progress to prevent concurrent executions
let sidepanel: IframeExtensionWrapper | null = null;
let currentUrl = window.location.href; // Track current URL

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (response?: any) => void) => {
  if (message.action === 'openSidepanel') {
    createOrShowSidepanel();
    sendResponse({ success: true });
  }
  return true; // Keep message channel open for async response
});

// Function to reset state when navigating away from a product page
function resetState() {
  logged = false;
  processing = false; // Reset processing flag
  
  // Hide and destroy sidepanel if it exists
  if (sidepanel) {
    sidepanel.hide();
    sidepanel.destroy();
    sidepanel = null;
  }
  
  // Clear window globals
  delete (window as any).__FIND_PRODUCT_INFO__;
  delete (window as any).__FIND_RESOLVE_RESULT__;
}

// Function to check if URL has changed
function checkUrlChange() {
  const newUrl = window.location.href;
  if (newUrl !== currentUrl) {
    currentUrl = newUrl;
    resetState();
    
    // Wait for React to finish updating the DOM before extracting
    // Fixed delay is more reliable than MutationObserver for SPAs
    setTimeout(() => {
      runDetectionOnce();
    }, 3000); // Wait 3000ms to ensure React has updated all content
  } else {
    // Log occasionally when URL hasn't changed (to avoid spam)
    if (Math.random() < 0.01) { // Log ~1% of the time
    }
  }
}

function createOrShowSidepanel() {
  try {
    if (!sidepanel) {
      // Check if we have product info and either resolve result or resolve was skipped
      const existingResolveResult = (window as any).__FIND_RESOLVE_RESULT__;
      const existingProductInfo = (window as any).__FIND_PRODUCT_INFO__;
      
      if (existingProductInfo && (existingResolveResult || existingResolveResult?.skipped)) {
        sidepanel = new IframeExtensionWrapper();
        sidepanel.show();
        sidepanel.setPanelOpen(true);
        
        // Update the sidepanel with existing data
        sidepanel.updateWithProductInfo(existingProductInfo);
        if (existingResolveResult) {
          sidepanel.updateWithResolveResult(existingResolveResult);
        }
      } else {
        // Could show a temporary notification here if desired
      }
    } else {
      // Toggle the panel state - get current state and flip it
      const currentState = (sidepanel as any).isExtensionOpen;
      sidepanel.setPanelOpen(!currentState);
      sidepanel.show();
    }
  } catch (error) {
  }
}

function stripHtml(input: string): string {
  // First, remove list items that contain links (navigation/shop links)
  const cleanedInput = input
    .replace(/<li[^>]*>[\s\S]*?<a[^>]*href[^>]*>[\s\S]*?<\/a>[\s\S]*?<\/li>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  return cleanedInput;
}

function cleanTextField(value: any): string | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const cleaned = stripHtml(value);
  return cleaned || undefined;
}

async function callResolveAPI(productInfo: any) {
  // Check if we have a valid price - if not, don't proceed with resolve
  const hasValidPrice = typeof productInfo.price === 'number' && productInfo.price > 0;
  
  if (!hasValidPrice) {
    return { skipped: true, reason: 'no_valid_price' };
  }
  
  try {
    // Build extracted data with proper types for Zod validation
    const extracted: any = {
      title: cleanTextField(productInfo.title) || 'Unknown Product',
      price: productInfo.price, // Use the actual price since we validated it above
      currency: productInfo.currency || 'USD',
      condition: productInfo.condition || 'new',
    };

    // Add optional fields only if they have valid values
    if (cleanTextField(productInfo.brand)) {
      extracted.brand = cleanTextField(productInfo.brand);
    }
    if (cleanTextField(productInfo.description)) {
      extracted.description = cleanTextField(productInfo.description);
    }
    if (typeof productInfo.originalPrice === 'number' && productInfo.originalPrice > 0) {
      extracted.originalPrice = productInfo.originalPrice;
    }
    if (productInfo.images && Array.isArray(productInfo.images) && productInfo.images.length > 0) {
      extracted.images = productInfo.images;
    }
    if (cleanTextField(productInfo.color)) {
      extracted.color = cleanTextField(productInfo.color);
    }
    if (cleanTextField(productInfo.material)) {
      extracted.material = cleanTextField(productInfo.material);
    }
    if (cleanTextField(productInfo.gtin)) {
      extracted.gtin = cleanTextField(productInfo.gtin);
    }
    if (cleanTextField(productInfo.mpn)) {
      extracted.mpn = cleanTextField(productInfo.mpn);
    }
    if (cleanTextField(productInfo.sku)) {
      extracted.sku = cleanTextField(productInfo.sku);
    }

    const payload: ResolveRequest = {
      retailer_domain: window.location.hostname,
      page_url: window.location.href,
      extracted,
      // Extension requests get priority - embeddings generated synchronously for immediate search
      source: 'extension',
      sync_embeddings: true,
    };

    const result = await extensionAPI.resolve(payload);
    
    // Store the result for debugging
    (window as any).__FIND_RESOLVE_RESULT__ = result;
    
    return result;
  } catch (error) {
    const errorMessage = (error as Error).message;
    
    // Handle extension context invalidated as a special case
    if (errorMessage.includes('Extension context invalidated') || 
        errorMessage.includes('message port closed')) {
      return { skipped: true, reason: 'extension_context_invalidated', error: errorMessage };
    }
    
    // Return an error object instead of null to distinguish from "no price" case
    return { skipped: true, reason: 'api_error', error: errorMessage };
  }
}

// Removed callSimilarSearchAPI - similar products now fetched by AiLookalikes component

async function runDetectionOnce() {
  const isProduct = isProductPage(document);

  // Check if we already have product info and resolve result to avoid re-processing
  const existingProductInfo = (window as any).__FIND_PRODUCT_INFO__;
  const existingResolveResult = (window as any).__FIND_RESOLVE_RESULT__;
  
  // Skip if already logged, currently processing, or if we already have results
  if (logged || processing || (existingProductInfo && existingResolveResult)) {
    return;
  }
  
  if (isProduct) {
    // Set flags immediately to prevent concurrent executions
    processing = true;
    logged = true;
    
    // IMPORTANT: must log exactly this string once per page load
    
    // Extract product info once and expose for devtools/testing.
    try {
      const info = extractProductInfo(document);

      if (info && info.price && info.price > 0 && info.title && info.title.length > 0 && info.images && info.images.length > 0) {
        (window as any).__FIND_PRODUCT_INFO__ = info;
        
        // Call the /resolve API with extracted product data BEFORE creating sidepanel
        const resolveResult = await callResolveAPI(info);

        // Create sidepanel regardless, but handle different scenarios
        try {
          // Create Extension UI with Iframe
          sidepanel = new IframeExtensionWrapper();

          // Update Extension UI with initial product info
          sidepanel.updateWithProductInfo(info);

          sidepanel.show();
          sidepanel.setPanelOpen(false);
          
          if (resolveResult && !resolveResult.skipped) {
            // Update Extension UI with resolve result
            // sidepanel.updateWithResolveResult(resolveResult);
            // Similar products will be fetched by AiLookalikes component when needed
          } else {

            // Store a special flag to indicate no resolve was performed
            const skippedResult = resolveResult || { 
              skipped: true, 
              reason: 'unknown',
              message: 'Resolve was skipped'
            };
            (window as any).__FIND_RESOLVE_RESULT__ = skippedResult;
            sidepanel.updateWithResolveResult(skippedResult);
          }
        } catch (error) {
        }
      }
    } catch (error) {
    } finally {
      // Reset processing flag when done
      processing = false;
    }
  } else if (!isProduct && sidepanel) {
    // If we're no longer on a product page, hide the sidepanel
    resetState();
  }
}

(function init() {  
  // Set up URL change detection for SPA navigation
  // Intercept pushState and replaceState
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function(...args) {
    originalPushState.apply(history, args);
    setTimeout(checkUrlChange, 0);
  };
  
  history.replaceState = function(...args) {
    originalReplaceState.apply(history, args);
    setTimeout(checkUrlChange, 0);
  };
  
  // Listen for popstate (back/forward button)
  window.addEventListener('popstate', () => {
    setTimeout(checkUrlChange, 0);
  });
  
  // Initial detection
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      runDetectionOnce();
      // Optional SPA guard: catch late-loaded markup
      setTimeout(() => {
        runDetectionOnce();
      }, 500);
    }, { once: true });
  } else {
    runDetectionOnce();
    setTimeout(() => {
      runDetectionOnce();
    }, 500);
  }
  
  // Also poll for URL changes as a fallback (for SPAs that don't use history API)
  setInterval(checkUrlChange, 1000);
})();
