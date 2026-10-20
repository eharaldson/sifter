import { useState, useEffect } from "react";
import { ShoppingCart, Sparkles, MessageCircle } from "lucide-react";
// TODO: Re-enable when theme toggle is fixed
// import { Settings } from "lucide-react";
// import { ThemeToggle } from "@/components/ui/theme-toggle";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import PriceComparison from "@/components/webapp/PriceComparison";
import AiLookalikes from "@/components/webapp/AiLookalikes";
import ChatInterface from "@/components/webapp/ChatInterface";

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
import { 
  PANEL_WIDTH_PX, 
  PANEL_WIDTH_TAILWIND, 
  Z_INDEX, 
  ICON_SIZES
} from "@/constants/dimensions";

interface ExtensionProps {
  showFlagButton?: boolean;
}

const Extension = ({ showFlagButton = true }: ExtensionProps) => {
  const [isExtensionOpen, setIsExtensionOpen] = useState(true);

  // Notify parent window when panel state changes
  const handleToggleExtension = () => {
    const newState = !isExtensionOpen;
    setIsExtensionOpen(newState);
    
    // Send message to parent window (content script)
    window.parent.postMessage({
      __FIND_PANEL_STATE__: true,
      isOpen: newState
    }, '*');
  };
  const [productInfo, setProductInfo] = useState<any>(null);
  const [resolveResult, setResolveResult] = useState<any>(null);
  // Removed similarProducts state - now handled by AiLookalikes component

  // console.log('[Extension] Current state:', { 
  //   productInfo: productInfo, 
  //   resolveResult: resolveResult,
  //   productId: resolveResult?.product_id 
  // });

  // Poll for data stored directly in window object
  useEffect(() => {
    const pollForData = () => {
      // Check for product info
      const newProductInfo = (window as any).__FIND_PRODUCT_INFO__;
      if (newProductInfo && newProductInfo !== productInfo) {
        setProductInfo(newProductInfo);
      }
      
      // Check for resolve result
      const newResolveResult = (window as any).__FIND_RESOLVE_RESULT__;
      if (newResolveResult && newResolveResult !== resolveResult) {
        setResolveResult(newResolveResult);
      }
    };
    
    // Poll every 100ms
    const interval = setInterval(pollForData, 100);
    
    // Also check immediately
    pollForData();
    
    return () => {
      clearInterval(interval);
    };
  }, [productInfo, resolveResult]);

  return (
    <>
      {/* Extension Flag - only show if showFlagButton is true */}
      {showFlagButton && (
        <Button
          onClick={handleToggleExtension}
          className={`fixed right-0 top-1/2 -translate-y-1/2 z-[${Z_INDEX.REACT_FLAG_BUTTON}] bg-primary text-primary-foreground hover:bg-primary/90 rounded-l-md rounded-r-none px-4 py-8 font-bold text-lg shadow-lg border-r-0`}
          style={{ transform: `translateY(-50%) translateX(${isExtensionOpen ? `-${PANEL_WIDTH_PX}px` : '0px'})` }}
        >
          S
        </Button>
      )}

      <div 
        className={`fixed top-0 ${PANEL_WIDTH_TAILWIND} h-screen bg-background border-l border-border z-[${Z_INDEX.REACT_PANEL}] shadow-lg transition-transform duration-300 ease-in-out ${
          isExtensionOpen ? 'right-0' : `-right-[${PANEL_WIDTH_PX}px]`
        }`}
      >
        <div className="h-full flex flex-col">
          {/* Header */}
          <header className="bg-card border-b border-border px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="font-serif font-bold text-2xl text-green-950 text-foreground">Sifter</div>
              {/* TODO: Re-enable theme toggle and settings when iframe window isolation is fixed */}
              {/* <div className="flex items-center space-x-1">
                <ThemeToggle />
                <Button variant="ghost" size="sm">
                  <Settings className="h-4 w-4" />
                </Button>
              </div> */}
            </div>
          </header>

          {/* Main Content */}
          <div className="flex-1 p-4 overflow-auto flex flex-col min-h-0">
            <Tabs defaultValue="lookalikes" className="w-full h-full flex flex-col">
              <TabsList className="grid w-full grid-cols-2 mb-4 flex-none">
                {/* <TabsTrigger value="comparison" className="text-xs">
                  <ShoppingCart className={`${ICON_SIZES.SMALL.tailwind} mr-1`} />
                  Buy
                </TabsTrigger> */}
                <TabsTrigger value="lookalikes" className="text-xs">
                  <Sparkles className={`${ICON_SIZES.SMALL.tailwind} mr-1`} />
                  Discover
                </TabsTrigger>
                <TabsTrigger value="chat" className="text-xs">
                  <MessageCircle className={`${ICON_SIZES.SMALL.tailwind} mr-1`} />
                  Find
                </TabsTrigger>
              </TabsList>

              {/* <TabsContent value="comparison" className="space-y-3">
                <div className="mb-3">
                  <Badge variant="secondary" className="text-s">
                    {productInfo ? 
                      `Current Item: ${getCurrencySymbol(productInfo.currency || 'USD')}${productInfo.price || '0'}` : 
                      'Current Item'
                    }
                  </Badge>
                </div>
                <PriceComparison 
                  productId={resolveResult?.product_id}
                  productInfo={productInfo}
                />
              </TabsContent> */}

              <TabsContent value="lookalikes" className="space-y-3">
                <AiLookalikes 
                  productId={resolveResult?.product_id}
                  productInfo={productInfo}
                />
              </TabsContent>

              <TabsContent value="chat" className="flex-1 flex flex-col min-h-0">
                <ChatInterface 
                  currentProduct={{
                    ...productInfo,
                    product_id: resolveResult?.product_id
                  }}
                />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </>
  );
};

export default Extension;