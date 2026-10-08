/// <reference types="vite/client" />

declare const __RETROFLARE_LOCAL_DEVELOPMENT__: boolean;

interface ImportMetaEnv {
  readonly VITE_GIPHY_API_KEY?: string;
}
