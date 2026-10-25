
import type { Config } from "tailwindcss";

export default {
	darkMode: ["class"],
	content: [
		"./pages/**/*.{ts,tsx}",
		"./components/**/*.{ts,tsx}",
		"./app/**/*.{ts,tsx}",
		"./src/**/*.{ts,tsx}",
	],
	prefix: "",
	theme: {
		container: {
			center: true,
			padding: '2rem',
			screens: {
				'2xl': '1400px'
			}
		},
		extend: {
			colors: {
				border: 'hsl(var(--border))',
				input: 'hsl(var(--input))',
				ring: 'hsl(var(--ring))',
				background: 'hsl(var(--background))',
				foreground: 'hsl(var(--foreground))',
				primary: {
					DEFAULT: 'hsl(var(--primary))',
					foreground: 'hsl(var(--primary-foreground))'
				},
				secondary: {
					DEFAULT: 'hsl(var(--secondary))',
					foreground: 'hsl(var(--secondary-foreground))'
				},
				destructive: {
					DEFAULT: 'hsl(var(--destructive))',
					foreground: 'hsl(var(--destructive-foreground))'
				},
				muted: {
					DEFAULT: 'hsl(var(--muted))',
					foreground: 'hsl(var(--muted-foreground))'
				},
				accent: {
					DEFAULT: 'hsl(var(--accent))',
					foreground: 'hsl(var(--accent-foreground))'
				},
				popover: {
					DEFAULT: 'hsl(var(--popover))',
					foreground: 'hsl(var(--popover-foreground))'
				},
				card: {
					DEFAULT: 'hsl(var(--card))',
					foreground: 'hsl(var(--card-foreground))'
				},
				sidebar: {
					DEFAULT: 'hsl(var(--sidebar-background))',
					foreground: 'hsl(var(--sidebar-foreground))',
					primary: 'hsl(var(--sidebar-primary))',
					'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
					accent: 'hsl(var(--sidebar-accent))',
					'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
					border: 'hsl(var(--sidebar-border))',
					ring: 'hsl(var(--sidebar-ring))'
				},
				// Custom colors for Pulse Robot
				pulse: {
					"50": "#fff7ed",
					"100": "#ffedd5",
					"200": "#fed7aa",
					"300": "#fdba74",
					"400": "#fb923c",
					"500": "#f97316", // Primary orange
					"600": "#ea580c",
					"700": "#c2410c",
					"800": "#9a3412",
					"900": "#7c2d12",
					"950": "#431407",
				},
				dark: {
					"900": "#121212", // Almost black
					"800": "#1e1e1e",
					"700": "#2d2d2d",
					"600": "#3d3d3d",
				},
				purple: {
					"900": "#4c1d95", // Dark purple
					"800": "#5b21b6",
					"700": "#6d28d9",
					"600": "#7c3aed",
				},
			},
			borderRadius: {
				lg: 'var(--radius)',
				md: 'calc(var(--radius) - 2px)',
				sm: 'calc(var(--radius) - 4px)'
			},
			keyframes: {
				'accordion-down': {
					from: { height: '0' },
					to: { height: 'var(--radix-accordion-content-height)' }
				},
				'accordion-up': {
					from: { height: 'var(--radix-accordion-content-height)' },
					to: { height: '0' }
				},
				// Scroll-triggered entrance animations
				'fade-in': {
					'0%': { opacity: '0', transform: 'translateY(20px)' },
					'100%': { opacity: '1', transform: 'translateY(0)' }
				},
				'fade-in-up': {
					'0%': { opacity: '0', transform: 'translateY(30px)' },
					'100%': { opacity: '1', transform: 'translateY(0)' }
				},
				'fade-in-down': {
					'0%': { opacity: '0', transform: 'translateY(-20px)' },
					'100%': { opacity: '1', transform: 'translateY(0)' }
				},
				'fade-in-right': {
					'0%': { opacity: '0', transform: 'translateX(-30px)' },
					'100%': { opacity: '1', transform: 'translateX(0)' }
				},
				'fade-in-left': {
					'0%': { opacity: '0', transform: 'translateX(30px)' },
					'100%': { opacity: '1', transform: 'translateX(0)' }
				},
				'scale-in': {
					'0%': { opacity: '0', transform: 'scale(0.95)' },
					'100%': { opacity: '1', transform: 'scale(1)' }
				},
				'scale-in-up': {
					'0%': { opacity: '0', transform: 'scale(0.95) translateY(20px)' },
					'100%': { opacity: '1', transform: 'scale(1) translateY(0)' }
				},
				'blur-in': {
					'0%': { opacity: '0', filter: 'blur(8px)', transform: 'translateY(10px)' },
					'100%': { opacity: '1', filter: 'blur(0)', transform: 'translateY(0)' }
				},
				// Continuous subtle animations
				'pulse-slow': {
					'0%, 100%': { opacity: '1' },
					'50%': { opacity: '0.7' }
				},
				'float': {
					'0%, 100%': { transform: 'translateY(0)' },
					'50%': { transform: 'translateY(-10px)' }
				},
				'float-slow': {
					'0%, 100%': { transform: 'translateY(0) rotate(0deg)' },
					'50%': { transform: 'translateY(-6px) rotate(1deg)' }
				},
				'shimmer': {
					'0%': { backgroundPosition: '-200% 0' },
					'100%': { backgroundPosition: '200% 0' }
				},
				'glow-pulse': {
					'0%, 100%': { boxShadow: '0 0 20px rgba(249, 115, 22, 0.3)' },
					'50%': { boxShadow: '0 0 40px rgba(249, 115, 22, 0.5)' }
				},
				// Stagger support (use with animation-delay)
				'stagger-fade-in': {
					'0%': { opacity: '0', transform: 'translateY(20px)' },
					'100%': { opacity: '1', transform: 'translateY(0)' }
				}
			},
			animation: {
				'accordion-down': 'accordion-down 0.2s ease-out',
				'accordion-up': 'accordion-up 0.2s ease-out',
				// Scroll-triggered (use with isInView trigger)
				'fade-in': 'fade-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards',
				'fade-in-up': 'fade-in-up 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards',
				'fade-in-down': 'fade-in-down 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards',
				'fade-in-right': 'fade-in-right 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards',
				'fade-in-left': 'fade-in-left 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards',
				'scale-in': 'scale-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards',
				'scale-in-up': 'scale-in-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards',
				'blur-in': 'blur-in 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards',
				// Continuous
				'pulse-slow': 'pulse-slow 3s ease-in-out infinite',
				'float': 'float 6s ease-in-out infinite',
				'float-slow': 'float-slow 8s ease-in-out infinite',
				'shimmer': 'shimmer 2s linear infinite',
				'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
				'stagger-fade-in': 'stagger-fade-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards'
			},
			backgroundImage: {
				'hero-gradient': 'linear-gradient(90deg, hsla(24, 100%, 83%, 1) 0%, hsla(341, 91%, 68%, 1) 100%)',
				'hero-gradient-2': 'linear-gradient(90deg, hsla(39, 100%, 77%, 1) 0%, hsla(22, 90%, 57%, 1) 100%)',
				'pulse-gradient': 'linear-gradient(180deg, rgba(249,115,22,0.8) 0%, rgba(249,115,22,0) 100%)',
			},
			fontFamily: {
				'sans': ['var(--font-instrument-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
				'serif': ['var(--font-instrument-serif)', 'ui-serif', 'Georgia', 'serif'],
				'display': ['Brockmann', 'var(--font-instrument-sans)', 'sans-serif'],
				'brockmann': ['Brockmann', 'serif'],
				'playfair': ['var(--font-playfair)', 'serif'],
			},
			boxShadow: {
				'elegant': '0 4px 20px rgba(0, 0, 0, 0.08)',
				'elegant-hover': '0 8px 30px rgba(0, 0, 0, 0.12)',
				'lifted': '0 20px 50px -20px rgba(0, 0, 0, 0.15)',
				'elevated': '0 10px 40px -15px rgba(0, 0, 0, 0.1)',
				'glow-sm': '0 0 15px rgba(249, 115, 22, 0.2)',
				'glow': '0 0 30px rgba(249, 115, 22, 0.3)',
				'inner-glow': 'inset 0 2px 20px rgba(255, 255, 255, 0.15)',
			'card': '0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.06)',
			'card-hover': '0 10px 30px rgba(0, 0, 0, 0.08), 0 2px 6px rgba(0, 0, 0, 0.04)',
			'card-dark': '0 1px 3px rgba(0, 0, 0, 0.5), 0 1px 2px rgba(0, 0, 0, 0.3)',
			'card-dark-hover': '0 10px 30px rgba(0, 0, 0, 0.6), 0 4px 8px rgba(0, 0, 0, 0.4)',
			'glow-pulse': '0 0 20px rgba(249, 115, 22, 0.3)',
			}
		}
	},
	plugins: [
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		require("tailwindcss-animate"),
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		require("@tailwindcss/typography"),
	],
} satisfies Config;
