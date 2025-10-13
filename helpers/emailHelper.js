const nodemailer = require("nodemailer");

const sendResetEmail = async (email, token, isStaff = false) => {
  const transporter = nodemailer.createTransport({
    service: "gmail",        
    auth: {
      user: "readoraofficial@gmail.com", 
      pass: "judjvfwhvacdxdcu",          
    },
  });

  // DIFFERENT RESET LINK for staff and user
  const resetUrl = isStaff 
    ? `http://localhost:3000/staff/reset-password?token=${token}`
    : `http://localhost:3000/user/reset-password?token=${token}`;

  const mailOptions = {
    from: "readora",
    to: email,
    subject: "Readora Password Reset Request",
    text: `You requested a password reset. Use the link below to reset your password:
    ${resetUrl}
    This link will expire in 10 minutes.
    `
  };

  await transporter.sendMail(mailOptions);
  console.log("Reset email sent successfully!");
};


const sendVerificationEmail = async (email, token) => {
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
      <a href="http://localhost:4000/user/verify?token=${token}">Verify your account</a>
      <p>If you did not sign up, you can ignore this email.</p>
    `
  };
  await transporter.sendMail(mailOptions);
  console.log("Verification email sent successfully!");
};

module.exports = { sendResetEmail, sendVerificationEmail };