import React from 'react';
import { ProductWithOffers, OfferWithRetailer } from '@find/types';

// Product Card Component
export interface ProductCardProps {
  product: ProductWithOffers;
  onViewOffers?: (productId: string) => void;
  onSimilarProducts?: (productId: string) => void;
  showSimilarityScore?: boolean;
}

export const ProductCard: React.FC<ProductCardProps> = ({
  product,
  onViewOffers,
  onSimilarProducts,
  showSimilarityScore = false,
}) => {
  const bestOffer = product.offers?.reduce((best, current) => 
    current.price < best.price ? current : best
  );

  return React.createElement('div', {
    className: 'product-card',
    style: {
      border: '1px solid #e5e7eb',
      borderRadius: '8px',
      padding: '16px',
      backgroundColor: 'white',
      boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
    }
  }, [
    // Product Image
    product.images?.[0] && React.createElement('img', {
      key: 'image',
      src: product.images[0],
      alt: product.title,
      style: {
        width: '100%',
        height: '200px',
        objectFit: 'cover',
        borderRadius: '4px',
        marginBottom: '12px',
      }
    }),
    
    // Product Info
    React.createElement('div', { key: 'info' }, [
      React.createElement('h3', {
        key: 'title',
        style: { margin: '0 0 8px 0', fontSize: '16px', fontWeight: '600' }
      }, product.title),
      
      product.brand && React.createElement('p', {
        key: 'brand',
        style: { margin: '0 0 8px 0', color: '#6b7280', fontSize: '14px' }
      }, product.brand),
      
      bestOffer && React.createElement('div', {
        key: 'price',
        style: { margin: '8px 0', fontSize: '18px', fontWeight: '700', color: '#059669' }
      }, `${bestOffer.currency} ${bestOffer.price.toFixed(2)}`),
      
      showSimilarityScore && product.similarity_score && React.createElement('div', {
        key: 'similarity',
        style: { margin: '4px 0', fontSize: '12px', color: '#6b7280' }
      }, `${Math.round(product.similarity_score * 100)}% match`),
      
      // Action Buttons
      React.createElement('div', {
        key: 'actions',
        style: { marginTop: '12px', display: 'flex', gap: '8px' }
      }, [
        onViewOffers && React.createElement('button', {
          key: 'offers',
          onClick: () => onViewOffers(product.id),
          style: {
            padding: '8px 16px',
            backgroundColor: '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px',
          }
        }, 'View Offers'),
        
        onSimilarProducts && React.createElement('button', {
          key: 'similar',
          onClick: () => onSimilarProducts(product.id),
          style: {
            padding: '8px 16px',
            backgroundColor: '#6b7280',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px',
          }
        }, 'Similar Items'),
      ])
    ])
  ]);
};

// Offer List Component
export interface OfferListProps {
  offers: OfferWithRetailer[];
  onOfferClick?: (offer: OfferWithRetailer) => void;
}

export const OfferList: React.FC<OfferListProps> = ({ offers, onOfferClick }) => {
  return React.createElement('div', {
    className: 'offer-list',
    style: { display: 'flex', flexDirection: 'column', gap: '8px' }
  }, offers.map(offer => 
    React.createElement('div', {
      key: offer.id,
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px',
        border: '1px solid #e5e7eb',
        borderRadius: '6px',
        cursor: onOfferClick ? 'pointer' : 'default',
      },
      onClick: onOfferClick ? () => onOfferClick(offer) : undefined,
    }, [
      React.createElement('div', { key: 'retailer' }, [
        React.createElement('div', {
          key: 'name',
          style: { fontWeight: '600', fontSize: '14px' }
        }, offer.retailer.name),
        React.createElement('div', {
          key: 'condition',
          style: { fontSize: '12px', color: '#6b7280' }
        }, offer.condition),
      ]),
      React.createElement('div', {
        key: 'price',
        style: { fontWeight: '700', fontSize: '16px', color: '#059669' }
      }, `${offer.currency} ${offer.price.toFixed(2)}`)
    ])
  ));
};

// Loading Spinner Component
export const LoadingSpinner: React.FC<{ size?: number }> = ({ size = 24 }) => {
  return React.createElement('div', {
    style: {
      width: `${size}px`,
      height: `${size}px`,
      border: '2px solid #f3f4f6',
      borderTop: '2px solid #3b82f6',
      borderRadius: '50%',
      animation: 'spin 1s linear infinite',
    }
  });
};

// Error Message Component
export interface ErrorMessageProps {
  message: string;
  onRetry?: () => void;
}

export const ErrorMessage: React.FC<ErrorMessageProps> = ({ message, onRetry }) => {
  return React.createElement('div', {
    style: {
      padding: '16px',
      backgroundColor: '#fef2f2',
      border: '1px solid #fecaca',
      borderRadius: '6px',
      color: '#dc2626',
    }
  }, [
    React.createElement('p', { key: 'message', style: { margin: '0 0 8px 0' } }, message),
    onRetry && React.createElement('button', {
      key: 'retry',
      onClick: onRetry,
      style: {
        padding: '6px 12px',
        backgroundColor: '#dc2626',
        color: 'white',
        border: 'none',
        borderRadius: '4px',
        cursor: 'pointer',
        fontSize: '12px',
      }
    }, 'Retry')
  ]);
};

// Export all components and types
export * from '@find/types';
