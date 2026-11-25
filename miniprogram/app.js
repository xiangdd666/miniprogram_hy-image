// app.js
const { loadRuntimeSettings, ensureCloudInitialized } = require('./utils/config');

App({
  onLaunch() {
    const savedSettings = loadRuntimeSettings();

    this.globalData = {
      // 当前小程序绑定的云开发环境 ID
      env: savedSettings.envId,
      // 调用通道：
      // - 'cloud': 默认推荐，通过 wx.cloud.callFunction 调用本环境云函数中转生图（免域名配置、鉴权安全）
      // - 'http': 仅用于自定义调试网关
      channel: savedSettings.channel,
      // 不在前端默认暴露受保护的生图网关地址
      gatewayUrl: savedSettings.gatewayUrl,
      cloudFunctionName: savedSettings.cloudFunctionName,
      // 默认自动保存生成结果到云存储
      autoSaveCloud: savedSettings.autoSaveCloud,
      cloudReady: false,
    };

    this.globalData.cloudReady = ensureCloudInitialized(this.globalData.env);
  },
});
