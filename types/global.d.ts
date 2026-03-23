export {};

declare global {
  type LooseRecord = Record<string, any>;
  type LooseFn = (...args: any[]) => any;

  interface Error {
    code?: string;
    status?: number;
    command?: string;
  }

  interface Window {
    __ARCHIMAP_CONFIG?: LooseRecord;
    __ARCHIMAP__?: LooseRecord;
    __APP_STATE__?: LooseRecord;
    __MAP_DEBUG__?: LooseRecord;
    maplibregl?: LooseRecord;
  }
}
