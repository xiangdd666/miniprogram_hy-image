/**
 * 小程序运行时配置与云环境初始化封装
 */

const DEFAULT_CLOUD_ENV_ID = 'cloud1-d8ghp6y0we80d7813';
const DEFAULT_CLOUD_FUNCTION_NAME = 'hy-image-gateway';
const DEFAULT_CHANNEL = 'cloud';

const SETTINGS_STORAGE_KEY = 'hy_studio_settings';
const GALLERY_STORAGE_KEY = 'hy_studio_gallery';
const GALLERY_MAX_ITEMS = 20;

const LEGACY_DEV_ENV_ID = 'dev-d9g8xcfbdbd81c81e';

function ensureCloudInitialized(envId) {
  if (!wx.cloud || typeof wx.cloud.init !== 'function') {
    return false;
  }
  try {
    wx.cloud.init({
      env: envId || DEFAULT_CLOUD_ENV_ID,
      traceUser: true,
    });
    return true;
  } catch (err) {
    console.warn('wx.cloud.init 初始化失败:', err);
    return false;
  }
}

function loadRuntimeSettings() {
  const raw = wx.getStorageSync(SETTINGS_STORAGE_KEY) || {};
  const isLegacyDevEnv =
    raw.envId === LEGACY_DEV_ENV_ID ||
    (typeof raw.gatewayUrl === 'string' && raw.gatewayUrl.includes(LEGACY_DEV_ENV_ID));

  if (!raw.relayMigrated && isLegacyDevEnv) {
    const migrated = {
      channel: DEFAULT_CHANNEL,
      envId: DEFAULT_CLOUD_ENV_ID,
      gatewayUrl: '',
      cloudFunctionName: raw.cloudFunctionName || DEFAULT_CLOUD_FUNCTION_NAME,
      autoSaveCloud: true,
      relayMigrated: true,
    };
    wx.setStorageSync(SETTINGS_STORAGE_KEY, migrated);
    return migrated;
  }

  return {
    channel: raw.channel || DEFAULT_CHANNEL,
    envId: raw.envId || DEFAULT_CLOUD_ENV_ID,
    gatewayUrl: raw.gatewayUrl || '',
    cloudFunctionName: raw.cloudFunctionName || DEFAULT_CLOUD_FUNCTION_NAME,
    autoSaveCloud: raw.autoSaveCloud !== undefined ? Boolean(raw.autoSaveCloud) : true,
    relayMigrated: Boolean(raw.relayMigrated),
  };
}

function saveRuntimeSettings(settings) {
  const normalized = {
    channel: settings.channel || DEFAULT_CHANNEL,
    envId: (settings.envId || '').trim() || DEFAULT_CLOUD_ENV_ID,
    gatewayUrl: (settings.gatewayUrl || '').trim(),
    cloudFunctionName: (settings.cloudFunctionName || '').trim() || DEFAULT_CLOUD_FUNCTION_NAME,
    autoSaveCloud: settings.autoSaveCloud !== undefined ? Boolean(settings.autoSaveCloud) : true,
    relayMigrated: true,
  };
  wx.setStorageSync(SETTINGS_STORAGE_KEY, normalized);
  return normalized;
}

module.exports = {
  DEFAULT_CLOUD_ENV_ID,
  DEFAULT_CLOUD_FUNCTION_NAME,
  DEFAULT_CHANNEL,
  SETTINGS_STORAGE_KEY,
  GALLERY_STORAGE_KEY,
  GALLERY_MAX_ITEMS,
  ensureCloudInitialized,
  loadRuntimeSettings,
  saveRuntimeSettings,
};
