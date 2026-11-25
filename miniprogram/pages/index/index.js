// miniprogram/pages/index/index.js
const {
  generateImage,
  prepareReferenceImage,
  uploadUrlToCloudStorage,
  getCloudTempUrl,
} = require('../../utils/imageApi');
const {
  formatTimeLabel,
  listHistory,
  createHistoryRecord,
  updateHistoryCloudFile,
  softDeleteHistoryRecords,
} = require('../../utils/historyDb');
const {
  DEFAULT_CLOUD_ENV_ID,
  DEFAULT_CLOUD_FUNCTION_NAME,
  DEFAULT_CHANNEL,
  GALLERY_STORAGE_KEY,
  GALLERY_MAX_ITEMS,
  ensureCloudInitialized,
  saveRuntimeSettings,
} = require('../../utils/config');
const {
  STYLE_TAGS,
  SAMPLE_PROMPTS,
  RATIOS,
  MULTIPLIERS,
  LOADING_STAGES,
  createSessionId,
  resolveSizeSpec,
  validatePixelSize,
} = require('../../utils/studioPresets');

function isItemDisplayed(item, currentImageUrl) {
  if (!item || !currentImageUrl) return false;
  return (
    currentImageUrl === item.url ||
    Boolean(item.cloudFileId && currentImageUrl === item.cloudFileId)
  );
}

Page({
  data: {
    channel: DEFAULT_CHANNEL,
    mode: 'text2image',
    prompt: '',
    styleTags: STYLE_TAGS,

    // 参考图
    refImagePayloadUrl: '',
    refImageDisplay: '',
    refImageLabel: '',
    refUrlInput: '',

    // 比例与分辨率
    ratios: RATIOS,
    multipliers: MULTIPLIERS,
    selectedRatio: 'auto',
    selectedMultiplier: 'auto',
    customWidth: '1024',
    customHeight: '1024',
    currentSize: '',
    currentMaxPixels: 0,
    currentSizeLabel: '自动 (模型智能匹配)',

    // 高级参数
    showAdvanced: false,
    removeWatermark: true,
    footnote: '',
    useSearchTool: false,
    autoSaveCloud: true,
    seed: '0',
    sessionId: createSessionId(),

    // 运行状态
    isGenerating: false,
    isUploadingCloud: false,
    elapsedText: '0.0',
    progressPercent: 10,
    loadingStageText: LOADING_STAGES[0],
    statusType: 'idle',
    statusText: '等待创作',

    // 当前结果与多轮编辑
    currentImageUrl: '',
    currentCloudFileId: '',
    currentCloudTempUrl: '',
    round: 0,
    canMultiTurn: false,
    multiTurnPrompt: '',

    // 历史画廊与管理弹窗
    gallery: [],
    showHistoryManager: false,
    historySelectedMap: {},
    selectedHistoryCount: 0,
    isAllHistorySelected: false,
    isDeletingHistory: false,

    // 设置弹窗
    showSettings: false,
    draftChannel: DEFAULT_CHANNEL,
    draftEnvId: '',
    draftGatewayUrl: '',
    draftCloudFunc: '',
  },

  onLoad() {
    this._assembledHistory = [];
    this._timer = null;

    const app = getApp();
    const globalData = (app && app.globalData) || {};
    const savedGallery = wx.getStorageSync(GALLERY_STORAGE_KEY);

    this.setData({
      channel: globalData.channel || DEFAULT_CHANNEL,
      autoSaveCloud: globalData.autoSaveCloud !== undefined ? globalData.autoSaveCloud : true,
      gallery: Array.isArray(savedGallery) ? savedGallery : [],
    });
    this.updateCurrentSize();
    this.loadCloudHistory({ silent: true });
  },

  onUnload() {
    this.stopLoadingTimer();
  },

  noop() {},

  persistGallery(nextGallery) {
    wx.setStorageSync(GALLERY_STORAGE_KEY, nextGallery);
    return nextGallery;
  },

  // ================= 模式与输入 =================
  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode) {
      this.setData({ mode });
    }
  },

  onPromptInput(e) {
    this.setData({ prompt: e.detail.value });
  },

  fillRandomPrompt() {
    const idx = Math.floor(Math.random() * SAMPLE_PROMPTS.length);
    this.setData({ prompt: SAMPLE_PROMPTS[idx] });
  },

  clearPrompt() {
    this.setData({ prompt: '' });
  },

  appendStyleTag(e) {
    const tag = e.currentTarget.dataset.tag;
    if (!tag) return;
    const current = (this.data.prompt || '').trim();
    const next = current ? `${current}，${tag}` : tag;
    this.setData({ prompt: next.slice(0, 2000) });
  },

  // ================= 垫图选择与加载 =================
  async chooseRefImage() {
    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
      });
      if (!res.tempFiles || !res.tempFiles[0]) return;

      const tempFilePath = res.tempFiles[0].tempFilePath;
      wx.showLoading({ title: '正在处理垫图...', mask: true });

      const prepared = await prepareReferenceImage(tempFilePath, this.data.channel);
      this.setData({
        refImagePayloadUrl: prepared.url,
        refImageDisplay: tempFilePath,
        refImageLabel: prepared.label,
        refUrlInput: '',
      });
      wx.showToast({ title: '垫图已就绪', icon: 'success' });
    } catch (err) {
      if (err && err.errMsg && err.errMsg.includes('cancel')) return;
      wx.showToast({ title: (err && err.message) || '图片处理失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  onRefUrlInput(e) {
    this.setData({ refUrlInput: e.detail.value });
  },

  applyRefUrl() {
    const url = (this.data.refUrlInput || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      wx.showToast({ title: '请输入有效的 http/https 图片链接', icon: 'none' });
      return;
    }
    this.setData({
      refImagePayloadUrl: url,
      refImageDisplay: url,
      refImageLabel: '外链垫图已加载',
    });
    wx.showToast({ title: '已应用外链垫图', icon: 'success' });
  },

  clearRefImage() {
    this.setData({
      refImagePayloadUrl: '',
      refImageDisplay: '',
      refImageLabel: '',
      refUrlInput: '',
    });
  },

  previewRefImage() {
    if (!this.data.refImageDisplay) return;
    wx.previewImage({
      current: this.data.refImageDisplay,
      urls: [this.data.refImageDisplay],
    });
  },

  // ================= 尺寸与画质 =================
  selectRatio(e) {
    const selectedRatio = e.currentTarget.dataset.ratio;
    const nextData = { selectedRatio };
    if (selectedRatio === 'auto' && this.data.selectedMultiplier === 4) {
      nextData.selectedMultiplier = 'auto';
    }
    this.setData(nextData, () => this.updateCurrentSize());
  },

  selectMultiplier(e) {
    const rawVal = e.currentTarget.dataset.multiplier;
    const selectedMultiplier = rawVal === 'auto' ? 'auto' : Number(rawVal);
    this.setData({ selectedMultiplier }, () => this.updateCurrentSize());
  },

  onCustomWidthInput(e) {
    this.setData({ customWidth: e.detail.value }, () => this.updateCurrentSize());
  },

  onCustomHeightInput(e) {
    this.setData({ customHeight: e.detail.value }, () => this.updateCurrentSize());
  },

  updateCurrentSize() {
    const sizeSpec = resolveSizeSpec(this.data);
    this.setData(sizeSpec);
    return sizeSpec;
  },

  // ================= 高级参数 =================
  toggleAdvanced() {
    this.setData({ showAdvanced: !this.data.showAdvanced });
  },

  onWatermarkSwitch(e) {
    this.setData({ removeWatermark: e.detail.value });
  },

  onFootnoteInput(e) {
    this.setData({ footnote: e.detail.value });
  },

  onSearchSwitch(e) {
    this.setData({ useSearchTool: e.detail.value });
  },

  onSeedInput(e) {
    this.setData({ seed: e.detail.value });
  },

  randomizeSeed() {
    const rand = Math.floor(Math.random() * 2147483647);
    this.setData({ seed: String(rand) });
  },

  onSessionInput(e) {
    this.setData({ sessionId: e.detail.value });
  },

  resetSession() {
    this._assembledHistory = [];
    this.setData({
      sessionId: createSessionId(),
      round: 0,
      canMultiTurn: false,
      multiTurnPrompt: '',
    });
    wx.showToast({ title: '已开启全新会话', icon: 'none' });
  },

  // ================= 计时与加载态 =================
  startLoadingTimer() {
    this.stopLoadingTimer();
    const startAt = Date.now();
    this.setData({
      isGenerating: true,
      elapsedText: '0.0',
      progressPercent: 10,
      loadingStageText: LOADING_STAGES[0],
      statusType: 'working',
      statusText: '演算中',
    });

    this._timer = setInterval(() => {
      const elapsed = (Date.now() - startAt) / 1000;
      const stageIdx = Math.min(LOADING_STAGES.length - 1, Math.floor(elapsed / 4));
      const percent = Math.min(94, 10 + Math.floor(elapsed * 3.5));
      this.setData({
        elapsedText: elapsed.toFixed(1),
        progressPercent: percent,
        loadingStageText: LOADING_STAGES[stageIdx],
      });
    }, 250);
  },

  stopLoadingTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  // ================= 执行生图 =================
  async handleGenerate() {
    await this.runGeneration({ isMultiTurn: false });
  },

  onMultiTurnInput(e) {
    this.setData({ multiTurnPrompt: e.detail.value });
  },

  async handleMultiTurnGenerate() {
    await this.runGeneration({ isMultiTurn: true });
  },

  endMultiTurn() {
    this.resetSession();
  },

  buildGenerationMessages(promptText, isMultiTurn) {
    if (isMultiTurn && this._assembledHistory && this._assembledHistory.length > 0) {
      return [
        ...this._assembledHistory,
        { role: 'user', content: [{ type: 'text', text: promptText }] },
      ];
    }

    if (this.data.mode === 'image2image') {
      if (!this.data.refImagePayloadUrl) {
        wx.showToast({ title: '请先选择一张参考底图或切换为文生图', icon: 'none' });
        return null;
      }
      return [
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: this.data.refImagePayloadUrl } },
          ],
        },
      ];
    }

    return [
      {
        role: 'user',
        content: [{ type: 'text', text: promptText }],
      },
    ];
  },

  buildGenerationPayload(messages, sizeSpec) {
    const payload = {
      model: 'hy-image-v3.5-preview',
      messages,
      session: (this.data.sessionId || '').trim() || undefined,
    };

    if (sizeSpec.currentSize) {
      payload.size = sizeSpec.currentSize;
    } else if (sizeSpec.currentMaxPixels > 0) {
      payload.generate_max_pixels = sizeSpec.currentMaxPixels;
    }

    const seedNum = parseInt(this.data.seed, 10);
    if (seedNum > 0) {
      payload.seed = seedNum;
    }

    if (this.data.removeWatermark) {
      payload.footnote = ' ';
    } else if ((this.data.footnote || '').trim()) {
      payload.footnote = this.data.footnote.trim().slice(0, 16);
    }

    if (this.data.useSearchTool) {
      payload.use_search_tool = { value: true };
    }

    return payload;
  },

  async runGeneration({ isMultiTurn }) {
    if (this.data.isGenerating) return;

    const promptText = (isMultiTurn ? this.data.multiTurnPrompt : this.data.prompt).trim();
    if (!promptText) {
      wx.showToast({
        title: isMultiTurn ? '请输入修改要求' : '请输入画面描述提示词',
        icon: 'none',
      });
      return;
    }

    const sizeSpec = this.updateCurrentSize();
    const sizeCheck = validatePixelSize(sizeSpec.currentSize);
    if (!sizeCheck.valid) {
      wx.showToast({ title: sizeCheck.errorMessage, icon: 'none' });
      return;
    }

    const messages = this.buildGenerationMessages(promptText, isMultiTurn);
    if (!messages) return;

    const payload = this.buildGenerationPayload(messages, sizeSpec);

    this.startLoadingTimer();
    wx.pageScrollTo({ selector: '#result-section', duration: 280 });

    try {
      const resData = await generateImage(payload);
      const imageInfo = resData.choices[0].delta.image;
      const imageUrl = imageInfo.url;
      const resW = imageInfo.width || sizeCheck.width || 0;
      const resH = imageInfo.height || sizeCheck.height || 0;
      const actualSize = resW && resH ? `${resW}×${resH}` : '自动尺寸';

      this._assembledHistory = Array.isArray(resData.assembled_history)
        ? resData.assembled_history
        : [];
      const nextRound = this.data.round + 1;

      const itemId = `img_${Date.now()}`;
      const newItem = {
        id: itemId,
        dbId: '',
        url: imageUrl,
        cloudFileId: '',
        cloudTempUrl: '',
        prompt: promptText,
        size: actualSize,
        mode: isMultiTurn ? 'multi_turn' : this.data.mode,
        round: nextRound,
        time: formatTimeLabel(new Date()),
      };
      const nextGallery = this.persistGallery([newItem, ...this.data.gallery].slice(0, GALLERY_MAX_ITEMS));

      this.setData({
        currentImageUrl: imageUrl,
        currentCloudFileId: '',
        currentCloudTempUrl: '',
        round: nextRound,
        canMultiTurn: this._assembledHistory.length > 0,
        multiTurnPrompt: '',
        gallery: nextGallery,
        statusType: 'ready',
        statusText: `出图完成 · ${actualSize}`,
      });

      wx.showToast({
        title: isMultiTurn ? '多轮修改成功' : '生图成功',
        icon: 'success',
      });

      let createdDbId = '';
      try {
        createdDbId = await createHistoryRecord(newItem);
        if (createdDbId) {
          this.patchGalleryItem(itemId, imageUrl, { dbId: createdDbId });
        }
      } catch (dbErr) {
        console.warn('写入云数据库失败:', dbErr);
      }

      this.performCloudUpload(itemId, imageUrl, true, createdDbId);
    } catch (err) {
      console.error('生图失败:', err);
      this.setData({
        statusType: 'error',
        statusText: '生成失败',
      });
      wx.showModal({
        title: '生图失败',
        content: (err && err.message) || '请检查网络连接或通道设置',
        showCancel: false,
      });
    } finally {
      this.stopLoadingTimer();
      this.setData({ isGenerating: false, progressPercent: 100 });
    }
  },

  // ================= 云存储上传与结果操作 =================
  patchGalleryItem(itemId, sourceUrl, patch) {
    let matchedItem = null;
    const nextGallery = this.data.gallery.map((item) => {
      if ((itemId && item.id === itemId) || (sourceUrl && item.url === sourceUrl)) {
        matchedItem = { ...item, ...patch };
        return matchedItem;
      }
      return item;
    });
    this.persistGallery(nextGallery);

    const updateData = { gallery: nextGallery };
    if (sourceUrl && this.data.currentImageUrl === sourceUrl) {
      if (patch.cloudFileId !== undefined) updateData.currentCloudFileId = patch.cloudFileId;
      if (patch.cloudTempUrl !== undefined) updateData.currentCloudTempUrl = patch.cloudTempUrl;
    }
    this.setData(updateData);
    return matchedItem;
  },

  async syncUploadedCloudFile(itemId, sourceUrl, uploaded, explicitDbId = '') {
    const matchedItem = this.patchGalleryItem(itemId, sourceUrl, {
      cloudFileId: uploaded.fileID,
      cloudTempUrl: uploaded.tempFileURL || '',
    });

    const targetDbId = explicitDbId || (matchedItem && matchedItem.dbId) || '';
    try {
      if (targetDbId) {
        await updateHistoryCloudFile(targetDbId, uploaded.fileID);
      } else if (matchedItem) {
        const newDbId = await createHistoryRecord({
          ...matchedItem,
          cloudFileId: uploaded.fileID,
        });
        if (newDbId) {
          this.patchGalleryItem(itemId, sourceUrl, { dbId: newDbId });
        }
      }
    } catch (dbErr) {
      console.warn('更新云数据库 cloudFileId 失败:', dbErr);
    }
  },

  async performCloudUpload(itemId, sourceUrl, silent = false, explicitDbId = '') {
    if (!sourceUrl || this.data.isUploadingCloud) return;
    this.setData({ isUploadingCloud: true });

    try {
      const uploaded = await uploadUrlToCloudStorage(sourceUrl);
      await this.syncUploadedCloudFile(itemId, sourceUrl, uploaded, explicitDbId);

      if (!silent) {
        wx.showToast({ title: '已存入云存储', icon: 'success' });
      }
    } catch (err) {
      console.error('上传云存储失败:', err);
      if (silent) {
        wx.showToast({ title: '自动存云端失败，请稍后重试', icon: 'none' });
      } else {
        wx.showModal({
          title: '上传云存储失败',
          content: (err && err.message) || '请确认小程序已绑定云环境权限',
          showCancel: false,
        });
      }
    } finally {
      this.setData({ isUploadingCloud: false });
    }
  },

  previewCurrentImage() {
    if (!this.data.currentImageUrl) return;
    const urls = this.data.gallery.map((item) => item.cloudFileId || item.url);
    if (!urls.includes(this.data.currentImageUrl)) {
      urls.unshift(this.data.currentImageUrl);
    }
    wx.previewImage({
      current: this.data.currentImageUrl,
      urls,
    });
  },

  async reuseAsRef() {
    let url = this.data.currentImageUrl;
    if (!url) return;

    // 若当前显示的是 cloud:// 永久地址，则换取最新的 HTTPS 临时链接传给模型
    if (url.startsWith('cloud://') || this.data.currentCloudFileId) {
      const fileId = url.startsWith('cloud://') ? url : this.data.currentCloudFileId;
      try {
        wx.showLoading({ title: '准备垫图链接...', mask: true });
        const tempUrl = await getCloudTempUrl(fileId);
        if (tempUrl) url = tempUrl;
      } catch (e) {
        if (this.data.currentCloudTempUrl) url = this.data.currentCloudTempUrl;
      } finally {
        wx.hideLoading();
      }
    }

    this.setData({
      mode: 'image2image',
      refImagePayloadUrl: url,
      refImageDisplay: this.data.currentImageUrl,
      refImageLabel: '已设为当前参考底图',
      refUrlInput: url.startsWith('http') ? url : '',
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 250 });
    wx.showToast({ title: '已切换为参考生图', icon: 'success' });
  },

  async copyImageUrl() {
    const cloudFileId =
      this.data.currentCloudFileId ||
      (this.data.currentImageUrl && this.data.currentImageUrl.startsWith('cloud://')
        ? this.data.currentImageUrl
        : '');

    let url = this.data.currentImageUrl || '';
    let isCloudTempLink = false;

    if (cloudFileId) {
      wx.showLoading({ title: '生成临时链接...', mask: true });
      try {
        const freshUrl = await getCloudTempUrl(cloudFileId, 86400);
        if (freshUrl) {
          url = freshUrl;
          isCloudTempLink = true;
          const nextGallery = this.persistGallery(
            this.data.gallery.map((item) =>
              item.cloudFileId === cloudFileId ? { ...item, cloudTempUrl: freshUrl } : item
            )
          );
          this.setData({
            currentCloudTempUrl: freshUrl,
            gallery: nextGallery,
          });
        } else if (this.data.currentCloudTempUrl) {
          url = this.data.currentCloudTempUrl;
          isCloudTempLink = true;
        }
      } catch (e) {
        if (this.data.currentCloudTempUrl) {
          url = this.data.currentCloudTempUrl;
          isCloudTempLink = true;
        }
      } finally {
        wx.hideLoading();
      }
    }

    if (!url || url.startsWith('cloud://')) {
      wx.showToast({ title: '获取临时链接失败，请检查云存储权限', icon: 'none' });
      return;
    }

    wx.setClipboardData({
      data: url,
      success: () => {
        wx.showToast({
          title: isCloudTempLink ? '临时链接已复制 (24h有效)' : '直链已复制 (12h有效)',
          icon: 'none',
        });
      },
    });
  },

  // ================= 云端与本地历史画廊 =================
  selectHistoryItem(e) {
    const idx = e.currentTarget.dataset.index;
    const item = this.data.gallery[idx];
    if (!item) return;
    this.setData({
      currentImageUrl: item.cloudFileId || item.url,
      currentCloudFileId: item.cloudFileId || '',
      currentCloudTempUrl: item.cloudTempUrl || '',
      statusType: 'ready',
      statusText: item.cloudFileId ? `云端画作 · ${item.size}` : `历史画作 · ${item.size}`,
    });
  },

  async loadCloudHistory({ silent = false } = {}) {
    if (!wx.cloud || typeof wx.cloud.database !== 'function') return;
    if (!silent) {
      wx.showLoading({ title: '同步云端记录...', mask: true });
    }
    try {
      const remoteItems = await listHistory(GALLERY_MAX_ITEMS);
      const localList = Array.isArray(this.data.gallery) ? this.data.gallery : [];
      const localTempByFileId = {};
      localList.forEach((item) => {
        if (item.cloudFileId && item.cloudTempUrl) {
          localTempByFileId[item.cloudFileId] = item.cloudTempUrl;
        }
      });

      const mergedRemote = remoteItems.map((item) => ({
        ...item,
        cloudTempUrl: localTempByFileId[item.cloudFileId] || item.cloudTempUrl || '',
      }));

      const remoteClientIds = new Set(mergedRemote.map((item) => item.id));
      const localOnly = localList.filter((item) => !item.dbId && !remoteClientIds.has(item.id));
      const nextGallery = this.persistGallery(
        [...localOnly, ...mergedRemote].slice(0, GALLERY_MAX_ITEMS)
      );

      this.setData({ gallery: nextGallery });
      if (!silent) {
        wx.showToast({ title: `已同步 ${mergedRemote.length} 条云端记录`, icon: 'none' });
      }
    } catch (err) {
      console.warn('加载云端生图历史失败:', err);
      if (!silent) {
        wx.showToast({ title: '同步云端记录失败，请检查集合权限', icon: 'none' });
      }
    } finally {
      if (!silent) {
        wx.hideLoading();
      }
    }
  },

  async refreshCloudHistory() {
    await this.loadCloudHistory({ silent: false });
  },

  syncHistorySelectionState(nextMap) {
    const gallery = Array.isArray(this.data.gallery) ? this.data.gallery : [];
    const selectedHistoryCount = gallery.filter((item) => nextMap[item.id]).length;
    this.setData({
      historySelectedMap: nextMap,
      selectedHistoryCount,
      isAllHistorySelected: gallery.length > 0 && selectedHistoryCount === gallery.length,
    });
  },

  openHistoryManager() {
    this.setData({
      showHistoryManager: true,
      historySelectedMap: {},
      selectedHistoryCount: 0,
      isAllHistorySelected: false,
    });
  },

  closeHistoryManager() {
    this.setData({ showHistoryManager: false });
  },

  toggleSelectHistoryItem(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const nextMap = { ...this.data.historySelectedMap };
    if (nextMap[id]) {
      delete nextMap[id];
    } else {
      nextMap[id] = true;
    }
    this.syncHistorySelectionState(nextMap);
  },

  toggleSelectAllHistory() {
    const gallery = Array.isArray(this.data.gallery) ? this.data.gallery : [];
    if (gallery.length === 0) return;

    if (this.data.isAllHistorySelected) {
      this.syncHistorySelectionState({});
      return;
    }

    const nextMap = {};
    gallery.forEach((item) => {
      nextMap[item.id] = true;
    });
    this.syncHistorySelectionState(nextMap);
  },

  deleteSingleHistoryItem(e) {
    const idx = e.currentTarget.dataset.index;
    const item = this.data.gallery[idx];
    if (!item || this.data.isDeletingHistory) return;
    this.executeSoftDeleteItems([item], `确认删除「${(item.prompt || '该生图记录').slice(0, 18)}」吗？`);
  },

  deleteSelectedHistory() {
    if (this.data.isDeletingHistory) return;
    const selectedItems = (this.data.gallery || []).filter(
      (item) => this.data.historySelectedMap[item.id]
    );
    if (selectedItems.length === 0) return;
    this.executeSoftDeleteItems(selectedItems, `确认删除选中的 ${selectedItems.length} 条历史记录吗？`);
  },

  executeSoftDeleteItems(itemsToDelete, confirmMessage) {
    if (!Array.isArray(itemsToDelete) || itemsToDelete.length === 0) return;

    wx.showModal({
      title: '删除历史记录',
      content: confirmMessage,
      confirmColor: '#f43f5e',
      success: async (res) => {
        if (!res.confirm) return;

        this.setData({ isDeletingHistory: true });
        wx.showLoading({ title: '正在删除...', mask: true });
        try {
          const dbIds = itemsToDelete.map((item) => item.dbId).filter(Boolean);
          if (dbIds.length > 0) {
            await softDeleteHistoryRecords(dbIds);
          }

          const deleteIdSet = new Set(itemsToDelete.map((item) => item.id));
          const nextGallery = this.persistGallery(
            (this.data.gallery || []).filter((item) => !deleteIdSet.has(item.id))
          );

          const nextMap = { ...this.data.historySelectedMap };
          deleteIdSet.forEach((id) => delete nextMap[id]);

          const currentDeleted = itemsToDelete.some((item) =>
            isItemDisplayed(item, this.data.currentImageUrl)
          );

          const patch = {
            gallery: nextGallery,
            showHistoryManager: nextGallery.length > 0 ? this.data.showHistoryManager : false,
          };
          if (currentDeleted) {
            patch.currentImageUrl = '';
            patch.currentCloudFileId = '';
            patch.currentCloudTempUrl = '';
            patch.statusType = 'idle';
            patch.statusText = '等待创作';
          }

          this.setData(patch, () => this.syncHistorySelectionState(nextMap));
          wx.showToast({ title: `已删除 ${itemsToDelete.length} 条记录`, icon: 'success' });
        } catch (err) {
          console.warn('软删除历史记录失败:', err);
          wx.showToast({ title: '删除失败，请检查数据库权限', icon: 'none' });
        } finally {
          wx.hideLoading();
          this.setData({ isDeletingHistory: false });
        }
      },
    });
  },

  // ================= 通道设置弹窗 =================
  openSettings() {
    const app = getApp();
    const globalData = (app && app.globalData) || {};
    this.setData({
      showSettings: true,
      draftChannel: globalData.channel || DEFAULT_CHANNEL,
      draftEnvId: globalData.env || DEFAULT_CLOUD_ENV_ID,
      draftGatewayUrl: globalData.gatewayUrl || '',
      draftCloudFunc: globalData.cloudFunctionName || DEFAULT_CLOUD_FUNCTION_NAME,
    });
  },

  closeSettings() {
    this.setData({ showSettings: false });
  },

  selectDraftChannel(e) {
    this.setData({ draftChannel: e.currentTarget.dataset.channel });
  },

  onDraftEnvInput(e) {
    this.setData({ draftEnvId: e.detail.value });
  },

  onDraftGatewayInput(e) {
    this.setData({ draftGatewayUrl: e.detail.value });
  },

  onDraftFuncInput(e) {
    this.setData({ draftCloudFunc: e.detail.value });
  },

  saveSettings() {
    const app = getApp();
    const gatewayUrl = (this.data.draftGatewayUrl || '').trim();
    if (this.data.draftChannel === 'http' && !/^https?:\/\//i.test(gatewayUrl)) {
      wx.showToast({ title: '请填写有效的 HTTP 网关地址', icon: 'none' });
      return;
    }

    const nextSettings = saveRuntimeSettings({
      channel: this.data.draftChannel,
      envId: this.data.draftEnvId,
      gatewayUrl,
      cloudFunctionName: this.data.draftCloudFunc,
      autoSaveCloud: this.data.autoSaveCloud,
    });

    if (app && app.globalData) {
      app.globalData.channel = nextSettings.channel;
      app.globalData.env = nextSettings.envId;
      app.globalData.gatewayUrl = nextSettings.gatewayUrl;
      app.globalData.cloudFunctionName = nextSettings.cloudFunctionName;
      app.globalData.cloudReady = ensureCloudInitialized(nextSettings.envId);
    } else {
      ensureCloudInitialized(nextSettings.envId);
    }

    this.setData({
      channel: nextSettings.channel,
      showSettings: false,
    });
    wx.showToast({ title: '通道设置已保存', icon: 'success' });
  },
});
