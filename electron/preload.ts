import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getVaultSecret: () => ipcRenderer.invoke('get-vault-secret'),
  setVaultSecret: (secret: string) => ipcRenderer.invoke('set-vault-secret', secret),
  isFirstRun: () => ipcRenderer.invoke('is-first-run'),
  completeSetup: () => ipcRenderer.invoke('complete-setup'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  testApiKey: (provider: string, key: string) => ipcRenderer.invoke('test-api-key', provider, key),
  loadMainApp: () => ipcRenderer.invoke('load-main-app'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  resetAllData: () => ipcRenderer.invoke('reset-all-data'),
  getLaunchOnStartup: () => ipcRenderer.invoke('get-launch-on-startup'),
  setLaunchOnStartup: (enabled: boolean) => ipcRenderer.invoke('set-launch-on-startup', enabled),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  isOnboardingComplete: () => ipcRenderer.invoke('is_onboarding_complete'),
  completeOnboarding: () => ipcRenderer.invoke('complete_onboarding'),
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
  setBackendUrl: (url: string) => ipcRenderer.invoke('set-backend-url', url),
});