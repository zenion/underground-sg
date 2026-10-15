/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Where the public map files are: a path on this origin (default "/public") or an https URL,
   * such as the R2 bucket's. Read at build time.
   */
  readonly VITE_PUBLIC_BASE?: string;
}
