import nodeAdapter from '@sveltejs/adapter-node';
import type { Config } from '@sveltejs/kit';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: nodeAdapter({
      out: 'build'
    }),
    alias: {
      $lib: './src/lib'
    }
  }
} satisfies Config;

export default config;
