/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/**/*.{js,ts,jsx,tsx}",
    "./src/components/**/*.{js,ts,jsx,tsx}",
    "./src/pages/**/*.{js,ts,jsx,tsx}",
    "./public/**/*.html",
    // Include other monorepo packages that might be used in the extension
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx}",
    "../../packages/types/src/**/*.{js,ts,jsx,tsx}",
    // Include other apps for shared components
    "../web/src/**/*.{js,ts,jsx,tsx}",
    "../promo/src/**/*.{js,ts,jsx,tsx}",
  ],
  safelist: [
    // Arbitrary z-index values used in extension
    'z-[50]',
    'z-[60]', 
    'z-[70]',
    // Background opacity classes
    'bg-black/50',
    'bg-white/50',
    // Common utility classes that might be purged
    'translate-x-0',
    'translate-x-full',
    '-translate-x-full',
    'translate-y-0',
    '-translate-y-1/2',
    // Animation and transition classes
    'transition-transform',
    'duration-300',
    'ease-in-out',
    // Layout classes
    'fixed',
    'absolute',
    'inset-0',
    'max-w-md',
    'w-96',
    'h-screen',
    // Spacing classes
    'space-x-1',
    'space-y-2',
    'space-y-3',
    'space-y-4',
  ],
  theme: {
    extend: {
      colors: {
        // Find brand colors using CSS variables
        ink: "hsl(var(--ink))",
        oat: "hsl(var(--oat))",
        electric: "hsl(var(--electric))",
        mint: "hsl(var(--mint))",
        coral: "hsl(var(--coral))",
        
        // Design system colors
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
}
