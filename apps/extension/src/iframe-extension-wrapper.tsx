import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import Extension from './pages/Extension';
import { Toaster } from '@/components/ui/toaster';
import { 
  PANEL_WIDTH_PX, 
  Z_INDEX, 
  CALCULATED,
  FLAG_BUTTON_WIDTH_PX
} from '@/constants/dimensions';

// TypeScript declarations for Chrome extension APIs
declare const chrome: any;

export class IframeExtensionWrapper {
  private panelIframe: HTMLIFrameElement | null = null;
  private flagIframe: HTMLIFrameElement | null = null;
  private panelReactRoot: Root | null = null;
  private flagReactRoot: Root | null = null;
  private isExtensionOpen: boolean = false;
  private messageListener: ((e: MessageEvent) => void) | null = null;
  // Removed message queue system - now using direct window property assignment

  constructor() {
    this.mountIframe();
    this.setupMessageListener();
    this.updateIframeSize(); // Set initial positions correctly
  }

  private setupMessageListener() {
    this.messageListener = (e: MessageEvent) => {
      if (e.data?.__FIND_PANEL_STATE__) {
        this.setPanelOpen(e.data.isOpen);
      }
    };
    window.addEventListener('message', this.messageListener);
  }

  private mountIframe() {
    this.createPanelIframe();
    this.createFlagIframe();
  }

  private createPanelIframe() {
    const id = 'find-extension-panel-frame';
    const existing = document.getElementById(id) as HTMLIFrameElement | null;
    if (existing) { 
      this.panelIframe = existing; 
      return; 
    }

    const iframe = document.createElement('iframe');
    iframe.id = id;

    // Isolate the element itself from page CSS
    iframe.style.all = 'initial';
    iframe.style.position = 'fixed';
    iframe.style.top = '0';
    iframe.style.right = '0';
    iframe.style.width = `${PANEL_WIDTH_PX}px`; // Panel width only
    iframe.style.height = '100vh';
    iframe.style.transform = 'translateX(100%)'; // Start off-screen
    iframe.style.border = '0';
    iframe.style.setProperty('z-index', `${Z_INDEX.PANEL_IFRAME}`, 'important');
    iframe.style.background = 'transparent';
    iframe.style.pointerEvents = 'auto';
    iframe.setAttribute('aria-label', 'Find extension panel');
    iframe.setAttribute('allowtransparency', 'true'); // For older browsers

    // Get CSS URL from extension package
    const cssHref = chrome.runtime.getURL('ui.css');
    
    // Inline document with CSS link
    iframe.srcdoc = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <link rel="stylesheet" href="${cssHref}">
          <style>
            html, body {
              margin: 0;
              padding: 0;
              height: 100%;
              background: transparent !important;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            }
            #react-root {
              position: relative;
              width: 100%;
              height: 100%;
              overflow: hidden;
              background: transparent !important;
              pointer-events: auto;
            }
            
            /* Make the gap area non-interactive by default */
            html {
              pointer-events: none !important;
            }
            
            /* Re-enable pointer events only for actual extension content */
            #react-root * {
              pointer-events: auto;
            }
          </style>
        </head>
        <body>
          <div id="react-root"></div>
        </body>
      </html>
    `;

    (document.documentElement || document.body).appendChild(iframe);
    this.panelIframe = iframe;

    iframe.addEventListener('load', () => this.bootstrapPanelIframe());
  }

  private createFlagIframe() {
    const id = 'find-extension-flag-frame';
    const existing = document.getElementById(id) as HTMLIFrameElement | null;
    if (existing) { 
      this.flagIframe = existing; 
      return; 
    }

    const iframe = document.createElement('iframe');
    iframe.id = id;

    // Isolate the element itself from page CSS
    iframe.style.all = 'initial';
    iframe.style.position = 'fixed';
    iframe.style.top = '50%';
    iframe.style.right = '0';
    iframe.style.width = `${CALCULATED.FLAG_IFRAME_WIDTH_PX}px`; // Panel width + flag button width
    iframe.style.height = `${CALCULATED.FLAG_IFRAME_HEIGHT_PX}px`; // 115% of flag button height for extra visibility
    iframe.style.border = '0';
    iframe.style.setProperty('z-index', `${Z_INDEX.FLAG_IFRAME}`, 'important');
    iframe.style.background = 'transparent';
    iframe.style.pointerEvents = 'auto';
    iframe.style.transform = 'translateY(-50%)'; // Vertically centered, horizontal position is controlled by 'right'
    iframe.setAttribute('aria-label', 'Find extension flag button');
    iframe.setAttribute('allowtransparency', 'true');

    // Get CSS URL from extension package
    const cssHref = chrome.runtime.getURL('ui.css');
    
    // Inline document with CSS link - simpler for flag button
    iframe.srcdoc = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <link rel="stylesheet" href="${cssHref}">
          <style>
            html, body {
              margin: 0;
              padding: 0;
              height: 100%;
              background: transparent !important;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            }
            #flag-root {
              position: relative;
              width: 100%;
              height: 100%;
              overflow: visible;
              background: transparent !important;
              pointer-events: auto;
            }
          </style>
        </head>
        <body>
          <div id="flag-root"></div>
        </body>
      </html>
    `;

    (document.documentElement || document.body).appendChild(iframe);
    this.flagIframe = iframe;

    iframe.addEventListener('load', () => this.bootstrapFlagIframe());
  }

  private bootstrapPanelIframe() {
    if (!this.panelIframe) return;
    
    try {
      const doc = this.panelIframe.contentDocument;
      if (!doc) {
        console.error('[IframeExtensionWrapper] Cannot access panel iframe document');
        return;
      }

      const container = doc.getElementById('react-root');
      if (!container) {
        console.error('[IframeExtensionWrapper] Cannot find react-root container in panel iframe');
        return;
      }

      this.panelReactRoot = createRoot(container);
      this.panelReactRoot.render(
        React.createElement(React.Fragment, null, [
          React.createElement(Extension, { key: 'extension', showFlagButton: false }),
          React.createElement(Toaster, { key: 'toaster' })
        ])
      );

    } catch (error) {
      console.error('[IframeExtensionWrapper] Failed to bootstrap panel iframe:', error);
    }
  }

  private bootstrapFlagIframe() {
    if (!this.flagIframe) return;
    
    try {
      const doc = this.flagIframe.contentDocument;
      if (!doc) {
        console.error('[IframeExtensionWrapper] Cannot access flag iframe document');
        return;
      }

      const container = doc.getElementById('flag-root');
      if (!container) {
        console.error('[IframeExtensionWrapper] Cannot find flag-root container');
        return;
      }

      this.flagReactRoot = createRoot(container);
      this.flagReactRoot.render(
        React.createElement('button', {
          key: 'flag-button',
          onClick: () => {
            this.setPanelOpen(!this.isExtensionOpen);
          },
          className: 'fixed top-1/2 -translate-y-1/2 z-[60] bg-primary text-primary-foreground hover:bg-primary/90 rounded-l-md rounded-r-none px-4 py-8 font-bold text-xl font-serif shadow-lg border-r-0',
          style: { 
            right: `${PANEL_WIDTH_PX}px`,
            transform: 'translateY(-50%)',
            transition: 'right 0.3s ease-in-out'
          }
        }, 'S')
      );

    } catch (error) {
      console.error('[IframeExtensionWrapper] Failed to bootstrap flag iframe:', error);
    }
  }

  public show() {
    if (this.panelIframe) {
      this.panelIframe.style.display = 'block';
      this.updateIframeSize();
    }
  }

  public hide() {
    if (this.panelIframe) {
      this.panelIframe.style.display = 'none';
    }
    if (this.flagIframe) {
      this.flagIframe.style.display = 'none';
    }
  }

  public setPanelOpen(isOpen: boolean) {
    this.isExtensionOpen = isOpen;
    this.updateIframeSize();
  }

  private updateIframeSize() {
    if (this.panelIframe) {
      this.panelIframe.style.transition = 'transform 0.3s ease-in-out';
      this.panelIframe.style.transform = this.isExtensionOpen ? 'translateX(0)' : 'translateX(100%)';
    }

    if (this.flagIframe) {
      this.flagIframe.style.transition = 'right 0.3s ease-in-out';
      // When closed, the iframe is positioned such that only the button width is visible.
      // The offset is the total width of the iframe minus the part we want to show.
      const closedRightOffset = -(CALCULATED.FLAG_IFRAME_WIDTH_PX - FLAG_BUTTON_WIDTH_PX);
      this.flagIframe.style.right = this.isExtensionOpen ? '0px' : `${closedRightOffset}px`;
    }

    // Re-render the flag button to update its internal state-dependent style
    if (this.flagReactRoot) {
      this.bootstrapFlagIframe();
    }
    
    // Update panel position - Extension component handles its own positioning
    if (this.panelReactRoot) {
      this.panelReactRoot.render(
        React.createElement(React.Fragment, null, [
          React.createElement(Extension, { key: 'extension', showFlagButton: false }),
          React.createElement(Toaster, { key: 'toaster' })
        ])
      );
    }
  }

  public updateWithProductInfo(productInfo: any) {
    // Store data directly in iframe window
    if (this.panelIframe?.contentWindow) {
      (this.panelIframe.contentWindow as any).__FIND_PRODUCT_INFO__ = productInfo;
    }
  }

  public updateWithResolveResult(resolveResult: any) {
    // Store data directly in iframe window
    if (this.panelIframe?.contentWindow) {
      (this.panelIframe.contentWindow as any).__FIND_RESOLVE_RESULT__ = resolveResult;
    }
  }

  // Removed updateWithSimilarProducts - similar products now fetched by AiLookalikes component

  // Removed unused message passing methods - now using direct window property assignment

  public destroy() {
    try {
      if (this.panelReactRoot) {
        this.panelReactRoot.unmount();
        this.panelReactRoot = null;
      }
      
      if (this.flagReactRoot) {
        this.flagReactRoot.unmount();
        this.flagReactRoot = null;
      }
      
      if (this.panelIframe) {
        this.panelIframe.remove();
        this.panelIframe = null;
      }
      
      if (this.flagIframe) {
        this.flagIframe.remove();
        this.flagIframe = null;
      }

      if (this.messageListener) {
        window.removeEventListener('message', this.messageListener);
        this.messageListener = null;
      }
      
    } catch (error) {
      console.error('[IframeExtensionWrapper] Error during destroy:', error);
    }
  }
}
