'use strict';

/**
 * Notion routes — Kairune.
 *
 * Guard
 * -----
 * Every write is opt-in (X-Admin-Key). Reads without admin are rate-limited.
 * The token itself is never echoed back — GET /api/notion/status only reports
 * {configured, workspace}.
 */

const express = require('express');
const { requireAdmin } = require('../middleware/moderation');
const notion = require('../services/notion');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const router = express.Router();

function notionStatusPayload(bot) {
  const botOwner = bot && bot.bot && bot.bot.owner;
  return {
    configured: true,
    notion_version: notion.NOTION_VERSION,
    bot: bot ? { id: bot.id, name: bot.name, type: bot.type } : null,
    workspace: bot && bot.bot ? { name: bot.bot.workspace_name, id: bot.bot.workspace_id } : null,
    owner_type: botOwner ? botOwner.type : null,
  };
}

router.get(
  '/notion/status',
  wrap(async (_req, res) => {
    if (!notion.isConfigured()) {
      return res.json({ configured: false, notion_version: notion.NOTION_VERSION });
    }
    const bot = await notion.getBotUser();
    res.json(notionStatusPayload(bot));
  }),
);

router.post(
  '/notion/setup',
  wrap(async (req, res) => {
    requireAdmin(req);
    const { parent_page_id, title_prefix } = req.body || {};
    if (!parent_page_id || typeof parent_page_id !== 'string') {
      const err = new Error('parent_page_id is required');
      err.status = 400;
      throw err;
    }
    const prefix = String(title_prefix || 'Kairune').trim() || 'Kairune';

    // Verify parent is reachable.
    await notion.getPage(parent_page_id);

    // The 2026-03-11 API separates a database (a container) from its
    // data_sources (the queryable schema). createDatabase returns the container
    // id; row writes and queries need the child data_source id, and the
    // `Name` title is the only property it creates regardless of what you ask
    // for — extra columns must be added by PATCHing the data_source afterwards.
    // Both of those are bugs if you assume the older single-id model, so this
    // helper collapses create -> resolve -> extend into one honest result.
    const buildSchema = async (titleText, props) => {
      const db = await notion.createDatabase({
        parent: { type: 'page_id', page_id: parent_page_id },
        title: [{ type: 'text', text: { content: titleText } }],
        properties: { Name: props.Name },
      });
      const dsId = db.data_sources && db.data_sources[0] && db.data_sources[0].id;
      if (!dsId) {
        const err = new Error('Notion did not return a data_source for the new database');
        err.status = 502;
        throw err;
      }
      // Add every non-title column in one PATCH so the schema matches what
      // /ship-log and /queue write.
      const extra = Object.fromEntries(
        Object.entries(props).filter(([k]) => k !== 'Name')
      );
      if (Object.keys(extra).length) {
        await notion.updateDataSource(dsId, extra);
      }
      return { database_id: db.id, data_source_id: dsId, url: db.url };
    };

    const [shipLog, contentQueue] = await Promise.all([
      buildSchema(`${prefix} — Ship Log`, {
        Name: { title: {} },
        Commit: { rich_text: {} },
        Tag: { select: { options: [
          { name: 'trust', color: 'green' },
          { name: 'spend', color: 'blue' },
          { name: 'brand', color: 'purple' },
          { name: 'infra', color: 'gray' },
          { name: 'other', color: 'default' },
        ] } },
        Summary: { rich_text: {} },
        ShippedAt: { date: {} },
      }),
      buildSchema(`${prefix} — Content Queue`, {
        Name: { title: {} },
        Kind: { select: { options: [
          { name: 'tweet', color: 'blue' },
          { name: 'brand-copy', color: 'purple' },
          { name: 'changelog', color: 'green' },
          { name: 'other', color: 'default' },
        ] } },
        Status: { select: { options: [
          { name: 'draft', color: 'yellow' },
          { name: 'ready', color: 'green' },
          { name: 'posted', color: 'gray' },
          { name: 'skipped', color: 'red' },
        ] } },
        Body: { rich_text: {} },
        DueAt: { date: {} },
      }),
    ]);

    res.status(201).json({ ship_log: shipLog, content_queue: contentQueue });
  }),
);

router.post(
  '/notion/ship-log',
  wrap(async (req, res) => {
    requireAdmin(req);
    const { data_source_id, commit, message, tag, summary } = req.body || {};
    if (!data_source_id || !commit) {
      const err = new Error('data_source_id and commit are required');
      err.status = 400;
      throw err;
    }
    const page = await notion.createPage({
      parent: { data_source_id },
      properties: {
        Name: { title: [{ type: 'text', text: { content: String(commit).slice(0, 40) } }] },
        Commit: { rich_text: [{ type: 'text', text: { content: String(commit).slice(0, 2000) } }] },
        Tag: { select: { name: String(tag || 'other').slice(0, 32) } },
        Summary: { rich_text: [{ type: 'text', text: { content: String(summary || message || '').slice(0, 2000) } }] },
        ShippedAt: { date: { start: new Date().toISOString() } },
      },
    });
    res.status(201).json({ id: page.id, url: page.url });
  }),
);

router.post(
  '/notion/queue',
  wrap(async (req, res) => {
    requireAdmin(req);
    const { data_source_id, title, kind, status, body } = req.body || {};
    if (!data_source_id || !title) {
      const err = new Error('data_source_id and title are required');
      err.status = 400;
      throw err;
    }
    const page = await notion.createPage({
      parent: { data_source_id },
      properties: {
        Name: { title: [{ type: 'text', text: { content: String(title).slice(0, 200) } }] },
        Kind: kind ? { select: { name: String(kind).slice(0, 32) } } : undefined,
        Status: { select: { name: String(status || 'draft').slice(0, 32) } },
        Body: body ? { rich_text: [{ type: 'text', text: { content: String(body).slice(0, 2000) } }] } : undefined,
      },
    });
    res.status(201).json({ id: page.id, url: page.url });
  }),
);

router.post(
  '/notion/query',
  wrap(async (req, res) => {
    const { data_source_id, filter, sorts, page_size } = req.body || {};
    if (!data_source_id) {
      const err = new Error('data_source_id is required');
      err.status = 400;
      throw err;
    }
    const data = await notion.queryDataSource(data_source_id, {
      filter, sorts,
      pageSize: Math.min(Math.max(Number(page_size) || 20, 1), 100),
    });
    res.json(data);
  }),
);

module.exports = router;
