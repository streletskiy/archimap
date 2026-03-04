/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{svelte,js,ts}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Manrope', 'Segoe UI', 'Roboto', 'Arial', 'sans-serif']
      },
      colors: {
        brand: {
          ink: '#0F172A',
          mute: '#64748B',
          purple: '#5B62F0',
          coral: '#FF6B7F'
        }
      },
      boxShadow: {
        float: '0 20px 40px rgba(15, 23, 42, 0.12)',
        soft: '0 8px 20px rgba(15, 23, 42, 0.06)'
      }
    }
  },
  plugins: []
};
