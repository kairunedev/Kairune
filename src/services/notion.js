'use strict';

/**
 * Notion service — Kairune.
 *
 * Why this exists
 * ---------------
 * The registry / spends / attestations stay in libSQL (Notion is far too slow
 * and rate-limited to be a production store). Notion is used as a push-only
 * sidecar for two things that were previously lost in chat history:
 *
 *   1. Ship log — every commit that reaches main gets a row (commit, message,
 *      tag) so the changelog survives chat compaction.
 *   2. Content queue — tweet / brand copy drafts ahead of posting, so nothing
 *      disappears between sessions.
 *
 * Design constraints
 * ------------------
 * - No new npm dependency. Node 18+ has global fetch; Notion's API is plain
 *   REST at https://api.notion.com with header Notion-Version: 2026-03-11.
 * - The token NEVER lives in code or git. It is read from NOTION_API_KEY at
 *   call time. .env is gitignored, .env.example only documents the name.
 * - All writes are explicit (POST /api/notion/... with X-Admin-Key). Nothing
 *   auto-creates databases on boot or on deploy — the operator decides the
 *   parent page once and then pushes.
 * - Endpoints use /v1/data_sources/{id}/query (the current API), not the
 *   deprecated /v1/databases/... path.
 */

const NOTION_VERSION = '2026-03-11';
const BASE = 'https://api.notion.com';

function getApiKey() {
  return (process.env.NOTION_API_KEY || '').trim() || null;
}

function isConfigured() {
  return Boolean(getApiKey());
}

async function notionFetch(path, { method = 'GET', body = null } = {}) {
  const key = getApiKey();
  if (!key) {
    const err = new Error('Notion is not configured: set NOTION_API_KEY');
    err.status = 503;
    throw err;
  }
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + key,
      'Notion-Version': NOTION_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 2000) }; }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Notion ${res.status}`);
    err.status = res.status;
    err.notion = data;
    throw err;
  }
  return data;
}

async function getBotUser() {
  return notionFetch('/v1/users/me');
}

async function search({ filter, pageSize = 10, startCursor } = {}) {
  const body = { page_size: pageSize };
  if (filter) body.filter = filter;
  if (startCursor) body.start_cursor = startCursor;
  return notionFetch('/v1/search', { method: 'POST', body });
}

async function queryDataSource(dataSourceId, { filter, sorts, pageSize = 20, startCursor } = {}) {
  const body = { page_size: pageSize };
  if (filter) body.filter = filter;
  if (sorts) body.sorts = sorts;
  if (startCursor) body.start_cursor = startCursor;
  return notionFetch(`/v1/data_sources/${dataSourceId}/query`, { method: 'POST', body });
}

async function getDataSource(dataSourceId) {
  return notionFetch(`/v1/data_sources/${dataSourceId}`);
}

async function getPage(pageId) {
  return notionFetch(`/v1/pages/${pageId}`);
}

async function createPage({ parent, properties, icon, cover }) {
  const body = { parent, properties };
  if (icon) body.icon = icon;
  if (cover) body.cover = cover;
  return notionFetch('/v1/pages', { method: 'POST', body });
}

async function createDatabase({ parent, title, properties, icon }) {
  const body = { parent, title, properties };
  if (icon) body.icon = icon;
  return notionFetch('/v1/databases', { method: 'POST', body });
}

async function updateDataSource(dataSourceId, properties) {
  return notionFetch(`/v1/data_sources/${dataSourceId}`, { method: 'PATCH', body: { properties } });
}

async function appendBlocks(blockId, children) {
  return notionFetch(`/v1/blocks/${blockId}/children`, { method: 'PATCH', body: { children } });
}

module.exports = {
  NOTION_VERSION,
  isConfigured,
  getApiKey,
  notionFetch,
  getBotUser,
  search,
  queryDataSource,
  getDataSource,
  getPage,
  createPage,
  createDatabase,
  updateDataSource,
  appendBlocks,
};
