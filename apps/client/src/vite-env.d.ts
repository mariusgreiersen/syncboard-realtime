/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute API origin when the client is hosted separately (default: same origin). */
  readonly VITE_API_URL?: string;
  /** Optional Socket.IO origin when hosted separately (default: same origin). */
  readonly VITE_SOCKET_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
