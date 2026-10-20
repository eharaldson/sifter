import { Badge } from "@/components/ui/badge";
import { Check } from "lucide-react";

interface ChatProductCardProps {
  product: {
    product_id: number | string;
    title: string;
    brand?: string;
    image_url?: string;
    category?: string;
    similarity_score?: number;
    best_offer: {
      retailer: string;
      retailer_domain: string;
      title?: string; // Retailer-specific title
      image_url?: string; // Retailer-specific image
      price: number;
      currency: string;
      original_price?: number;
      url: string;
      affiliate_url?: string;
      in_stock: boolean;
      condition: string;
    };
  };
  className?: string;
  isSelected?: boolean;
  onSelect?: (productId: number | string) => void;
}

// Helper function to get currency symbol
function getCurrencySymbol(currency: string): string {
  switch (currency) {
    case 'USD':
      return '$';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    default:
      return currency + ' ';
  }
}

// Helper function to truncate text
function truncateText(text: string, maxLength: number = 50): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

const ChatProductCard = ({ 
  product, 
  className = "",
  isSelected = false,
  onSelect
}: ChatProductCardProps) => {
  const handleCardClick = (e: React.MouseEvent) => {
    // Don't open URL if clicking on selector button
    if ((e.target as HTMLElement).closest('.selector-button')) {
      return;
    }
    if (product.best_offer?.url) {
      window.open(product.best_offer.url, '_blank');
    }
  };

  const handleSelectClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onSelect) {
      onSelect(product.product_id);
    }
  };

  const formatPrice = (price: number, currency: string) => {
    return `${getCurrencySymbol(currency)}${price}`;
  };

  const hasDiscount = product.best_offer.original_price && 
    product.best_offer.original_price > product.best_offer.price;

  return (
    <div 
      className={`relative flex space-x-3 p-3 bg-white border rounded-lg hover:border-electric/50 transition-all group cursor-pointer w-full ${
        isSelected ? 'border-electric border-2' : 'border-border'
      } ${className}`}
      onClick={handleCardClick}
    >
      {/* Selection button */}
      <button
        className={`selector-button absolute top-2 left-2 z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${
          isSelected
            ? 'bg-electric border-electric text-white'
            : 'bg-white/90 border-border hover:border-electric'
        }`}
        onClick={handleSelectClick}
        aria-label={isSelected ? 'Deselect product' : 'Select product'}
      >
        {isSelected && <Check className="w-4 h-4" />}
      </button>

      {/* Image */}
      <div className="w-32 h-32 bg-muted rounded-lg flex-shrink-0 overflow-hidden">
        {(product.best_offer.image_url || product.image_url) ? (
          <img 
            src={product.best_offer.image_url || product.image_url} 
            alt={product.best_offer.title || product.title}
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="w-full h-full bg-muted flex items-center justify-center">
            <span className="text-xs text-muted-foreground">No image</span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0 h-32 flex flex-col">
        {/* Top row with price */}
        <div className="flex justify-end mb-2">
          <div className="text-right">
            <span className="text-lg font-bold text-foreground group-hover:text-electric transition-colors">
              {formatPrice(product.best_offer.price, product.best_offer.currency)}
            </span>
            {hasDiscount && (
              <div className="text-xs text-muted-foreground line-through">
                {formatPrice(product.best_offer.original_price!, product.best_offer.currency)}
              </div>
            )}
          </div>
        </div>

        {/* Right side content from bottom up */}
        <div className="flex-1 flex flex-col justify-end items-end space-y-1">
          {/* Brand (above condition) */}
          {product.brand && (
            <p className="text-sm font-medium text-foreground">{product.brand}</p>
          )}
          
          {/* Condition (bottom) */}
          <div className="flex items-center space-x-2">
            <Badge variant="outline" className="text-xs">{product.best_offer.condition}</Badge>
            {!product.best_offer.in_stock && (
              <Badge variant="destructive" className="text-xs">
                Out of Stock
              </Badge>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatProductCard;
