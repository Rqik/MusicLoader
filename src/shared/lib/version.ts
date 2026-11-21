import { version } from '../../../package.json';

export function getAppVersion(): string {
  return typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome.runtime.getManifest().version : version;
}
