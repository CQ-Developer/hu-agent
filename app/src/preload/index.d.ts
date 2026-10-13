import type { HuAgentApi } from './index'

declare global {
  interface Window {
    huAgent: HuAgentApi
  }
}

export {}
