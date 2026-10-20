import { Badge } from "@/components/ui/badge";
import { PRODUCT_THUMBNAIL_SIZE } from "@/constants/dimensions";

interface ProductCardProps {
  product: {
    product_id: number;
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
  explanations?: string[];
  showSimilarityScore?: boolean;
  className?: string;
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

const ProductCard = ({ 
  product, 
  explanations = [], 
  showSimilarityScore = false,
  className = ""
}: ProductCardProps) => {
  const handleClick = () => {
    if (product.best_offer?.url) {
      window.open(product.best_offer.url, '_blank');
    }
  };

  const formatPrice = (price: number, currency: string) => {
    return `${getCurrencySymbol(currency)}${price}`;
  };

  const hasDiscount = product.best_offer.original_price && 
    product.best_offer.original_price > product.best_offer.price;

  return (
    <div 
      className={`flex items-center space-x-4 p-3 border border-border rounded-lg hover:border-electric/50 transition-all group cursor-pointer ${className}`}
      onClick={handleClick}
    >
      {/* Image */}
      <div className={`${PRODUCT_THUMBNAIL_SIZE.tailwind} bg-muted rounded-lg flex-shrink-0 overflow-hidden`}>
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
      <div className="flex-1 min-w-0 relative">
        <div className="flex items-start justify-between w-full">
          <div className="flex-1 min-w-0 pr-2">
            <h3 className="font-medium text-foreground group-hover:text-electric transition-colors break-words">
              {truncateText(product.best_offer.title || product.title)}
            </h3>
            <div className="flex items-center space-x-2 mt-1">
              {product.brand && (
                <p className="text-sm text-muted-foreground">{product.brand}</p>
              )}
              <span className="text-xs text-muted-foreground">•</span>
              <p className="text-sm text-muted-foreground">{product.best_offer.retailer}</p>
            </div>
            
            <div className="flex items-center space-x-2 mt-1">
              <span className="text-xs text-muted-foreground">Condition:</span>
              <Badge variant="outline" className="text-xs">{product.best_offer.condition}</Badge>
              {showSimilarityScore && product.similarity_score && (
                <>
                  <span className="text-xs text-muted-foreground">•</span>
                  <span className="text-xs text-mint font-medium">
                    {Math.round(product.similarity_score * 100)}% match
                  </span>
                </>
              )}
            </div>

            {/* Explanations */}
            {explanations.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {explanations.slice(0, 3).map((explanation, index) => (
                  <Badge 
                    key={index} 
                    variant="secondary" 
                    className="text-xs bg-electric/10 text-electric border-electric/20"
                  >
                    {explanation}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="text-right flex-shrink-0 min-w-0">
            <div className="flex flex-col items-end">
              <span className="text-lg font-bold text-foreground">
                {formatPrice(product.best_offer.price, product.best_offer.currency)}
              </span>
              {hasDiscount && (
                <span className="text-xs text-muted-foreground line-through">
                  {formatPrice(product.best_offer.original_price!, product.best_offer.currency)}
                </span>
              )}
              {!product.best_offer.in_stock && (
                <Badge variant="destructive" className="text-xs mt-1">
                  Out of Stock
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProductCard;
