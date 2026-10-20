/**
 * API messaging utility for content scripts
 * Uses extension messaging to bypass CORS
 */

// TypeScript declarations for Chrome extension APIs
declare const chrome: any;

export interface APIMessage {
  type: 'API_CALL';
  endpoint: 'resolve' | 'search' | 'offers' | 'chat' | 'serp-search' | 'serp-resolve';
  data: any;
}

export interface APIResponse {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Check if extension runtime is still valid
 */
function isExtensionContextValid(): boolean {
  try {
    // Try to access runtime.id - if context is invalidated, this will throw
    return !!chrome.runtime?.id;
  } catch (error) {
    return false;
  }
}

/**
 * Send API call through extension messaging
 */
export function sendAPIMessage(endpoint: string, data: any): Promise<any> {
  return new Promise((resolve, reject) => {
    // Check if extension context is still valid before attempting to send message
    if (!isExtensionContextValid()) {
      const error = new Error('Extension context invalidated');
      // console.error('❌ Extension context invalidated - cannot send message');
      reject(error);
      return;
    }

    const message: APIMessage = {
      type: 'API_CALL',
      endpoint: endpoint as any,
      data
    };


    try {
      chrome.runtime.sendMessage(message, (response: APIResponse) => {
        if (chrome.runtime.lastError) {
          const errorMessage = chrome.runtime.lastError.message;
          
          // Handle "Extension context invalidated" specifically
          if (errorMessage.includes('Extension context invalidated') || 
              errorMessage.includes('message port closed')) {
            reject(new Error('Extension context invalidated'));
          } else {
            reject(new Error(errorMessage));
          }
          return;
        }

        // Check if response exists (might be undefined if context was invalidated)
        if (!response) {
          reject(new Error('Extension context invalidated'));
          return;
        }

        // console.log(`📥 Received response from background: ${endpoint}`, response);

        if (response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response.error || 'API call failed'));
        }
      });
    } catch (error) {
      // console.error('❌ Error sending message to background:', error);
      reject(new Error('Extension context invalidated'));
    }
  });
}

/**
 * Wrapper functions for each API endpoint
 */
export const extensionAPI = {
  resolve: (data: any) => sendAPIMessage('resolve', data),
  search: (data: any) => sendAPIMessage('search', data),
  offers: (data: any) => sendAPIMessage('offers', data),
  chat: (data: any) => sendAPIMessage('chat', data),
  serpSearch: (data: any) => sendAPIMessage('serp-search', data),
  serpResolve: (data: any) => sendAPIMessage('serp-resolve', data),
};
