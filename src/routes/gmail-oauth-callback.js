// Gmail OAuth callback — mounted at the exact, full path Google redirects to (see
// src/gmailOAuth.js's REDIRECT_URI), BEFORE the '/api/pg' requireAuth block in server.js, for
// the same reason the calendar one is: the caller is a plain browser top-level navigation
// initiated by Google, not an authenticated fetch from this app's frontend, so it cannot sit
// behind the session gate.
//
// Mounting at the fully-specific callback path means this is the ONLY gmail route that bypasses
// auth — '/api/pg/gmail/oauth/start' and the status/disconnect routes stay authenticated.
//
// The browser still carries the session cookie on this navigation (a same-site top-level GET),
// so req.session is available both to verify the CSRF state that /oauth/start wrote and to
// record who connected it.
import express from 'express';
import { exchangeCodeForTokens, fetchGrantedEmail, emailFromIdToken } from '../gmailOAuth.js';
import { setMailOAuthToken } from '../db.js';

const router = express.Router();

router.get('/', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/?mailError=${encodeURIComponent(String(error))}`);
  }
  if (!state || state !== req.session?.gmailOauthState) {
    return res.redirect(`/?mailError=${encodeURIComponent('OAuth state mismatch — please retry from the admin screen.')}`);
  }
  delete req.session.gmailOauthState;

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // buildAuthUrl always sets prompt=consent, so this should only happen if Google changes
      // behaviour. Surfacing it beats storing a connection that can never refresh itself.
      throw new Error(
        'Google did not return a refresh token. Remove this app under your Google Account → '
        + 'Security → Third-party access, then connect again.'
      );
    }
    // The id_token first — it is in the response we already have. userinfo is a fallback for a
    // grant made before 'email' was requested.
    const grantedEmail = emailFromIdToken(tokens.id_token)
      || await fetchGrantedEmail(tokens.access_token);
    if (!grantedEmail) {
      // Storing a connection with no address against it is what produced a "connected" screen
      // that could not send a thing. Refuse it instead.
      throw new Error(
        'Google did not say which account granted access, so the connection cannot be used to '
        + 'send. Reconnect and make sure the consent screen lists the email permission.'
      );
    }
    await setMailOAuthToken({
      refreshToken: tokens.refresh_token,
      user: grantedEmail,
      by: req.session?.user || null,
    });
    res.redirect(`/?mailConnected=${encodeURIComponent(grantedEmail || 'connected')}`);
  } catch (e) {
    console.error('gmail-oauth callback failed:', e.message);
    res.redirect(`/?mailError=${encodeURIComponent(e.message)}`);
  }
});

export default router;
