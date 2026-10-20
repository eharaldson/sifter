import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModernExtensionUI } from '../src/modern-extension-ui';

// Mock chrome APIs
(global as any).chrome = {
  runtime: {
    getURL: vi.fn((path: string) => `chrome-extension://test-id/${path}`),
  },
};

// Mock fetch for CSS loading
global.fetch = vi.fn().mockResolvedValue({
  text: () => Promise.resolve('/* test css */'),
});

describe('ModernExtensionUI', () => {
  let ui: ModernExtensionUI;

  beforeEach(() => {
    // Clear any existing mocks
    vi.clearAllMocks();
    
    // Clear document body
    document.body.innerHTML = '';
  });

  afterEach(() => {
    // Clean up any created UI instances
    if (ui) {
      try {
        ui.destroy();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  it('should create host element and shadow DOM', async () => {
    ui = new ModernExtensionUI();
    
    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check that host element was added to document body
    const hostElement = document.body.querySelector('[data-find-extension]');
    expect(hostElement).toBeTruthy();
    
    // Check that shadow root was created
    expect(hostElement?.shadowRoot).toBeTruthy();
  });

  it('should attempt to load CSS from chrome extension URL', async () => {
    ui = new ModernExtensionUI();
    
    // Wait for CSS injection to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify that chrome.runtime.getURL was called with ui.css
    expect((global as any).chrome.runtime.getURL).toHaveBeenCalledWith('ui.css');
    
    // Verify that fetch was called with the chrome extension URL
    expect(fetch).toHaveBeenCalledWith('chrome-extension://test-id/ui.css');
  });

  it('should create React container after CSS loading', async () => {
    ui = new ModernExtensionUI();
    
    // Wait for initialization to complete
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Find the host element
    const hostElement = document.body.querySelector('[data-find-extension]');
    
    // Check that React container was created in shadow DOM
    const reactContainer = hostElement?.shadowRoot?.querySelector('#react-extension-root');
    expect(reactContainer).toBeTruthy();
    expect(reactContainer?.tagName).toBe('DIV');
  });

  it('should handle CSS loading failure gracefully', async () => {
    // Mock fetch to fail
    global.fetch = vi.fn().mockRejectedValue(new Error('Failed to load CSS'));
    
    ui = new ModernExtensionUI();
    
    // Wait for fallback CSS injection
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Find the host element
    const hostElement = document.body.querySelector('[data-find-extension]');
    
    // Should still create React container even if CSS loading fails
    const reactContainer = hostElement?.shadowRoot?.querySelector('#react-extension-root');
    expect(reactContainer).toBeTruthy();
  });
});
