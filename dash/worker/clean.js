// What the Setup page is allowed to save.
//
// Pure, and in its own file, because store.js imports schema.sql through a
// wrangler rule and so cannot be loaded in Node -- which would have left every
// validation rule here untestable. The calendar learned the same lesson with
// its blanking rules.
//
// Everything typed in by hand goes through this, so a row keyed in cannot be
// shaped differently from a row that was seeded from the repo.

import { EVERYONE } from './tiles.js';

const splitList = (s) => String(s || '').split(',')
  .map((x) => x.trim().toLowerCase()).filter(Boolean);

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanKey(s) {
  const k = String(s || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return KEY_RE.test(k) ? k : '';
}

const text = (s, max) => String(s == null ? '' : s).trim().slice(0, max);

// A url is stored only if it is one we would be willing to send somebody to.
// Anything else is stored as empty, which means the tile is not drawn -- a
// broken link on a portal is worse than a missing tile, because it looks like
// the tool is broken rather than absent.
export function cleanUrl(s) {
  const raw = text(s, 500);
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch (err) { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  return u.href;
}

// Returns { row } or { errors }. Validated against the live categories and
// groups, so a tile cannot be filed under a category that does not exist or
// handed to a group nobody is in.
export function cleanTile(input, cat, grp) {
  const errors = [];
  const key = cleanKey(input && input.key);
  if (!key) errors.push('A tile needs a key: lower case letters, numbers and dashes.');

  const name = text(input && input.name, 80);
  if (!name) errors.push('A tile needs a name.');

  const category = cleanKey(input && input.category);
  if (!cat.some((c) => c.key === category)) errors.push('Pick a category that exists.');

  const want = Array.isArray(input && input.groups) ? input.groups : splitList(input && input.groups);
  const groups = want.map((g) => String(g).trim().toLowerCase()).filter(Boolean);
  for (const g of groups) {
    if (g !== EVERYONE && !grp.some((x) => x.key === g)) errors.push('No such group: ' + g);
  }
  if (!groups.length) errors.push('A tile nobody is given is a tile nobody sees.');

  const url = cleanUrl(input && input.url);
  const status = (input && input.status) === 'live' ? 'live' : 'soon';
  // Saying "live" without somewhere to go would put an empty link on the page.
  if (status === 'live' && !url) {
    errors.push('A live tile needs a web address starting https://.');
  }

  if (errors.length) return { errors };
  return {
    row: {
      key, name, url, status, category,
      blurb: text(input && input.blurb, 300),
      icon: cleanKey(input && input.icon) || 'link',
      groups: groups.join(','),
      sort: Number.isFinite(Number(input && input.sort)) ? Number(input.sort) : 0,
    },
  };
}

export function cleanPerson(input, grp) {
  const errors = [];
  const email = text(input && input.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) errors.push('That does not look like an email address.');

  const want = Array.isArray(input && input.groups) ? input.groups : splitList(input && input.groups);
  const groups = want.map((g) => String(g).trim().toLowerCase()).filter(Boolean);
  for (const g of groups) {
    if (!grp.some((x) => x.key === g)) errors.push('No such group: ' + g);
  }

  if (errors.length) return { errors };
  return { row: { email, name: text(input && input.name, 80), groups: groups.join(',') } };
}

