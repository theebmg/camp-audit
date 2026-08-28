import express from 'express';
import { buildActivity, buildCapitalPlan } from '../reportData.js';
import { renderActivityHtml, renderActivityText, renderCapitalHtml, renderCapitalText } from '../reportRender.js';
import { sendReportEmail } from '../mailer.js';

const router = express.Router();

async function buildReport(type, { from, to }) {
  if (type === 'summary' || type === 'detailed') {
    const entries = await buildActivity({ from, to, limit: 1000 });
    const detailed = type === 'detailed';
    return {
      title: detailed ? 'Detailed Activity Log' : 'Activity Summary',
      html: renderActivityHtml({ entries, from, to, detailed }),
      text: renderActivityText({ entries, from, to, detailed }),
    };
  }
  if (type === 'capital') {
    const { rows, summary } = await buildCapitalPlan({});
    return {
      title: 'Capital Plan',
      html: renderCapitalHtml({ rows, summary }),
      text: renderCapitalText({ rows, summary }),
    };
  }
  const err = new Error(`Unknown report type "${type}"`);
  err.status = 400;
  throw err;
}

router.get('/preview', async (req, res, next) => {
  try {
    const { type, from, to } = req.query;
    res.json(await buildReport(type, { from, to }));
  } catch (e) { next(e); }
});

router.post('/send', async (req, res, next) => {
  try {
    const { type, from, to, recipient, subject } = req.body || {};
    if (!recipient) return res.status(400).json({ ok: false, error: 'recipient is required' });
    const report = await buildReport(type, { from, to });
    await sendReportEmail({
      to: recipient,
      subject: subject || `Camp Sychar — ${report.title}`,
      html: report.html,
      text: report.text,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
