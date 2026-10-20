import ChatInterface from "@/components/webapp/ChatInterface";
import { ThemeToggle } from "@/components/ui/theme-toggle";

const WebApp = () => {
  return (
    <div className="min-h-screen bg-background flex flex-col px-3 sm:px-4 py-4 sm:py-8 relative">
      {/* Header - stack on mobile, row on larger screens */}
      <div className="flex items-center justify-between mb-4 sm:absolute sm:top-5 sm:left-7 sm:right-4 sm:mb-0">
        <h1 className="text-2xl sm:text-3xl font-serif font-bold text-foreground">Sifter</h1>
        <ThemeToggle />
      </div>
      
      {/* Main content - centered with responsive max-width */}
      <div className="flex-1 flex items-start sm:items-center justify-center sm:pt-12">
        <div className="w-full max-w-4xl">
          <ChatInterface />
        </div>
      </div>
    </div>
  );
};

export default WebApp;

