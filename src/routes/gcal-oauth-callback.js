// Google OAuth callback (Build Brief v4 Part 1) — mounted at the exact,
// full path Google redirects to (see src/gcal.js's REDIRECT_URI), BEFORE
// the '/api/pg' requireAuth block in server.js, for the same reason
// mail-inbound/receipt-inbound/mail-dispatch are: the caller here is a
// plain browser top-level navigation initiated by Google, not an
// authenticated fetch from this app's own frontend, so it can't sit behind
// the session gate the way /gcal/status and /gcal/disconnect (in
// pg-api.js) do. Mounting at the fully-specific callback path rather than a
// shared '/gcal' prefix means this is the ONLY gcal route that bypasses
// auth — '/api/pg/gcal/oauth/start', '/gcal/status', and
// '/gcal/disconnect' all stay under the authenticated catch-all.
//
// The browser still carries the session cookie on this navigation (a
// same-site top-level GET), so req.session is available here to both read
// the CSRF state /oauth/start wrote and to record who connected it.
// Deliberately does NOT pick or create a calendar (2026-09-14 revision) —
// that now happens as its own step from the admin screen, after connecting,
// because listing/creating calendars needs an access token this callback
// has only just obtained, and because Ben may already have a calendar built
// for this (e.g. one made directly in the camp Google account and shared to
// his own) rather than always wanting a fresh auto-created one. See
// saveGcalCalendar/listWritableCalendars for that step.
import express from 'express';
import { exchangeCodeForTokens, getPrimaryCalendarEmail } from '../gcal.js';
import { saveGcalConnection } from '../db.js';

const router = express.Router();

router.get('/', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/?gcalError=${encodeURIComponent(String(error))}`);
  }
  if (!state || state !== req.session?.gcalOauthState) {
    return res.redirect(`/?gcalError=${encodeURIComponent('OAuth state mismatch — please retry from the admin screen.')}`);
  }
  delete req.session.gcalOauthState;

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // buildAuthUrl always sets prompt=consent, so this should only ever
      // happen if Google's behavior changes — surfacing it beats silently
      // storing a connection that can never refresh its access token.
      throw new Error('Google did not return a refresh token. Try removing this app\'s access under your Google Account\'s "Third-party access" settings, then reconnect.');
    }
    const googleEmail = await getPrimaryCalendarEmail(tokens.access_token);
    await saveGcalConnection({
      refreshToken: tokens.refresh_token, googleEmail,
      connectedBy: req.session?.user || null,
    });
    res.redirect(`/?gcalConnected=${encodeURIComponent(googleEmail)}`);
  } catch (e) {
    console.error('gcal-oauth callback failed:', e.message);
    res.redirect(`/?gcalError=${encodeURIComponent(e.message)}`);
  }
});

export default router;
