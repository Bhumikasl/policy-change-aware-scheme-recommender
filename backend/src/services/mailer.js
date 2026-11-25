const nodemailer = require("nodemailer");
const logger = require("../utils/logger");

let transporter = null;

function getTransporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) {
    return null;
  }
  if (!transporter) {
    // Gmail SMTP via an App Password (not the account's real password) -
    // requires 2-Step Verification enabled on the Google account first.
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_APP_PASSWORD,
      },
    });
  }
  return transporter;
}

function buildEmail(scheme, summary, eventType) {
  const label = eventType === "NEW" ? "🆕 New Scheme" : "🔄 Scheme Updated";
  const subject = `${eventType === "NEW" ? "New scheme" : "Scheme updated"}: ${scheme.name}`;

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <p style="display:inline-block; background:#16A34A; color:#fff; padding:4px 10px; border-radius:4px; font-size:13px;">${label}</p>
      <h2 style="margin-top:12px;">${scheme.name}</h2>
      <p>${summary}</p>
      ${scheme.ministry ? `<p><strong>Ministry:</strong> ${scheme.ministry}</p>` : ""}
      ${scheme.lastDate ? `<p><strong>Deadline:</strong> ${scheme.lastDate}</p>` : ""}
      ${scheme.applicationLink ? `<p><a href="${scheme.applicationLink}">Apply here</a></p>` : ""}
      ${scheme.sourceUrl ? `<p><a href="${scheme.sourceUrl}">View full scheme details</a></p>` : ""}
      <hr />
      <p style="font-size:12px; color:#888;">You're receiving this because this scheme matches your profile on Scheme Monitor.</p>
    </div>
  `;

  return { subject, html };
}

/**
 * Sends a scheme notification email to one user.
 * Never throws - a mail failure shouldn't crash the collection pipeline.
 * Returns true on success, false otherwise (including "not configured").
 */
async function sendSchemeEmail(user, scheme, summary, eventType) {
  const t = getTransporter();
  if (!t) {
    logger.warn(`[EMAIL FALLBACK -> ${user.email}] SMTP not configured (SMTP_USER/SMTP_APP_PASSWORD missing in .env)`);
    return false;
  }

  const { subject, html } = buildEmail(scheme, summary, eventType);

  try {
    await t.sendMail({
      from: `"Scheme Monitor" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject,
      html,
    });
    logger.info(`Email sent -> ${user.email} (${subject})`);
    return true;
  } catch (err) {
    logger.warn(`Email send failed -> ${user.email}`, { error: err.message });
    return false;
  }
}

module.exports = { sendSchemeEmail };