import { contextBridge, ipcRenderer } from 'electron'

export interface HuAgentApi {
  getVersion(): Promise<string>
}

const api: HuAgentApi = {
  getVersion: () => ipcRenderer.invoke('app:get-version') as Promise<string>,
}

contextBridge.exposeInMainWorld('huAgent', api)
