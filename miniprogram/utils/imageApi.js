/**
 * Hy-Image 3.5 AI 生图接口适配层
 * 支持双通道切换：
 * 1. cloud 通道（默认推荐，正式号适用）：wx.cloud.callFunction 调用云开发原生通道，合规且免域名配置
 * 2. http 通道（调试/测试号可用）：wx.request 直连自定义 HTTP 网关
 */

const {
  DEFAULT_CLOUD_ENV_ID,
  DEFAULT_CLOUD_FUNCTION_NAME,
  DEFAULT_CHANNEL,
  ensureCloudInitialized,
} = require('./config');

function buildDateFolder() {
  const now = new Date();
  const dateDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
  return `hy-images/${dateDir}`;
}

/**
 * 统一解包云函数 / HTTP 网关返回数据
 */
function unwrapGatewayResponse(rawData) {
  let data = rawData;

  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (e) {
      throw new Error('服务返回非 JSON 响应');
    }
  }

  // 兼容云函数标准集成响应包装 { statusCode, headers, body }
  if (data && data.body !== undefined) {
    if (typeof data.body === 'string') {
      try {
        data = JSON.parse(data.body);
      } catch (e) {}
    } else if (typeof data.body === 'object' && data.body !== null) {
      data = data.body;
    }
  }

  if (data && data.data && data.data.choices) {
    data = data.data;
  }

  return data;
}

/**
 * 格式化可读错误提示
 */
function normalizeApiError(errMsg, statusCode) {
  const msg = String(errMsg || '生图请求失败');
  if (statusCode === 401 || msg.includes('UNAUTHORIZED') || msg.includes('CONFIG_MISSING')) {
    return '网关鉴权或配置异常：请确认 hy-image-gateway 云函数已上传部署，且其环境变量配置与生图网关一致。';
  }
  if (msg.includes('AI_CHANNEL_NOT_ALLOWED')) {
    return '渠道受限：请确认通过云函数中转网关调用，并核对生图网关所属环境额度。';
  }
  if (msg.includes('url not in domain list')) {
    return '域名未在合法列表：请在开发者工具右上角「详情 -> 本地设置」勾选“不校验合法域名”，或使用云函数通道。';
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('GATEWAY_TIMEOUT')) {
    return '生图超时：请尝试使用 1K / 1.5K 分辨率（微信云函数单次上限 60 秒）。';
  }
  if (statusCode === 422) {
    return `内容安全审核未通过：${msg}`;
  }
  if (statusCode === 429) {
    return '当前并发请求过多，请稍等几秒后再试。';
  }
  return msg;
}

/**
 * 将本地图片转换为可发送给 hy-image-v3.5-preview 的地址
 * - cloud 模式：上传至云存储并返回临时链接（默认 24 小时有效，省流量且不占请求体）
 * - http 模式：优先压缩后转为 Base64 Data URL
 */
async function prepareReferenceImage(filePath, channel) {
  if (channel === 'cloud' && wx.cloud) {
    const extMatch = /\.([a-zA-Z0-9]+)$/.exec(filePath);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const cloudPath = `hy-studio-refs/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const uploadRes = await wx.cloud.uploadFile({
      cloudPath,
      filePath,
    });

    const tempUrl = await getCloudTempUrl(uploadRes.fileID);
    if (tempUrl) {
      return {
        url: tempUrl,
        label: '云存储垫图已就绪',
      };
    }
    throw new Error('获取云存储图片临时链接失败');
  }

  // HTTP 网关模式：先适度压缩防止 Base64 体积过大，再转 Data URL
  let targetPath = filePath;
  try {
    const compressed = await new Promise((resolve, reject) => {
      wx.compressImage({
        src: filePath,
        quality: 82,
        success: resolve,
        fail: reject,
      });
    });
    if (compressed && compressed.tempFilePath) {
      targetPath = compressed.tempFilePath;
    }
  } catch (e) {
    // 压缩失败则回退原图
  }

  const base64 = await new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: targetPath,
      encoding: 'base64',
      success: (res) => resolve(res.data),
      fail: reject,
    });
  });

  const mime = /\.png$/i.test(targetPath) ? 'image/png' : 'image/jpeg';
  return {
    url: `data:${mime};base64,${base64}`,
    label: '本地图片已转码',
  };
}

/**
 * 调用 hy-image-v3.5-preview 生成图片
 */
async function generateImage(payload, options = {}) {
  const app = getApp();
  const globalData = (app && app.globalData) || {};
  const channel = options.channel || globalData.channel || DEFAULT_CHANNEL;
  const gatewayUrl = options.gatewayUrl || globalData.gatewayUrl;
  const cloudFunctionName =
    options.cloudFunctionName || globalData.cloudFunctionName || DEFAULT_CLOUD_FUNCTION_NAME;

  let rawResult;
  let httpStatus = 200;

  if (channel === 'cloud') {
    if (!wx.cloud) {
      throw new Error('当前基础库不支持 wx.cloud，请升级基础库后重试');
    }
    try {
      const res = await wx.cloud.callFunction({
        name: cloudFunctionName,
        data: payload,
      });
      rawResult = res.result;
      if (rawResult && typeof rawResult.statusCode === 'number') {
        httpStatus = rawResult.statusCode;
      }
    } catch (err) {
      const msg = err && (err.errMsg || err.message) ? err.errMsg || err.message : '云函数调用失败';
      throw new Error(normalizeApiError(msg));
    }
  } else {
    rawResult = await new Promise((resolve, reject) => {
      wx.request({
        url: gatewayUrl,
        method: 'POST',
        timeout: 300000, // 300 秒宽裕超时，适配 2K/4K 复杂画面
        header: {
          'Content-Type': 'application/json',
        },
        data: payload,
        success: (res) => {
          httpStatus = res.statusCode;
          resolve(res.data);
        },
        fail: (err) => {
          reject(new Error(normalizeApiError(err.errMsg || '网络请求失败')));
        },
      });
    });
  }

  const data = unwrapGatewayResponse(rawResult);

  if (httpStatus >= 400) {
    const errMsg = (data && data.error && data.error.message) || (data && data.message) || `HTTP ${httpStatus}`;
    throw new Error(normalizeApiError(errMsg, httpStatus));
  }

  if (data && data.error) {
    throw new Error(normalizeApiError(data.error.message || JSON.stringify(data.error), httpStatus));
  }

  if (!data || !data.choices || !data.choices[0] || !data.choices[0].delta || !data.choices[0].delta.image) {
    throw new Error('返回数据格式异常，未找到生成图片字段 choices[0].delta.image');
  }

  return data;
}

/**
 * 将生成的图片 URL 下载后上传至微信云开发云存储
 * @param {string} imageUrl 模型返回的临时图片 URL
 * @param {object} options 可选参数 { folder, envId, cloudFunctionName }
 * @returns {Promise<{fileID: string, cloudPath: string, tempFileURL: string}>}
 */
async function uploadUrlToCloudStorage(imageUrl, options = {}) {
  if (!imageUrl) {
    throw new Error('缺少可上传的图片地址');
  }
  if (!wx.cloud || typeof wx.cloud.uploadFile !== 'function') {
    throw new Error('当前基础库不支持 wx.cloud.uploadFile，请升级基础库至 2.2.3 以上');
  }

  const app = getApp();
  const globalData = (app && app.globalData) || {};
  const envId = options.envId || globalData.env || DEFAULT_CLOUD_ENV_ID;
  const cloudFunctionName =
    options.cloudFunctionName || globalData.cloudFunctionName || DEFAULT_CLOUD_FUNCTION_NAME;

  ensureCloudInitialized(envId);

  let fileID = '';
  let cloudPath = '';

  // 优先走云函数服务端代下载并转存云存储，规避小程序真机 downloadFile 合法域名校验限制
  if (typeof wx.cloud.callFunction === 'function') {
    try {
      const fnRes = await wx.cloud.callFunction({
        name: cloudFunctionName,
        data: {
          action: 'saveToCloud',
          imageUrl,
          folder: options.folder,
        },
      });
      const unwrapped = unwrapGatewayResponse(fnRes && fnRes.result);
      if (unwrapped && unwrapped.fileID) {
        fileID = unwrapped.fileID;
        cloudPath = unwrapped.cloudPath || '';
      }
    } catch (e) {
      // 若云函数尚未升级或失败，再尝试前端下载上传兜底
    }
  }

  if (!fileID) {
    // 1. 兜底：下载到小程序本地临时路径（需配置 downloadFile 合法域名或开启不校验域名）
    const downloadRes = await new Promise((resolve, reject) => {
      wx.downloadFile({
        url: imageUrl,
        success: resolve,
        fail: reject,
      });
    });

    if (downloadRes.statusCode !== 200 || !downloadRes.tempFilePath) {
      throw new Error(`下载图片失败 (HTTP ${downloadRes.statusCode || 'unknown'})`);
    }

    // 2. 构造有序的云端路径: hy-images/2026-11-25/hy_xxx.png
    const folder = options.folder || buildDateFolder();
    cloudPath = `${folder}/hy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`;

    // 3. 调用 wx.cloud.uploadFile 上传至云存储
    let uploadRes;
    try {
      uploadRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath: downloadRes.tempFilePath,
      });
    } catch (err) {
      const rawMsg = (err && (err.errMsg || err.message)) || '上传云存储失败';
      if (
        rawMsg.includes('not found') ||
        rawMsg.includes('permission') ||
        rawMsg.includes('auth') ||
        rawMsg.includes('INVALID_ENV') ||
        rawMsg.includes('-501000') ||
        rawMsg.includes('-404011')
      ) {
        throw new Error(
          `云存储上传权限受限 (${rawMsg})。\n\n说明：请确认当前小程序 AppID 已绑定云环境 ${envId}，且云存储权限允许当前用户上传。`
        );
      }
      throw new Error(rawMsg);
    }

    fileID = uploadRes && uploadRes.fileID;
  }

  if (!fileID) {
    throw new Error('云存储未返回有效 fileID');
  }

  // 4. 换取公网可访问临时/HTTPS URL 方便复制与分享
  let tempFileURL = '';
  try {
    tempFileURL = await getCloudTempUrl(fileID);
  } catch (e) {
    // fileID 本身即可在小程序 <image> 中永久展示，忽略换链失败
  }

  return {
    fileID,
    cloudPath,
    tempFileURL,
  };
}

/**
 * 通过 cloud:// fileID 获取可访问的 HTTPS 临时链接
 * @param {string} fileID 云存储 fileID
 * @param {number} maxAge 有效期（秒），默认 86400 秒（24 小时）
 */
async function getCloudTempUrl(fileID, maxAge = 86400) {
  if (!fileID || !wx.cloud) return '';
  const res = await wx.cloud.getTempFileURL({
    fileList: [
      {
        fileID,
        maxAge,
      },
    ],
  });
  const item = res && res.fileList && res.fileList[0];
  return (item && item.tempFileURL) || '';
}

module.exports = {
  unwrapGatewayResponse,
  generateImage,
  prepareReferenceImage,
  normalizeApiError,
  uploadUrlToCloudStorage,
  getCloudTempUrl,
};
