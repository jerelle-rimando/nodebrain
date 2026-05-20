/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brain: {
          bg: '#06070b',
          surface: '#0f1118',
          elevated: '#0a0a0f',
          deep: '#141622',
          border: '#1f2235',
          'border-dim': '#161827',
          'border-bright': '#2a2e47',
          accent: '#2dd4bf',
          'accent-dim': '#14b8a6',
          'accent-deep': '#0f766e',
          'accent-deep-dim': '#0d9488',
          'accent-glow': 'rgba(94, 234, 212, 0.25)',
          muted: '#374151',
          text: '#e4e6f0',
          'text-dim': '#9094ab',
          'text-muted': '#5a5e75',
          success: '#10b981',
          warning: '#f59e0b',
          error: '#ef4444',
          info: '#3b82f6',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['Inter var', 'Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 3s linear infinite',
        'fade-in': 'fadeIn 0.3s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'marquee': 'marquee 4s linear',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        marquee: {
          '0%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(-100%)' },
        },
      },
    },
  },
  plugins: [],
};