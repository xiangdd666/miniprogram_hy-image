/**
 * 微信云开发中转云函数 (hy-image-gateway)
 * 部署在 wx8fae749cd90f6f96 对应的云环境 (cloud1-d8ghp6y0we80d7813) 中：
 * 1. 通过 wx-server-sdk 校验调用方微信身份 (OPENID)
 * 2. 生图模式：携带环境变量 GATEWAY_SECRET 请求生图网关
 * 3. saveToCloud 模式：由服务端代下载图片并上传至当前云环境存储，规避小程序真机 downloadFile 合法域名限制
 */

const https = require("node:https");
const http = require("node:http");
const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const DEFAULT_GATEWAY_URL =
  "https://dev-d9g8xcfbdbd81c81e-1540300852.ap-shanghai.app.tcloudbase.com/hy-image-gateway";
const DEFAULT_MODEL = "hy-image-v3.5-preview";
const REQUEST_TIMEOUT_MS = 55000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function buildErrorResponse(statusCode, code, message) {
  return {
    statusCode,
    body: {
      error: {
        code,
        message,
      },
    },
  };
}

function formatDateDir(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sanitizeFolder(folder) {
  const cleaned = String(folder || "")
    .replace(/[^a-zA-Z0-9/_-]/g, "")
    .replace(/^\/+|\/+$/g, "");
  return cleaned || `hy-images/${formatDateDir()}`;
}

function pickImageExtension(contentType) {
  const lower = String(contentType || "").toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  return "png";
}

function isBlockedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local")) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === "::1" || host.startsWith("[fe80:") || host.startsWith("[fc") || host.startsWith("[fd")) {
    return true;
  }
  return false;
}

/**
 * 向生图网关发送 JSON POST 请求
 */
function postJson(targetUrl, payload, gatewaySecret) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === "http:" ? http : https;
    const bodyText = JSON.stringify(payload);

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(bodyText, "utf8"),
          "x-gateway-token": gatewaySecret,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const rawText = Buffer.concat(chunks).toString("utf8");
          let parsedBody = rawText;
          try {
            parsedBody = rawText ? JSON.parse(rawText) : {};
          } catch (e) {
            parsedBody = {
              error: {
                code: "INVALID_UPSTREAM_RESPONSE",
                message: "生图网关返回非 JSON 响应",
              },
            };
          }
          resolve({
            statusCode: res.statusCode || 500,
            body: parsedBody,
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("REQUEST_TIMEOUT"));
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.write(bodyText);
    req.end();
  });
}

/**
 * 服务端下载 HTTPS 图片 Buffer（支持最多 3 次重定向并阻止内网地址）
 */
function downloadImageBuffer(imageUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(imageUrl);
    } catch (e) {
      reject(new Error("无效的图片 URL"));
      return;
    }

    if (parsed.protocol !== "https:" || isBlockedHost(parsed.hostname)) {
      reject(new Error("仅允许下载公网 HTTPS 图片地址"));
      return;
    }

    const req = https.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        timeout: DOWNLOAD_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            reject(new Error("图片地址重定向次数过多"));
            return;
          }
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, imageUrl).toString();
          } catch (e) {
            reject(new Error("图片重定向地址无效"));
            return;
          }
          downloadImageBuffer(nextUrl, redirectCount + 1).then(resolve, reject);
          return;
        }

        if (status !== 200) {
          res.resume();
          reject(new Error(`服务端下载图片失败 (HTTP ${status})`));
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        res.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_DOWNLOAD_BYTES) {
            req.destroy(new Error("图片体积超过 25MB 上限"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: String(res.headers["content-type"] || ""),
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("下载图片超时"));
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

function parseEventParams(event) {
  let params = event || {};
  if (params.body) {
    params = typeof params.body === "string" ? JSON.parse(params.body) : params.body;
  }
  return params || {};
}

async function handleSaveToCloud(params) {
  const imageUrl = String(params.imageUrl || "").trim();
  if (!imageUrl) {
    return buildErrorResponse(400, "INVALID_PARAMS", "缺少 imageUrl 参数");
  }

  const { buffer, contentType } = await downloadImageBuffer(imageUrl);
  const ext = pickImageExtension(contentType);
  const folder = sanitizeFolder(params.folder);
  const cloudPath = `${folder}/hy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;

  const uploadRes = await cloud.uploadFile({
    cloudPath,
    fileContent: buffer,
  });

  if (!uploadRes || !uploadRes.fileID) {
    return buildErrorResponse(500, "UPLOAD_FAILED", "云存储未返回有效 fileID");
  }

  return {
    statusCode: 200,
    body: {
      fileID: uploadRes.fileID,
      cloudPath,
    },
  };
}

async function handleGenerateImage(params) {
  const gatewaySecret = (process.env.GATEWAY_SECRET || "").trim();
  const gatewayUrl = (process.env.GATEWAY_URL || DEFAULT_GATEWAY_URL).trim();

  if (!gatewaySecret) {
    return buildErrorResponse(
      500,
      "CONFIG_MISSING",
      "中转云函数缺少环境变量 GATEWAY_SECRET，请在云开发控制台配置后重试"
    );
  }

  const requestData = {
    model: params.model || DEFAULT_MODEL,
    messages: params.messages || [],
    size: params.size,
    generate_max_pixels: params.generate_max_pixels,
    seed: params.seed,
    footnote: params.footnote,
    session: params.session,
    use_search_tool: params.use_search_tool,
    test: params.test === true ? true : undefined,
  };

  Object.keys(requestData).forEach((key) => {
    if (requestData[key] === undefined) {
      delete requestData[key];
    }
  });

  const upstream = await postJson(gatewayUrl, requestData, gatewaySecret);
  return {
    statusCode: upstream.statusCode,
    body: upstream.body,
  };
}

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext();
    if (!wxContext || !wxContext.OPENID) {
      return buildErrorResponse(401, "UNAUTHORIZED", "缺少有效的小程序用户身份");
    }

    const params = parseEventParams(event);
    if (params.action === "saveToCloud") {
      return await handleSaveToCloud(params);
    }
    return await handleGenerateImage(params);
  } catch (error) {
    console.error("[hy-image-gateway] 执行失败:", error && error.message);
    const isTimeout = error && error.message === "REQUEST_TIMEOUT";
    return buildErrorResponse(
      isTimeout ? 504 : 500,
      isTimeout ? "GATEWAY_TIMEOUT" : (error && error.code) || "INTERNAL_ERROR",
      isTimeout
        ? "请求生图网关超时（受微信云函数 60 秒上限约束，可尝试 1K / 1.5K 分辨率）"
        : (error && error.message) || "云函数执行出错"
    );
  }
};
