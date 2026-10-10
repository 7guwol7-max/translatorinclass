// window.api 타입 (preload 가 노출)
import type { RendererApi } from '../shared/types';

declare global {
  interface Window {
    api: RendererApi;
  }
}

export {};
