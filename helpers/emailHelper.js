const nodemailer = require("nodemailer");

async function sendResetEmail(email, token, isStaff = false) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_STAFF || process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("Email is not configured. Set SMTP_HOST, SMTP_STAFF (or SMTP_USER), and SMTP_PASS in your deployment environment.");
  }

  const port = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });

  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!baseUrl) {
    throw new Error("Email is not configured. Set APP_BASE_URL to your deployed site URL.");
  }

  const resetPath = isStaff ? "/staff/reset-password" : "/user/reset-password";
  const resetUrl = `${baseUrl}${resetPath}?token=${encodeURIComponent(token)}`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || user,
    to: email,
    subject: "Password reset",
    text: `Use this link to reset your password. It expires in 10 minutes:\n\n${resetUrl}`,
    html: `<p>Use this link to reset your password. It expires in 10 minutes.</p><p><a href="${resetUrl}">Reset password</a></p>`
  });
}

module.exports = { sendResetEmail };
