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
      className={`relative flex flex-col p-2 bg-card border rounded-lg hover:border-electric/50 transition-all duration-200 group cursor-pointer 
        md:hover:scale-[1.5] md:hover:z-20 md:hover:shadow-xl transform-gpu origin-center ${
        isSelected ? 'border-electric border-2' : 'border-border'
      } ${className}`}
      onClick={handleCardClick}
    >
      {/* Selection button */}
      <button
        className={`selector-button absolute top-2 right-2 z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${
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
      <div className="w-full aspect-square bg-muted rounded-lg flex-shrink-0 overflow-hidden mb-2">
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
      <div className="flex flex-col space-y-1">
        {/* Top row: Brand (left) and Price (right) */}
        <div className="flex items-start justify-between">
          {/* Brand on the left */}
          {product.brand ? (
            <p className="text-xs sm:text-sm font-medium text-foreground truncate flex-1 pr-2">{product.brand}</p>
          ) : (
            <div className="flex-1"></div>
          )}
          
          {/* Price on the right */}
          <div className="text-right flex-shrink-0">
            <span className="text-sm sm:text-base font-bold text-foreground group-hover:text-electric transition-colors">
              {formatPrice(product.best_offer.price, product.best_offer.currency)}
            </span>
            {hasDiscount && (
              <div className="text-[10px] sm:text-xs text-muted-foreground line-through">
                {formatPrice(product.best_offer.original_price!, product.best_offer.currency)}
              </div>
            )}
          </div>
        </div>
        
        {/* Condition badge - smaller on mobile */}
        <div className="flex items-center justify-end">
          <Badge variant="outline" className="text-[10px] sm:text-xs">{product.best_offer.condition}</Badge>
          {!product.best_offer.in_stock && (
            <Badge variant="destructive" className="text-[10px] sm:text-xs ml-1">
              Out
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChatProductCard;

