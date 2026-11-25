const NotificationModel = require("../models/Notification");
const {
  NOTIFICATION_TYPES,
  NOTIFICATION_CHANNELS,
} = require("../constants/notificationTypes");

/**
 * NOTIFICATION READ LAYER — the in-app inbox.
 *
 * Same shape and same guarantees as the recommendation-history read layer:
 * the user id comes from the verified token and never from a parameter, the
 * serialiser is an allow-list, and pagination is clamped.
 *
 * The inbox shows the IN-APP channel only. Email rows are a delivery ledger —
 * their retry counts and SMTP error strings are operational detail, and a user
 * seeing both channels would see every notification twice.
 */

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

function buildQuery(userId, query = {}) {
  // Always scoped to the caller, always the in-app channel.
  const filter = { userId, channel: NOTIFICATION_CHANNELS.IN_APP };

  const type = String(query.type || "");
  if (type && Object.values(NOTIFICATION_TYPES).includes(type)) filter.type = type;

  // `unread=true` is the badge query. Anything else is ignored rather than
  // guessed at.
  if (String(query.unread) === "true") filter.readAt = null;

  if (query.schemeId) filter.schemeId = String(query.schemeId);

  return filter;
}

function buildPagination(query = {}) {
  const rawPage = parseInt(String(query.page ?? "1"), 10);
  const rawLimit = parseInt(String(query.limit ?? DEFAULT_LIMIT), 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Allow-list. Retry counts, SMTP errors, job ids and the denormalised email
 * are operational and stay server-side; a field added to the model later stays
 * internal until it is named here.
 */
function serialize(row) {
  return {
    id: String(row._id ?? ""),
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    // Lets the UI mark which notifications carry a grounded explanation rather
    // than the generic fallback.
    bodySource: row.bodySource,
    scheme: { schemeId: row.schemeId, name: row.schemeName || "" },
    schemeVersion: row.schemeVersion ?? null,
    changeId: row.triggeringChangeId,
    read: !!row.readAt,
    readAt: row.readAt ?? null,
    createdAt: row.createdAt,
  };
}

async function listUserNotifications({ userId, query = {}, model = NotificationModel } = {}) {
  if (!userId) throw new Error("listUserNotifications requires a userId");

  const filter = buildQuery(userId, query);
  const { page, limit, skip } = buildPagination(query);

  const cursor = model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
  const rows = typeof cursor.lean === "function" ? await cursor.lean() : await cursor;
  const total = await model.countDocuments(filter);
  const unread = await model.countDocuments({
    userId,
    channel: NOTIFICATION_CHANNELS.IN_APP,
    readAt: null,
  });

  return {
    items: (rows || []).map(serialize),
    page,
    limit,
    total,
    unread,
    pages: limit > 0 ? Math.ceil(total / limit) : 0,
  };
}

/**
 * Mark one notification read.
 *
 * The update is filtered by BOTH id and userId, so a caller cannot mark
 * someone else's notification read by guessing an id — the filter simply
 * matches nothing. That is why this reports "not found" rather than checking
 * ownership separately and risking the two falling out of step.
 */
async function markRead({ userId, notificationId, model = NotificationModel } = {}) {
  if (!userId) throw new Error("markRead requires a userId");
  const res = await model.updateOne(
    { _id: notificationId, userId },
    { $set: { readAt: new Date() } }
  );
  return { updated: (res?.modifiedCount || res?.matchedCount || 0) > 0 };
}

/** Mark every unread in-app notification for this user as read. */
async function markAllRead({ userId, model = NotificationModel } = {}) {
  if (!userId) throw new Error("markAllRead requires a userId");
  const res = await model.updateMany(
    { userId, channel: NOTIFICATION_CHANNELS.IN_APP, readAt: null },
    { $set: { readAt: new Date() } }
  );
  return { updated: res?.modifiedCount || 0 };
}

module.exports = {
  listUserNotifications,
  markRead,
  markAllRead,
  buildQuery,
  buildPagination,
  serialize,
  MAX_LIMIT,
  DEFAULT_LIMIT,
};
