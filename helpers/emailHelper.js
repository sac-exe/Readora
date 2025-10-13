const nodemailer = require('nodemailer');

const sendVerificationEmail = async (email, token) => {
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "readoraofficial@gmail.com",
        pass: "hjyqvspkssmpwryk",
      },
    });
    const mailOptions = {
      from: "readora",
      to: email,
      subject: "Readora Email Verification",
      html: `
        <p>Welcome to Readora!</p>
        <p>Please verify your email address by clicking the link below:</p>
        <a href="https://readora.onrender.com/user/verify?token=${token}">Verify your account</a>
        <p>If you did not sign up, you can ignore this email.</p>
      `
    };
    await transporter.sendMail(mailOptions);
    console.log("Verification email sent successfully!");
  } catch (error) {
    console.error("Error sending verification email:", error);
  }
};

module.exports = { sendResetEmail, sendVerificationEmail };