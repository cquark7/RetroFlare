declare global {
  interface Env {
    ASSETS: Fetcher;
    TEAM_RETRO: DurableObjectNamespace;
    TEAM_OBJECT_NAME: string;
    ALLOWED_EMAIL_DOMAIN?: string;
    ACCESS_TEAM_ISSUER?: string;
    ACCESS_AUD?: string;
    APP_ORIGIN?: string;
    ADMIN_EMAILS?: string;
    DEV_AUTH?: string;
    DEV_ADMIN_IDENTITY?: string;
    DEV_DEFAULT_IDENTITY?: string;
  }
}

export {};
