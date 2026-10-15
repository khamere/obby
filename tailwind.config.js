/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      colors: {
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
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
          4: "hsl(var(--chart-4))",
          5: "hsl(var(--chart-5))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        discord: {
          // Every colour is a CSS variable (see :root in index.css) so
          // themes can change them without touching components.
          primary: "rgb(var(--obby-primary) / <alpha-value>)",
          green: "rgb(var(--obby-green) / <alpha-value>)",
          yellow: "rgb(var(--obby-yellow) / <alpha-value>)",
          fuchsia: "rgb(var(--obby-fuchsia) / <alpha-value>)",
          red: "rgb(var(--obby-red) / <alpha-value>)",
          // Discord UI Colors
          "dark-100": "rgb(var(--obby-bg-input) / <alpha-value>)", // chat input background
          "dark-200": "rgb(var(--obby-bg-base) / <alpha-value>)", // main background
          "dark-300": "rgb(var(--obby-bg-sidebar) / <alpha-value>)", // server list background
          "dark-400": "rgb(var(--obby-bg-deep) / <alpha-value>)", // very dark background
          "dark-500": "rgb(var(--obby-icon) / <alpha-value>)", // icons
          "dark-600": "rgb(var(--obby-bg-member) / <alpha-value>)", // server member list
          // Message colors
          "message-hover": "rgb(var(--obby-bg-hover) / <alpha-value>)",
          // Text colors
          "text-normal": "rgb(var(--obby-fg) / <alpha-value>)",
          "text-muted": "rgb(var(--obby-fg-muted) / <alpha-value>)",
          "text-link": "rgb(var(--obby-link) / <alpha-value>)",
          "channels-default": "rgb(var(--obby-fg-channel) / <alpha-value>)",
          "channels-active": "rgb(var(--obby-fg-channel-active) / <alpha-value>)",
          // Button colors
          "button-success-default": "rgb(var(--obby-success) / <alpha-value>)",
          "button-success-hover": "rgb(var(--obby-success-hover) / <alpha-value>)",
          "button-secondary-default": "rgb(var(--obby-button-secondary) / <alpha-value>)",
          // Unified reply accent — used for reply bar, quote line, swipe icon, toolbar button
          "reply": "rgb(var(--obby-reply) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["Roboto Mono", "monospace"],
        mono: ["Roboto Mono", "monospace"],
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        'fade-in': 'fadeIn 0.2s ease-in-out',
        'slide-in': 'slideIn 0.2s ease-in-out',
        'pulse-bright': 'pulseBright 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideIn: {
          '0%': { transform: 'translateX(10px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        pulseBright: {
          '0%, 100%': { filter: 'brightness(1)' },
          '50%': { filter: 'brightness(1.6)' },
        },
      },
      container: {
        center: true,
        padding: {
          DEFAULT: '1rem',
          sm: '2rem',
          lg: '4rem',
          xl: '5rem',
          '2xl': '6rem',
        },
        screens: {
          sm: '640px',
          md: '768px',
          lg: '1024px',
          xl: '1280px',
          '2xl': '1536px',
        },
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    require("daisyui"),
  ],
  daisyui: {
    themes: [
      {
        discord: {
          primary: "#5865F2",
          secondary: "#4F545C",
          accent: "#00AFF4",
          neutral: "#36393F",
          "base-100": "#2F3136",
          "base-200": "#36393F",
          "base-300": "#202225",
          info: "#00AFF4",
          success: "#57F287",
          warning: "#FEE75C",
          error: "#ED4245",
        },
      },
    ],
  },
};
