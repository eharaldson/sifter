import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Send, Sparkles, AlertCircle } from "lucide-react";
import { ChatResponse } from "@find/sdk";
import { extensionAPI } from "../../api-messaging";
import ChatProductCard from "./ChatProductCard";

interface ChatInterfaceProps {
  currentProduct?: any;
}

interface ChatMessage {
  id: number;
  type: "user" | "bot";
  content: string;
  timestamp: Date;
  chatResponse?: ChatResponse;
  error?: string;
  shownProductIds?: string[]; // Track product IDs shown in this message's results
  canShowMore?: boolean; // Whether "show more" button should be shown
}

const ChatInterface = ({ currentProduct }: ChatInterfaceProps) => {
  // Use currentProduct to provide context-aware chat responses
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      type: "bot",
      content: "Hi! If this isn't what you're looking for, just ask me - I'll help you find the perfect item.",
      timestamp: new Date()
    }
  ]);
  const [inputValue, setInputValue] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [userLocation, setUserLocation] = useState<string | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<number | string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const quickActions = [
    "Show me similar items under £50",
    "Find sustainable alternatives",
    "What about vintage options?",
  ];

  // Check if user has sent their first message
  const hasUserMessage = messages.some(msg => msg.type === "user");

  // Auto-scroll to bottom when new messages are added
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping]);

  // Get user location on mount
  useEffect(() => {
    const getLocation = async () => {
      try {
        // Try to get location from browser geolocation API
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            async (position) => {
              try {
                // Reverse geocode to get country code
                const response = await fetch(
                  `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${position.coords.latitude}&longitude=${position.coords.longitude}&localityLanguage=en`
                );
                if (response.ok) {
                  const data = await response.json();
                  const countryCode = data.countryCode?.toLowerCase();
                  if (countryCode) {
                    setUserLocation(countryCode);
                  }
                }
              } catch (error) {
              }
            },
            async () => {
              // Fallback: try to get country from timezone or IP
              await getLocationFallback();
            }
          );
        } else {
          await getLocationFallback();
        }
      } catch (error) {
        console.warn('[ChatInterface] Failed to get location:', error);
        await getLocationFallback();
      }
    };

    const getLocationFallback = async () => {
      try {
        // Try to get country from timezone
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        // Map common timezones to country codes
        const timezoneToCountry: Record<string, string> = {
          'Europe/London': 'gb',
          'Europe/Paris': 'fr',
          'Europe/Berlin': 'de',
          'Europe/Madrid': 'es',
          'Europe/Rome': 'it',
          'Europe/Amsterdam': 'nl',
          'America/New_York': 'us',
          'America/Los_Angeles': 'us',
          'America/Chicago': 'us',
          'America/Denver': 'us',
          'America/Toronto': 'ca',
          'America/Mexico_City': 'mx',
          'Australia/Sydney': 'au',
          'Australia/Melbourne': 'au',
          'Asia/Tokyo': 'jp',
          'Asia/Shanghai': 'cn',
          'Asia/Hong_Kong': 'hk',
          'Asia/Singapore': 'sg',
        };
        
        const countryCode = timezoneToCountry[timezone];
        if (countryCode) {
          setUserLocation(countryCode);
          return;
        }

        // Final fallback: try IP-based geolocation
        const ipResponse = await fetch('https://ipapi.co/json/');
        if (ipResponse.ok) {
          const ipData = await ipResponse.json();
          const countryCode = ipData.country_code?.toLowerCase();
          if (countryCode) {
            setUserLocation(countryCode);
          }
        }
      } catch (error) {
        // Default to 'us' if all methods fail
        setUserLocation('us');
      }
    };

    getLocation();
  }, []);

  const handleShowMore = async (messageId: number) => {
    // Find the message with results to expand
    const targetMessage = messages.find(m => m.id === messageId);
    if (!targetMessage || !targetMessage.shownProductIds || !targetMessage.chatResponse) return;
    
    // Get all product IDs shown in this message
    const excludeProductIds = targetMessage.shownProductIds;
    
    // Use the same search query that was used for the original results
    const originalQuery = messages
      .filter(m => m.type === "user" && m.id < messageId)
      .pop()?.content;
    
    if (!originalQuery) return;
    
    setIsTyping(true);
    
    try {
      // Build conversation history from messages before this point
      const historyUpToMessage = messages
        .filter(msg => msg.id < messageId)
        .filter(msg => msg.type === "user" || (msg.type === "bot" && msg.chatResponse))
        .map(msg => ({
          role: msg.type === "user" ? "user" as const : "assistant" as const,
          content: msg.type === "user" ? msg.content : (msg.chatResponse?.message || msg.content),
          timestamp: msg.timestamp,
        }));
      
      // Build request with excluded product IDs
      const chatRequest = {
        userQuery: originalQuery,
        topK: 8,
        conversationHistory: historyUpToMessage,
        userLocation: userLocation || undefined,
        pageContext: selectedProductId ? {
          productId: selectedProductId.toString()
        } : currentProduct?.product_id || currentProduct?.id ? {
          productId: (currentProduct.product_id || currentProduct.id).toString()
        } : undefined,
        excludeProductIds // Pass the IDs to exclude
      };

      console.log('chatRequest: ' + JSON.stringify(chatRequest));
      
      const rawResponse = await extensionAPI.chat(chatRequest);
      const chatData = rawResponse?.data || rawResponse;
      
      if (chatData && chatData.type === 'search_results' && chatData.results) {
        // Update the message with additional results
        setMessages(prev => prev.map(msg => {
          if (msg.id === messageId) {
            const newProductIds = chatData.results.map((r: any) => r.product_id.toString());
            const allShownIds = [...(msg.shownProductIds || []), ...newProductIds];
            
            return {
              ...msg,
              chatResponse: {
                ...msg.chatResponse!,
                results: [...(msg.chatResponse!.results || []), ...chatData.results]
              },
              shownProductIds: allShownIds,
              canShowMore: chatData.results.length === 8 && 
                          chatData.results.every((r: any) => typeof r.product_id === 'number')
            };
          }
          return msg;
        }));
      }
    } catch (error) {
      console.error('Show more failed:', error);
    } finally {
      setIsTyping(false);
    }
  };

  const handleSendMessage = async (message: string) => {
    if (!message.trim()) return;

    // Add user message
    const userMessage: ChatMessage = {
      id: messages.length + 1,
      type: "user",
      content: message,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, userMessage]);
    setInputValue("");
    setIsTyping(true);

    try {
      // Build conversation history from previous messages
      const conversationHistory = messages
        .filter(msg => msg.type === "user" || (msg.type === "bot" && msg.chatResponse))
        .map(msg => ({
          role: msg.type === "user" ? "user" as const : "assistant" as const,
          content: msg.type === "user" ? msg.content : (msg.chatResponse?.message || msg.content),
          timestamp: msg.timestamp,
        }));

      // Determine page context: use selected product from search results, or fall back to current page product
      let contextProductId: string | undefined = undefined;
      
      if (selectedProductId) {
        const productIdStr = String(selectedProductId);
        
        // Find the product in chat results to check if it's from SerpAPI
        const selectedProduct = messages
          .flatMap(msg => msg.chatResponse?.results || [])
          .find(p => String(p.product_id) === productIdStr);
        
        // Check if this is a SerpAPI product using the _source metadata
        if (selectedProduct && selectedProduct._source === 'serpapi' && selectedProduct.best_offer) {
          // This is a SerpAPI product - need to resolve it to database
          try {            
            const resolveResponse = await extensionAPI.serpResolve({
              product_link: selectedProduct.best_offer.url,
              title: selectedProduct.title,
              price: `${selectedProduct.best_offer.currency === 'GBP' ? '£' : selectedProduct.best_offer.currency === 'EUR' ? '€' : '$'}${selectedProduct.best_offer.price}`,
              extracted_price: selectedProduct.best_offer.price,
              source: selectedProduct.best_offer.retailer,
              thumbnail: selectedProduct.image_url,
            });

            const resolveData = resolveResponse?.data || resolveResponse;
            if (resolveData?.product_id) {
              contextProductId = resolveData.product_id.toString(); // Use database product_id
            }
          } catch (error) {
          }
        } else {
          // Database product (either has no _source or _source is 'database')
          contextProductId = selectedProductId.toString();
        }
      } else if (currentProduct?.product_id || currentProduct?.id) {
        // Fall back to current page product
        contextProductId = (currentProduct.product_id || currentProduct.id).toString();
      }

      // Call the orchestrator with conversation history
      const chatRequest = {
        userQuery: message,
        topK: 8,
        pageContext: contextProductId ? {
          productId: contextProductId
        } : undefined,
        conversationHistory: conversationHistory,
        userLocation: userLocation || undefined,
      };

      // Start chat call
      const rawResponse = await extensionAPI.chat(chatRequest);
      
      // Extract the actual chat data from the extension messaging wrapper
      const chatData = rawResponse?.data || rawResponse;
      
      // Validate the response structure
      if (!chatData || typeof chatData !== 'object') {
        throw new Error('Invalid response format from chat service');
      }
      
      // Handle different response types
      let botResponse: ChatMessage;
      
      if (chatData.type === 'follow_up_question') {
        // Show follow-up question
        botResponse = {
          id: messages.length + 2,
          type: "bot",
          content: chatData.message || "Could you tell me more about what you're looking for?",
          timestamp: new Date(),
          chatResponse: chatData as ChatResponse
        };
      } else if (chatData.type === 'chat_response') {
        // Show chat response
        botResponse = {
          id: messages.length + 2,
          type: "bot",
          content: chatData.message || "I'm here to help!",
          timestamp: new Date(),
          chatResponse: chatData as ChatResponse
        };
      } else if (chatData.type === 'fashion_advice') {
        // Show fashion advice - keep content brief, render suggestions separately  
        botResponse = {
          id: messages.length + 2,
          type: "bot",
          content: chatData.advice || "Here are my suggestions:",
          timestamp: new Date(),
          chatResponse: chatData as ChatResponse
        };
      } else if (chatData.type === 'search_results') {
        // Handle search results
        const normalizedResponse: ChatResponse = {
          type: 'search_results',
          results: Array.isArray(chatData.results) ? chatData.results : [],
          parsed: chatData.parsed,
          facets: chatData.facets && typeof chatData.facets === 'object' ? chatData.facets : {},
          why: chatData.why && typeof chatData.why === 'object' ? chatData.why : {},
          relaxedSteps: Array.isArray(chatData.relaxedSteps) ? chatData.relaxedSteps : undefined,
          traceId: chatData.traceId || 'unknown',
          searchKeywords: chatData.searchKeywords,
          parsedQuery: chatData.parsedQuery,
          searchFilters: chatData.searchFilters,
        };
        
        // Track shown product IDs and determine if "show more" is available
        const shownProductIds = normalizedResponse.results?.map((r: any) => r.product_id.toString()) || [];
        const canShowMore = normalizedResponse.results && 
                           normalizedResponse.results.length === 8 && 
                           !normalizedResponse.relaxedSteps && // No relaxation happened
                           normalizedResponse.results.every((r: any) => typeof r.product_id === 'number'); // All from database
        
        botResponse = {
          id: messages.length + 2,
          type: "bot",
          content: generateResponseMessage(normalizedResponse),
          timestamp: new Date(),
          chatResponse: normalizedResponse,
          shownProductIds,
          canShowMore
        };
      } else {
        // Fallback - handle old format for backward compatibility
        const normalizedResponse: ChatResponse = {
          type: 'search_results',
          results: Array.isArray(chatData.results) ? chatData.results : [],
          parsed: chatData.parsed || { freeText: '', filters: {}, limit: 0, confidence: 0 },
          facets: chatData.facets && typeof chatData.facets === 'object' ? chatData.facets : {},
          why: chatData.why && typeof chatData.why === 'object' ? chatData.why : {},
          relaxedSteps: Array.isArray(chatData.relaxedSteps) ? chatData.relaxedSteps : undefined,
          traceId: chatData.traceId || 'unknown',
          searchKeywords: chatData.searchKeywords,
          parsedQuery: chatData.parsedQuery,
          searchFilters: chatData.searchFilters,
        };
        
        // Track shown product IDs and determine if "show more" is available
        const shownProductIds = normalizedResponse.results?.map((r: any) => r.product_id.toString()) || [];
        const canShowMore = normalizedResponse.results && 
                           normalizedResponse.results.length === 8 && 
                           !normalizedResponse.relaxedSteps && // No relaxation happened
                           normalizedResponse.results.every((r: any) => typeof r.product_id === 'number'); // All from database
        
        botResponse = {
          id: messages.length + 2,
          type: "bot",
          content: generateResponseMessage(normalizedResponse),
          timestamp: new Date(),
          chatResponse: normalizedResponse,
          shownProductIds,
          canShowMore
        };
      }
      
      setMessages(prev => [...prev, botResponse]);
      setIsTyping(false);
      
      // If we have fewer results than topK and have search keywords, call SerpAPI
      const resultCount = botResponse.chatResponse?.results?.length || 0;
      const topK = chatRequest.topK || 8;
      if (resultCount < topK && botResponse.chatResponse?.searchKeywords) {
        // Add "Expanding search..." message
        const expandingMessage: ChatMessage = {
          id: messages.length + 3,
          type: "bot",
          content: "Expanding search...",
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, expandingMessage]);

        try {
          const serpSearchRequest = {
            searchKeywords: botResponse.chatResponse.searchKeywords,
            parsedSearchText: botResponse.chatResponse.parsedQuery,
            minPrice: botResponse.chatResponse.searchFilters?.price?.min,
            maxPrice: botResponse.chatResponse.searchFilters?.price?.max,
            neededCount: topK - resultCount,
            filters: botResponse.chatResponse.searchFilters,
            topK: topK,
            location: userLocation || undefined,
          };

          const serpData = await extensionAPI.serpSearch(serpSearchRequest).catch((error) => {
            console.error('[ChatInterface] SerpAPI search failed:', error);
            return null;
          });

          const serpResults = serpData?.data || serpData;
          if (serpResults && Array.isArray(serpResults.results) && serpResults.results.length > 0) {
            const neededCount = topK - resultCount;
            const serpResultsToAdd = serpResults.results.slice(0, neededCount);

            // Remove the "Expanding search..." message and add results
            setMessages(prev => {
              const updated = prev.filter(msg => msg.id !== expandingMessage.id);
              const lastBotMessage = updated[updated.length - 1];
              if (lastBotMessage && lastBotMessage.chatResponse) {
                lastBotMessage.chatResponse.results = [
                  ...(lastBotMessage.chatResponse.results || []),
                  ...serpResultsToAdd
                ];
              }
              return updated;
            });
          } else {
            // Remove "Expanding search..." message if no results
            setMessages(prev => prev.filter(msg => msg.id !== expandingMessage.id));
          }
        } catch (error) {
          console.error('[ChatInterface] SerpAPI search processing failed:', error);
          setMessages(prev => prev.filter(msg => msg.id !== expandingMessage.id));
        }
      }
      
    } catch (error) {      
      // Create more specific error message based on error type
      let errorMessage = "I'm sorry, I encountered an error.";
      
      if (error instanceof Error) {
        if (error.message.includes('Failed to fetch') || error.message.includes('ECONNREFUSED')) {
          errorMessage = "I'm having trouble connecting to the search service. Please check if the backend is running.";
        } else if (error.message.includes('CORS')) {
          errorMessage = "There's a connection issue. Please refresh the page and try again.";
        }
      }
      
      // Add error message
      const errorResponse: ChatMessage = {
        id: messages.length + 2,
        type: "bot",
        content: errorMessage,
        timestamp: new Date(),
        error: error instanceof Error ? error.message : 'Unknown error'
      };
      
      setMessages(prev => [...prev, errorResponse]);
      setIsTyping(false);
    }
  };

  const generateResponseMessage = (chatResponse: ChatResponse): string => {
    // Safe access to results array
    const results = Array.isArray(chatResponse.results) ? chatResponse.results : [];
    const resultCount = results.length;
    
    if (resultCount === 0) {
      return "I couldn't find any products matching your request. Try adjusting your search terms or being more specific about what you're looking for.";
    }
    
    let message = `I found ${resultCount} great ${resultCount === 1 ? 'option' : 'options'} for you! `;
    
    // Add price range info if available
    const validResults = results.filter(r => r.best_offer && typeof r.best_offer.price === 'number');
    if (validResults.length > 0) {
      const prices = validResults.map(r => r.best_offer.price);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const currency = validResults[0].best_offer.currency;
      
      if (minPrice === maxPrice) {
        message += `Priced at ${getCurrencySymbol(currency)}${minPrice}. `;
      } else {
        message += `Prices range from ${getCurrencySymbol(currency)}${minPrice} to ${getCurrencySymbol(currency)}${maxPrice}. `;
      }
    }
    
    // Add facet highlights
    const facets = chatResponse.facets && typeof chatResponse.facets === 'object' ? chatResponse.facets : {};
    const facetKeys = Object.keys(facets);
    if (facetKeys.length > 0) {
      const topFacets = facetKeys.slice(0, 2);
      message += `You can filter by ${topFacets.join(' and ')} using the options below.`;
    }
    
    return message;
  };

  // Helper function to get currency symbol (same as in ProductCard)
  const getCurrencySymbol = (currency: string): string => {
    switch (currency) {
      case 'USD': return '$';
      case 'EUR': return '€';
      case 'GBP': return '£';
      default: return currency + ' ';
    }
  };

  return (
    <Card className="h-full flex flex-col pb-2">
      {/* <CardHeader className="flex-none">
        <CardTitle className="flex items-center space-x-1">
          <MessageSquare className="w-5 h-5 text-electric" />
          <span>Ask Sifter</span>
        </CardTitle>
      </CardHeader> */}
      <CardContent className="flex-1 flex flex-col min-h-0 pt-5">
        {/* Chat Messages */}
        <div className="flex-1 overflow-y-auto space-y-4 mb-4 p-3 bg-background rounded-lg min-h-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {messages.map((message) => (
            <div key={message.id} className="space-y-3">
              {/* Message bubble */}
              <div className={`flex ${message.type === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-xs lg:max-w-md px-4 py-2 rounded-2xl ${
                  message.type === "user" 
                    ? "bg-electric text-white rounded-br-sm" 
                    : "bg-card border border-border rounded-bl-sm"
                }`}>
                  {message.type === "bot" && (
                    <div className="flex items-center space-x-1 mb-1">
                      <Sparkles className="w-3 h-3 text-electric" />
                      <span className="text-xs text-electric font-medium">Sifter</span>
                    </div>
                  )}
                  <p className="text-sm">{message.content}</p>
                  
                  {/* Error indicator */}
                  {message.error && (
                    <div className="flex items-center space-x-1 mt-2 text-red-500">
                      <AlertCircle className="w-3 h-3" />
                      <span className="text-xs">Error occurred</span>
                    </div>
                  )}
                </div>
              </div>

                  {/* Product results and facets for bot messages */}
              {message.type === "bot" && message.chatResponse && message.chatResponse.type === 'search_results' && (
                <div className="space-y-3 ml-4">
                  {/* Relaxation info */}
                  {message.chatResponse.relaxedSteps && Array.isArray(message.chatResponse.relaxedSteps) && message.chatResponse.relaxedSteps.length > 0 && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                      <div className="flex items-center space-x-2 mb-2">
                        <AlertCircle className="w-4 h-4 text-amber-600" />
                        <span className="text-sm font-medium text-amber-800">Search Expanded</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {message.chatResponse.relaxedSteps.map((step, index) => (
                          <Badge key={index} variant="outline" className="text-xs text-amber-700 border-amber-300">
                            {step}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Product results */}
                  {message.chatResponse.results && Array.isArray(message.chatResponse.results) && message.chatResponse.results.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-medium text-foreground">
                          {message.chatResponse.results.length} Products Found
                        </h4>
                      </div>
                      
                      <div className="space-y-2">
                        {Array.isArray(message.chatResponse.results) && message.chatResponse.results.map((product) => {
                          const productIdStr = product?.product_id?.toString() || '';
                          
                          if (!product || !productIdStr) {
                            return null;
                          }
                          
                          return (
                            <ChatProductCard
                              key={product.product_id}
                              product={product}
                              className="text-sm"
                              isSelected={selectedProductId === product.product_id}
                              onSelect={(productId) => {
                                // Toggle selection: if already selected, deselect; otherwise select
                                setSelectedProductId(prev => prev === productId ? null : productId);
                              }}
                            />
                          );
                        })}
                      </div>
                      
                      {/* Show more button */}
                      {message.canShowMore && (
                        <div className="flex justify-center mt-3">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleShowMore(message.id)}
                            disabled={isTyping}
                            className="text-xs"
                          >
                            Show more
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Facets - Commented out to save space */}
                  {/* {message.chatResponse.facets && typeof message.chatResponse.facets === 'object' && Object.keys(message.chatResponse.facets).length > 0 && (
                    <FacetsDisplay
                      facets={message.chatResponse.facets}
                      onFacetClick={(facetType, value) => {
                        // Handle facet click by creating a new search
                        const facetQuery = `Show me ${facetType === 'price_ranges' ? 'items in' : facetType} ${value}`;
                        handleSendMessage(facetQuery);
                      }}
                      className="text-sm"
                    />
                  )} */}
                </div>
              )}

              {/* Fashion advice suggestions for bot messages */}
              {message.type === "bot" && message.chatResponse && message.chatResponse.type === 'fashion_advice' && (
                <div className="ml-4 mt-2 space-y-2">
                  {message.chatResponse.suggestions && message.chatResponse.suggestions.length > 0 && (
                    <div className="space-y-2">
                      {message.chatResponse.suggestions.map((suggestion: { item: string; reasoning: string }, index: number) => (
                        <div 
                          key={index} 
                          className="bg-muted/50 border border-border rounded-lg p-2 hover:bg-muted/70 transition-colors"
                        >
                          <div className="flex items-start gap-2">
                            <span className="flex-shrink-0 w-4 h-4 rounded-full bg-electric/20 text-electric text-[10px] font-medium flex items-center justify-center">
                              {index + 1}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-foreground">{suggestion.item}</p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">{suggestion.reasoning}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {message.chatResponse.followUpPrompt && (
                    <p className="text-xs text-muted-foreground italic mt-1">
                      {message.chatResponse.followUpPrompt}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
          
          {isTyping && (
            <div className="flex justify-start">
              <div className="bg-card border border-border px-4 py-2 rounded-2xl rounded-bl-sm">
                <div className="flex space-x-1">
                  <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce"></div>
                  <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                  <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                </div>
              </div>
            </div>
          )}
          
          {/* Invisible div to scroll to */}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="flex-none space-y-3">
          {/* Selected product indicator */}
          {selectedProductId && (
            <div className="space-y-2">
              <div className="flex items-center justify-between p-2 bg-electric/10 border border-electric/20 rounded-lg">
                <span className="text-xs text-electric font-medium">
                  Using selected product as context
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6 px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => setSelectedProductId(null)}
                >
                  Clear
                </Button>
              </div>
              {/* Suggested query for selected product */}
              <Button
                variant="outline"
                size="sm"
                className="w-full text-sm h-auto py-2 px-3 text-electric border-electric/30 hover:bg-electric/10 hover:border-electric/50"
                onClick={() => handleSendMessage("more like this")}
              >
                More like this
              </Button>
            </div>
          )}
          
          {/* Quick Actions in Input Area */}
          {!selectedProductId && !hasUserMessage && (
            <div className="flex flex-wrap gap-1">
              {quickActions.map((action, index) => (
                <Button
                  key={index}
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6 px-2 text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted/50"
                  onClick={() => handleSendMessage(action)}
                >
                  {action}
                </Button>
              ))}
            </div>
          )}
          
          <div className="flex space-x-2">
            <Input
              placeholder="Tell me what you're looking for..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleSendMessage(inputValue)}
              className="flex-1 placeholder:text-xs"
            />
            <Button 
              onClick={() => handleSendMessage(inputValue)}
              disabled={!inputValue.trim() || isTyping}
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default ChatInterface;