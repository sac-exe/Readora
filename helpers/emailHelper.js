const nodemailer = require("nodemailer");

async function sendResetEmail(email, token, isStaff = false) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error("Email is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS.");
  }

  const port = Number(SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const resetPath = isStaff ? "/staff/reset-password" : "/user/reset-password";
  const resetUrl = `${baseUrl}${resetPath}?token=${encodeURIComponent(token)}`;

  await transporter.sendMail({
    from: SMTP_FROM || SMTP_USER,
    to: email,
    subject: "Password reset",
    text: `Use this link to reset your password. It expires in 10 minutes:\n\n${resetUrl}`,
    html: `<p>Use this link to reset your password. It expires in 10 minutes:</p><p><a href="${resetUrl}">Reset password</a></p>`
  });
}

module.exports = { sendResetEmail };
