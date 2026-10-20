/**
 * Shared dimension constants for the Find browser extension
 * These values control the layout and sizing of the extension UI
 */

// Main panel dimensions
export const PANEL_WIDTH_PX = 384;
export const PANEL_WIDTH_TAILWIND = 'w-96'; // 384px in Tailwind

// Flag button dimensions
export const FLAG_BUTTON_WIDTH_PX = 47;
export const FLAG_BUTTON_PADDING_X_PX = 16; // px-4 = 16px left + right
export const FLAG_BUTTON_PADDING_Y_PX = 64; // py-8 = 32px top + 32px bottom
export const FLAG_BUTTON_TEXT_HEIGHT_PX = 20; // Approximate height for text-lg font-bold "S"
export const FLAG_BUTTON_HEIGHT_PX = FLAG_BUTTON_PADDING_Y_PX + FLAG_BUTTON_TEXT_HEIGHT_PX; // Total button height
export const FLAG_BUTTON_HEIGHT_MULTIPLIER = 1.15; // 115% of button height for iframe visibility

// Flag button Tailwind classes
export const FLAG_BUTTON_CLASSES = {
  PADDING_X: 'px-4', // 16px horizontal padding
  PADDING_Y: 'py-8', // 64px vertical padding (32px top + 32px bottom)
  TEXT_SIZE: 'text-lg', // Large text size
  FONT_WEIGHT: 'font-bold', // Bold font weight
} as const;

// Z-index values for proper layering
export const Z_INDEX = {
  PANEL_IFRAME: 2147483647,  // Panel iframe on top so product cards are clickable
  FLAG_IFRAME: 2147483646,   // Flag iframe behind panel iframe
  REACT_FLAG_BUTTON: 60,
  REACT_PANEL: 50,
} as const;

// Chat interface dimensions
export const CHAT_HEADER_HEIGHT_PX = 200; // Space for header and tabs

// Icon sizes (in pixels and Tailwind classes)
export const ICON_SIZES = {
  SMALL: { px: 12, tailwind: 'h-3 w-3' },
  MEDIUM: { px: 16, tailwind: 'h-4 w-4' },
  LARGE: { px: 20, tailwind: 'h-5 w-5' },
} as const;

// Product item dimensions
export const PRODUCT_THUMBNAIL_SIZE = {
  px: 64,
  tailwind: 'w-16 h-16',
} as const;

// Calculated dimensions
export const CALCULATED = {
  // Flag iframe width = panel width + flag button width
  FLAG_IFRAME_WIDTH_PX: PANEL_WIDTH_PX + FLAG_BUTTON_WIDTH_PX,
  
  // Flag iframe height = 115% of flag button height for extra visibility
  FLAG_IFRAME_HEIGHT_PX: Math.round(FLAG_BUTTON_HEIGHT_PX * FLAG_BUTTON_HEIGHT_MULTIPLIER),
  
  // Flag iframe positioning when closed = -panel_width (so only flag button shows)
  FLAG_IFRAME_CLOSED_OFFSET_PX: -PANEL_WIDTH_PX,
  
  // Chat container height calculation
  CHAT_CONTAINER_HEIGHT: `calc(100vh - ${CHAT_HEADER_HEIGHT_PX}px)`,
} as const;

// CSS custom properties for dynamic values
export const CSS_VARIABLES = {
  '--panel-width': `${PANEL_WIDTH_PX}px`,
  '--flag-button-width': `${FLAG_BUTTON_WIDTH_PX}px`,
  '--flag-button-height': `${FLAG_BUTTON_HEIGHT_PX}px`,
  '--chat-header-height': `${CHAT_HEADER_HEIGHT_PX}px`,
} as const;
