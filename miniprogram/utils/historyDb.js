/**
 * 微信云开发数据库 (hy_image_history) 持久化封装
 * 集合权限建议设为「仅创建者可读写」，_openid 由 wx.cloud.database() 自动维护，禁止手动写入。
 */

const COLLECTION_NAME = 'hy_image_history';

function getDatabase() {
  if (!wx.cloud || typeof wx.cloud.database !== 'function') {
    return null;
  }
  return wx.cloud.database();
}

function getCollection() {
  const db = getDatabase();
  return db ? db.collection(COLLECTION_NAME) : null;
}

function formatTimeLabel(dateInput) {
  if (!dateInput) return '';
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) return '';

  const now = new Date();
  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (isSameDay) {
    return `${hh}:${mm}`;
  }
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${month}-${day} ${hh}:${mm}`;
}

function mapDocToGalleryItem(doc) {
  return {
    id: doc.clientId || doc._id,
    dbId: doc._id,
    url: doc.sourceUrl || doc.cloudFileId || '',
    cloudFileId: doc.cloudFileId || '',
    cloudTempUrl: '',
    prompt: doc.prompt || '',
    size: doc.size || '',
    mode: doc.mode || 'text2image',
    round: doc.round || 1,
    time: formatTimeLabel(doc.createdAt || doc.clientCreatedAt),
  };
}

/**
 * 查询当前用户最近的生图历史记录（过滤已软删除记录）
 */
async function listHistory(limit = 20) {
  const db = getDatabase();
  if (!db) return [];

  const _ = db.command;
  const res = await db
    .collection(COLLECTION_NAME)
    .where({
      isDeleted: _.neq(true),
    })
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  const docs = (res && Array.isArray(res.data) && res.data) || [];
  return docs.map(mapDocToGalleryItem);
}

/**
 * 新增一条生图历史记录（由服务端生成 createdAt，SDK 自动附带 _openid）
 */
async function createHistoryRecord(item) {
  const db = getDatabase();
  if (!db || !item) return '';

  const res = await db.collection(COLLECTION_NAME).add({
    data: {
      clientId: item.id || '',
      prompt: item.prompt || '',
      size: item.size || '',
      mode: item.mode || 'text2image',
      round: item.round || 1,
      cloudFileId: item.cloudFileId || '',
      sourceUrl: item.url || '',
      isDeleted: false,
      clientCreatedAt: Date.now(),
      createdAt: db.serverDate(),
    },
  });

  return (res && res._id) || '';
}

/**
 * 回写云存储永久 fileID 到数据库记录
 */
async function updateHistoryCloudFile(dbId, cloudFileId) {
  const col = getCollection();
  if (!col || !dbId || !cloudFileId) return;

  await col.doc(dbId).update({
    data: {
      cloudFileId,
    },
  });
}

/**
 * 软删除指定云端记录（标记 isDeleted: true 与 deletedAt，仅允许更新本人名下文档）
 */
async function softDeleteHistoryRecords(dbIds) {
  const db = getDatabase();
  if (!db || !Array.isArray(dbIds) || dbIds.length === 0) return;

  const validIds = dbIds.filter(Boolean);
  if (validIds.length === 0) return;

  const col = db.collection(COLLECTION_NAME);
  await Promise.all(
    validIds.map((id) =>
      col.doc(id).update({
        data: {
          isDeleted: true,
          deletedAt: db.serverDate(),
        },
      })
    )
  );
}

module.exports = {
  COLLECTION_NAME,
  formatTimeLabel,
  mapDocToGalleryItem,
  listHistory,
  createHistoryRecord,
  updateHistoryCloudFile,
  softDeleteHistoryRecords,
};
