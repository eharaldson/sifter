import { useState, useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Send, Sparkles, Image as ImageIcon, AlertCircle } from "lucide-react";
import { apiClient } from "@/services/api";
import type { ChatRequest, ChatResponse } from "@find/types";
import ChatProductCard from "./ChatProductCard";

interface ChatMessage {
  id: number;
  type: "user" | "bot";
  content: string;
  timestamp: Date;
  chatResponse?: ChatResponse;
  shownProductIds?: string[]; // Track product IDs shown in this message's results
  canShowMore?: boolean; // Whether "show more" button should be shown
  imageUrl?: string; // Store base64 image data for display
  requestedLimit?: number; // Store the limit parsed from user query by orchestrator
}

const ChatInterface = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [userLocation, setUserLocation] = useState<string | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<number | string | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null); // Store base64 image
  const [selectedImageName, setSelectedImageName] = useState<string | null>(null); // Store filename for display
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
                    console.log('[ChatInterface] Detected location:', countryCode);
                  }
                }
              } catch (error) {
                console.warn('[ChatInterface] Failed to reverse geocode location:', error);
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

  // Check if user has sent their first message
  const hasUserMessage = messages.some(msg => msg.type === "user");

  const quickActions = [
    "Show me boxy streetwear hoodies with graphic prints for less than £100",
    "Find me light blue t shirts made of organic cotton",
    "Find me a pair of black leather boots second hand between £100 and £200",
    "Dark blue jeans with the acne studios aesthetic for less than £100"
  ];

  const handleImageUpload = () => {
    fileInputRef.current?.click();
  };

  const compressImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          // Calculate new dimensions (max 1024px on longest side)
          const maxDimension = 1024;
          let width = img.width;
          let height = img.height;
          
          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }
          
          // Create canvas and draw resized image
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, width, height);
          
          // Convert to base64 with quality optimization
          // Use JPEG for photos (better compression), PNG for images with transparency
          const isTransparent = file.type === 'image/png';
          const format = isTransparent ? 'image/png' : 'image/jpeg';
          const quality = 0.85; // Good balance between quality and size
          
          const base64String = canvas.toDataURL(format, quality);
          
          console.log('[ChatInterface] Image compressed:', {
            originalSize: file.size,
            originalDimensions: `${img.width}x${img.height}`,
            newDimensions: `${width}x${height}`,
            base64Length: base64String.length,
            estimatedSize: Math.round(base64String.length * 0.75), // Rough estimate of decoded size
          });
          
          resolve(base64String);
        };
        
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = e.target?.result as string;
      };
      
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      console.log('Image selected:', file.name);
      
      try {
        // Compress and convert image to base64
        const base64String = await compressImage(file);
        setSelectedImage(base64String);
        setSelectedImageName(file.name);
      } catch (error) {
        console.error('[ChatInterface] Failed to process image:', error);
        // You could show an error message to the user here
      }
    }
    // Reset the input so the same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleShowMore = async (messageId: number) => {
    // Find the message with results to expand
    const targetMessage = messages.find(m => m.id === messageId);
    if (!targetMessage || !targetMessage.shownProductIds || !targetMessage.chatResponse) return;
    
    // Get all product IDs shown in this message
    const excludeProductIds = targetMessage.shownProductIds;
    
    // Use the limit that was parsed by the orchestrator for the original request
    const requestedLimit = targetMessage.requestedLimit || 10;
    
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
      const chatRequest: ChatRequest = {
        userQuery: originalQuery,
        topK: requestedLimit,
        conversationHistory: historyUpToMessage,
        userLocation: userLocation || undefined,
        pageContext: selectedProductId ? {
          productId: selectedProductId.toString()
        } : undefined,
        excludeProductIds // Pass the IDs to exclude
      };
      
      const chatResponse = await apiClient.chat(chatRequest);
      
      if (chatResponse.type === 'search_results' && chatResponse.results) {
        // Update the message with additional results
        setMessages(prev => prev.map(msg => {
          if (msg.id === messageId) {
            const newProductIds = chatResponse.results!.map(r => r.product_id.toString());
            const allShownIds = [...(msg.shownProductIds || []), ...newProductIds];
            
            return {
              ...msg,
              chatResponse: {
                ...msg.chatResponse!,
                results: [...(msg.chatResponse!.results || []), ...chatResponse.results!]
              },
              shownProductIds: allShownIds,
              canShowMore: chatResponse.results!.length === requestedLimit && 
                          chatResponse.results!.every(r => typeof r.product_id === 'number')
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
    // Allow sending if there's either a message or an image
    if (!message.trim() && !selectedImage) return;

    // Add user message (store image data for display)
    const userMessage = {
      id: messages.length + 1,
      type: "user" as const,
      content: message.trim(), // Only show text if user actually typed something
      timestamp: new Date(),
      imageUrl: selectedImage || undefined, // Store the image for display
    };
    setMessages(prev => [...prev, userMessage]);
    
    // Store the image URL before clearing state
    const imageUrlToSend = selectedImage;
    
    // Clear input and image
    setInputValue("");
    setSelectedImage(null);
    setSelectedImageName(null);
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

      // If a SerpAPI product is selected, resolve it to database product first
      let contextProductId = selectedProductId;
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
            console.log('[ChatInterface] Resolving SerpAPI product to database:', {
              product_id: selectedProduct.product_id,
              title: selectedProduct.title
            });
            
            const apiUrl = import.meta.env.VITE_API_URL;
            const resolveResponse = await fetch(`${apiUrl}/serp-resolve`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                product_link: selectedProduct.best_offer.url,
                title: selectedProduct.title,
                price: `${selectedProduct.best_offer.currency === 'GBP' ? '£' : selectedProduct.best_offer.currency === 'EUR' ? '€' : '$'}${selectedProduct.best_offer.price}`,
                extracted_price: selectedProduct.best_offer.price,
                source: selectedProduct.best_offer.retailer,
                thumbnail: selectedProduct.image_url,
              }),
            });

            if (resolveResponse.ok) {
              const resolveData = await resolveResponse.json();
              contextProductId = resolveData.product_id; // Use database product_id
              console.log('[ChatInterface] Resolved SerpAPI product to database product:', resolveData.product_id);
            } else {
              console.error('[ChatInterface] Failed to resolve SerpAPI product:', await resolveResponse.text());
            }
          } catch (error) {
            console.error('[ChatInterface] Error resolving SerpAPI product:', error);
          }
        }
      }

      // Call the orchestrator with conversation history
      const chatRequest: ChatRequest = {
        userQuery: message.trim() || "Find products similar to this image",
        topK: 10,
        conversationHistory: conversationHistory,
        userLocation: userLocation || undefined,
        imageUrl: imageUrlToSend || undefined,
        pageContext: contextProductId ? {
          productId: contextProductId.toString()
        } : undefined,
      };
      
      console.log('[ChatInterface] Sending chat request:', {
        userQuery: message,
        topK: 10,
        historyLength: conversationHistory.length,
        hasImage: !!imageUrlToSend,
        imageLength: imageUrlToSend?.length || 0,
      });

      // Start chat call
      const chatResponse = await apiClient.chat(chatRequest);
      
      console.log('[ChatInterface] Chat response received:', {
        type: chatResponse.type,
        hasResults: Array.isArray(chatResponse?.results),
        resultCount: chatResponse?.results?.length || 0,
        hasMessage: !!chatResponse?.message,
      });
      
      // Handle different response types
      let botResponse: ChatMessage;
      
      if (chatResponse.type === 'follow_up_question') {
        // Show follow-up question
        botResponse = {
          id: messages.length + 2,
          type: "bot",
          content: chatResponse.message || "Could you tell me more about what you're looking for?",
          timestamp: new Date(),
          chatResponse: chatResponse
        };
        setMessages(prev => [...prev, botResponse]);
        setIsTyping(false);
      } else if (chatResponse.type === 'chat_response') {
        // Show chat response
        botResponse = {
          id: messages.length + 2,
          type: "bot",
          content: chatResponse.message || "I'm here to help!",
          timestamp: new Date(),
          chatResponse: chatResponse
        };
        setMessages(prev => [...prev, botResponse]);
        setIsTyping(false);
      } else if (chatResponse.type === 'fashion_advice') {
        // Show fashion advice - keep content brief, render suggestions separately
        botResponse = {
          id: messages.length + 2,
          type: "bot",
          content: chatResponse.advice || "Here are my suggestions:",
          timestamp: new Date(),
          chatResponse: chatResponse
        };
        setMessages(prev => [...prev, botResponse]);
        setIsTyping(false);
      } else if (chatResponse.type === 'search_results') {
        // Handle search results
        const results = Array.isArray(chatResponse.results) ? chatResponse.results : [];
        const resultCount = results.length;
        // Use the limit parsed by orchestrator, fallback to what we requested
        const requestedLimit = chatResponse.parsed?.limit || chatRequest.topK || 10;
        
        // Use backend-generated contextual message if available, otherwise generate one
        let responseMessage = chatResponse.message || '';
        if (!responseMessage) {
          if (resultCount === 0) {
            responseMessage = "I couldn't find any products matching your request. Try adjusting your search terms or being more specific about what you're looking for.";
          } else {
            responseMessage = `I found ${resultCount} great ${resultCount === 1 ? 'option' : 'options'} for you! `;
            
            // Add price range info if available
            const validResults = results.filter(r => r.best_offer && typeof r.best_offer.price === 'number');
            if (validResults.length > 0) {
              const prices = validResults.map(r => r.best_offer.price);
              const minPrice = Math.min(...prices);
              const maxPrice = Math.max(...prices);
              const currency = validResults[0].best_offer.currency;
              
              if (minPrice === maxPrice) {
                responseMessage += `Priced at ${getCurrencySymbol(currency)}${minPrice}. `;
              } else {
                responseMessage += `Prices range from ${getCurrencySymbol(currency)}${minPrice} to ${getCurrencySymbol(currency)}${maxPrice}. `;
              }
            }
          }
        }

        // Track shown product IDs and determine if "show more" is available
        const shownProductIds = results.map(r => r.product_id.toString());
        const canShowMore = results.length === requestedLimit && 
                           !chatResponse.relaxedSteps && // No relaxation happened
                           results.every(r => typeof r.product_id === 'number'); // All from database

        botResponse = {
          id: messages.length + 2,
          type: "bot",
          content: responseMessage,
          timestamp: new Date(),
          chatResponse: chatResponse,
          shownProductIds,
          canShowMore,
          requestedLimit // Store the limit for "show more" functionality
        };
        
        setMessages(prev => [...prev, botResponse]);
        setIsTyping(false);
        
        // If we have fewer results than requested and have search keywords, call SerpAPI
        if (resultCount < requestedLimit && chatResponse.searchKeywords) {
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
              searchKeywords: chatResponse.searchKeywords,
              parsedSearchText: chatResponse.parsedQuery,
              minPrice: chatResponse.searchFilters?.price?.min,
              maxPrice: chatResponse.searchFilters?.price?.max,
              neededCount: requestedLimit - resultCount,
              filters: chatResponse.searchFilters,
              topK: requestedLimit,
              location: userLocation || undefined,
            };

            const apiUrl = import.meta.env.VITE_API_URL;
            const serpData = await fetch(`${apiUrl}/serp-search`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(serpSearchRequest),
            })
              .then(async (response) => {
                if (!response.ok) {
                  const errorText = await response.text();
                  throw new Error(`SerpAPI search failed: ${response.status} ${response.statusText} - ${errorText}`);
                }
                return response.json();
              })
              .catch((error: any) => {
                console.error('[ChatInterface] SerpAPI search failed:', error);
                return null;
              });

            if (serpData && Array.isArray(serpData.results) && serpData.results.length > 0) {
              const neededCount = requestedLimit - resultCount;
              const serpResultsToAdd = serpData.results.slice(0, neededCount);

              // Remove the "Expanding search..." message and add results
              setMessages(prev => {
                const updated = prev.filter(msg => msg.id !== expandingMessage.id);
                const lastBotMessage = updated[updated.length - 1];
                if (lastBotMessage && lastBotMessage.chatResponse) {
                  lastBotMessage.chatResponse.results = [
                    ...(lastBotMessage.chatResponse.results || []),
                    ...serpResultsToAdd
                  ];
                  const newResultCount = lastBotMessage.chatResponse.results.length;
                  lastBotMessage.content = `I found ${newResultCount} great ${newResultCount === 1 ? 'option' : 'options'} for you!`;
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
        } else {
          setIsTyping(false);
        }
      } else {
        // Fallback
        botResponse = {
          id: messages.length + 2,
          type: "bot",
          content: chatResponse.message || "I'm here to help you find what you're looking for!",
          timestamp: new Date(),
          chatResponse: chatResponse
        };
        setMessages(prev => [...prev, botResponse]);
        setIsTyping(false);
      }
    } catch (error) {
      console.error('Chat API error:', error);
      // Create more specific error message based on error type
      let errorMessage = "I'm sorry, I encountered an error.";
      
      if (error instanceof Error) {
        if (error.message.includes('Failed to fetch') || error.message.includes('ECONNREFUSED')) {
          errorMessage = "I'm having trouble connecting to the search service. Please check if the backend is running.";
        } else if (error.message.includes('CORS')) {
          errorMessage = "There's a connection issue. Please refresh the page and try again.";
        }
      }
      
      const botResponse: ChatMessage = {
        id: messages.length + 2,
        type: "bot",
        content: errorMessage,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, botResponse]);
      setIsTyping(false);
    }
  };

  // Helper function to get currency symbol
  const getCurrencySymbol = (currency: string): string => {
    switch (currency) {
      case 'USD': return '$';
      case 'EUR': return '€';
      case 'GBP': return '£';
      default: return currency + ' ';
    }
  };


  return (
    <Card className={`${hasUserMessage ? 'h-[85vh] sm:h-[90vh]' : 'h-auto'} transition-all duration-300 flex flex-col`}>
      <CardContent className={`${hasUserMessage ? 'pt-6 flex flex-col flex-1 overflow-hidden' : 'p-6'}`}>
        {/* Chat Messages */}
        {messages.length > 0 && (
          <div className={`${hasUserMessage ? 'flex-1' : 'h-64'} overflow-y-auto space-y-4 mb-4 p-3 bg-background rounded-lg [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden`}>
            {messages.map((message) => (
              <div key={message.id} className="space-y-3">
                {/* Message bubble */}
                <div className={`flex ${message.type === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] sm:max-w-xs md:max-w-md px-4 py-2 rounded-2xl ${
                    message.type === "user" 
                      ? "bg-electric text-white rounded-br-sm" 
                      : "bg-card border border-border rounded-bl-sm"
                  }`}>
                    {message.type === "bot" && (
                      <div className="flex items-center space-x-1 mb-1">
                        <Sparkles className="w-3 h-3 text-electric" />
                        <span className="text-xs text-electric font-serif font-bold">Sifter</span>
                      </div>
                    )}
                    
                    {/* Image preview for user messages with images */}
                    {message.type === "user" && message.imageUrl && (
                      <div className="mb-2">
                        <img 
                          src={message.imageUrl} 
                          alt="Uploaded" 
                          className="max-w-full h-auto rounded-lg max-h-48 object-contain"
                        />
                      </div>
                    )}
                    
                    {message.content && <p className="text-sm">{message.content}</p>}
                    
                    {/* Error indicator */}
                    {(message as any).error && (
                      <div className="flex items-center space-x-1 mt-2 text-red-500">
                        <AlertCircle className="w-3 h-3" />
                        <span className="text-xs">Error occurred</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Product results for bot messages */}
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
                      <div className="space-y-2 overflow-visible">
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-medium text-foreground">
                            {message.chatResponse.results.length} Products Found
                          </h4>
                          {message.chatResponse.parsed?.confidence !== undefined && (
                            <Badge variant="secondary" className="text-xs">
                              {message.chatResponse.parsed.confidence > 0.8 ? 'High' : 
                               message.chatResponse.parsed.confidence > 0.6 ? 'Medium' : 'Low'} Confidence
                            </Badge>
                          )}
                        </div>
                        
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 md:gap-3 md:p-2 overflow-visible">
                          {message.chatResponse.results.map((product) => {
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
                          <div className="flex justify-center mt-4">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleShowMore(message.id)}
                              disabled={isTyping}
                              className="text-sm"
                            >
                              Show more
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Fashion advice suggestions for bot messages */}
                {message.type === "bot" && message.chatResponse && message.chatResponse.type === 'fashion_advice' && (
                  <div className="ml-4 mt-2 space-y-2">
                    {message.chatResponse.suggestions && message.chatResponse.suggestions.length > 0 && (
                      <div className="space-y-2">
                        {message.chatResponse.suggestions.map((suggestion, index) => (
                          <div 
                            key={index} 
                            className="bg-muted/50 border border-border rounded-lg p-3 hover:bg-muted/70 transition-colors"
                          >
                            <div className="flex items-start gap-2">
                              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-electric/20 text-electric text-xs font-medium flex items-center justify-center">
                                {index + 1}
                              </span>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-foreground">{suggestion.item}</p>
                                <p className="text-xs text-muted-foreground mt-0.5">{suggestion.reasoning}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {message.chatResponse.followUpPrompt && (
                      <p className="text-sm text-muted-foreground italic mt-2">
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
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Input */}
        <div className="space-y-3">
          {/* Selected image indicator */}
          {selectedImage && (
            <div className="flex items-center justify-between p-2 bg-electric/10 border border-electric/20 rounded-lg">
              <div className="flex items-center space-x-2">
                <div className="w-10 h-10 rounded overflow-hidden bg-muted flex-shrink-0">
                  <img 
                    src={selectedImage} 
                    alt="Selected" 
                    className="w-full h-full object-cover"
                  />
                </div>
                <span className="text-xs text-electric font-medium truncate">
                  {selectedImageName}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-6 px-2 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setSelectedImage(null);
                  setSelectedImageName(null);
                }}
              >
                Remove
              </Button>
            </div>
          )}
          
          {/* Selected product indicator */}
          {selectedProductId && (
            <div className="flex items-center justify-between p-2 bg-electric/10 border border-electric/20 rounded-lg">
              <span className="text-xs text-electric font-medium">
                Using selected product as context for your search
              </span>
              <div className="flex items-center space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-sm h-auto py-2 px-3 text-electric border-electric/30 hover:bg-electric/10 hover:border-electric/50"
                  onClick={() => handleSendMessage("more like this")}
                >
                  More like this
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6 px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => setSelectedProductId(null)}
                >
                  Clear
                </Button>
              </div>
            </div>
          )}
          
          {/* Quick Actions in Input Area */}
          {!hasUserMessage && !selectedProductId && !selectedImage && (
            <div className="flex flex-col gap-2 max-h-[40vh] overflow-y-auto sm:max-h-none sm:overflow-visible">
              {quickActions.map((action, index) => (
                <Button
                  key={index}
                  variant="ghost"
                  size="sm"
                  className="text-xs h-auto py-2 px-3 text-left text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted/50 whitespace-normal"
                  onClick={() => handleSendMessage(action)}
                >
                  {action}
                </Button>
              ))}
            </div>
          )}
          
          <div className="flex space-x-2">
            <Input
              placeholder="Let me know what you're looking for and I'll help you find it."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleSendMessage(inputValue)}
              className="flex-1 placeholder:text-xs"
            />
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept="image/*"
              className="hidden"
            />
            <Button
              type="button"
              variant={selectedImage ? "default" : "outline"}
              onClick={handleImageUpload}
              disabled={isTyping}
              className={selectedImage ? "bg-electric hover:bg-electric/90" : ""}
            >
              <ImageIcon className="w-4 h-4" />
            </Button>
            <Button 
              onClick={() => handleSendMessage(inputValue)}
              disabled={(!inputValue.trim() && !selectedImage) || isTyping}
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