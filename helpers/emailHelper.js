const formData = require("form-data");
const Mailgun = require("mailgun.js");
const mailgun = new Mailgun(formData);

const mg = mailgun.client({
  username: "api",
  key: process.env.MAILGUN_API_KEY,
});

const sendVerificationEmail = async (email, token) => {
  try {
    const link = `https://readora.onrender.com/user/verify?token=${token}`;

    const messageData = {
      from: `Readora <${process.env.MAILGUN_FROM}>`,
      to: email,
      subject: "Readora Email Verification",
      html: `
        <p>Welcome to Readora!</p>
        <p>Please verify your email address by clicking the link below:</p>
        <a href="${link}">Verify your account</a>
        <p>If you did not sign up, you can ignore this email.</p>
      `,
    };

    await mg.messages.create(process.env.MAILGUN_DOMAIN, messageData);
    console.log("✅ Verification email sent successfully to:", email);
  } catch (error) {
    console.error("❌ Error sending verification email:", error);
  }
};

module.exports = { sendVerificationEmail };