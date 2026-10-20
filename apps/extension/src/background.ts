/**
 * Background script for handling API calls
 * Runs in extension context, bypasses CORS
 */

import { FindAPIClient } from '@find/sdk';

// TypeScript declarations for Chrome extension APIs
declare const chrome: any;

// Create API client with production URL
const API_URL = process.env.VITE_API_URL || 'http://localhost:3001/api';
const findAPI = new FindAPIClient(API_URL);

interface APIRequest {
  type: string;
  endpoint: string;
  data: any;
}

// Listen for extension icon clicks
chrome.action.onClicked.addListener((tab: any) => {
  // console.log('🔄 Extension icon clicked, sending message to content script');
  
  // Send message to content script to open/toggle the sidepanel
  chrome.tabs.sendMessage(tab.id, { action: 'openSidepanel' }, (response: any) => {
    if (chrome.runtime.lastError) {
      // console.error('❌ Failed to send message to content script:', chrome.runtime.lastError.message);
    } else {
      // console.log('✅ Message sent to content script successfully');
    }
  });
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request: APIRequest, _sender: any, sendResponse: (response: any) => void) => {
  if (request.type === 'API_CALL') {
    handleAPICall(request, sendResponse);
    return true; // Keep message channel open for async response
  }
  return false;
});

async function handleAPICall(request: APIRequest, sendResponse: (response: any) => void) {
  try {
    const { endpoint, data } = request;
    
    // console.log(`🔄 Background API call: ${endpoint}`, data);
    
    switch (endpoint) {
      case 'resolve':
        const resolveResult = await findAPI.resolve(data);
        sendResponse({ success: true, data: resolveResult });
        break;
        
      case 'search':
        const searchResult = await findAPI.searchSimilar(data);
        // console.log('✅ Background search result:', searchResult);
        sendResponse({ success: true, data: searchResult });
        break;
        
      case 'offers':
        const { productId, params } = data;
        const offersResult = await findAPI.getOffers(productId, params);
        sendResponse({ success: true, data: offersResult });
        break;
        
      case 'chat':
        const chatResult = await findAPI.chat(data);
        sendResponse({ success: true, data: chatResult });
        break;
        
      case 'serp-search':
        const serpSearchResult = await findAPI.serpSearch(data);
        sendResponse({ success: true, data: serpSearchResult });
        break;
        
      case 'serp-resolve':
        const apiUrl = process.env.VITE_API_URL;
        const serpResolveResponse = await fetch(`${apiUrl}/serp-resolve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(data),
        });
        const serpResolveResult = await serpResolveResponse.json();
        sendResponse({ success: true, data: serpResolveResult });
        break;
        
      default:
        // console.error('❌ Unknown API endpoint:', endpoint);
        sendResponse({ success: false, error: 'Unknown endpoint' });
    }
  } catch (error) {
    // console.error('❌ Background API call failed:', error);
    sendResponse({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
}
