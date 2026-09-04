const express = require("express");
const router = express.Router();
const adminhelper = require("../helpers/admin-helper");
const db = require("../config/connection");

// add this import once at top (you use ObjectId elsewhere)
const { ObjectId, GridFSBucket } = require("mongodb");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const NOVEL_COVERS_BUCKET = "novelCovers";
const DEFAULT_COVER_URL = "/images/novel-images/novel_dummy.png";

function uploadNovelCover(image) {
  const extension = path.extname(image.name || "").toLowerCase();
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

  if (!allowedTypes.has(image.mimetype) || !allowedExtensions.has(extension)) {
    throw new Error("Cover image must be a JPG, PNG, or WEBP file.");
  }
  if (image.size > 5 * 1024 * 1024) {
    throw new Error("Cover image must be 5MB or smaller.");
  }

  const bucket = new GridFSBucket(db.get(), { bucketName: NOVEL_COVERS_BUCKET });
  const upload = bucket.openUploadStream(`${crypto.randomUUID()}${extension}`, {
    contentType: image.mimetype,
    metadata: { originalName: image.name, uploadedAt: new Date() }
  });

  return new Promise((resolve, reject) => {
    upload.on("error", reject);
    upload.on("finish", () => resolve(upload.id));
    upload.end(image.data);
  });
}

/*
// TEMP: REMOVE AFTER  USE
const bcrypt = require("bcrypt");

// TEMP signup form route (optional, if you have a view)
router.get("/admin/signup", (req, res) => {
  res.render("admin/adminsignup");
});

// TEMP signup handler — creates first admin
router.post("/admin/signup", async (req, res) => {
  try {
    var { Username, Password } = req.body;
    if (!Username || !Password) return res.status(400).send("Missing fields");

    const exists = await db.get().collection("admin").findOne({ Username });
    if (exists) return res.status(400).send("Username exists");

    var Password= await bcrypt.hash(Password, 12);
    await db.get().collection("admin").insertOne({
      Username,
      Password,
      role: "admin",
      createdAt: new Date()
    });

    return res.redirect("/admin/login");
  } catch (e) {
    return res.status(500).send("Signup error");
  }
});

*/

// Admin login page
router.get("/admin/login", (req, res) => {
  if (req.session.NotLog) {
    res.render("admin/admin-login", { Loginerr: req.session.Loginerr });
    req.session.Loginerr = false;
  } else {
    res.render("admin/admin-login");
  }
});

function requireAdmin(req, res, next) {
  if (!req.session?.admin?.id || req.session.admin.role !== "admin") {
    return res.redirect("/admin/login");
  }
  next();
}

router.post("/admin/login", (req, res, next) => {
  adminhelper.adminLogin(req.body)
    .then((result) => {
      if (!result?.status) {
        req.session.NotLog = true;
        req.session.Loginerr = "*Invalid Username or Password*";
        return res.redirect("/admin/login");
      }

      req.session.regenerate((err) => {
        if (err) return next(err);

        req.session.admin = {
          id: result.admin._id.toString(),
          role: "admin"
        };

        req.session.save((err) => {
          if (err) return next(err);
          res.redirect("/admin/home");
        });
      });
    })
    .catch(next);
});

// Keep this after the public login route. Registering it earlier intercepts
// POST /admin/login and redirects before credentials can be checked.
router.use("/admin", requireAdmin);

// Handle login POST
// router.post("/admin/login", (req, res) => {
//   adminhelper.adminLogin(req.body).then((status) => {
//     if (status) {
//       res.redirect("/admin/home");
//     } else {
//       req.session.NotLog = true;
//       req.session.Loginerr = "*Invalid Username or Password*";
//       res.redirect("/admin/login");
//     }
//   });
// });

const logCoinTransaction = async ({
  userType, // "user" or "staff"
  userId,
  type, // e.g. "admin_gift", "admin_takeback"
  amount,
  status = "success",
  paymentMethod = "admin"
}) => {
  await db.get().collection("coin_transactions").insertOne({
    userType,
    userId: new ObjectId(userId),
    type,
    amount,
    status,
    paymentMethod,
    createdAt: new Date()
  });
};

//  Home Page
router.get("/admin/home", async (req, res) => {
  try {
    const usersCount = await adminhelper.countUsers();
    const staffCount = await adminhelper.countStaff();
    const booksCount = await adminhelper.countBooks();

    console.log({usersCount, staffCount, booksCount});

    res.render("admin/admin-home", { usersCount, staffCount, booksCount });
  } catch (err) {
    res.status(500).send("Dashboard error");
  }
});

// View ALL USERS
router.get("/admin/users", async (req, res) => {
  const users = await db.get().collection("user").find().toArray();
  // Format the date for each user
  users.forEach(u => {
    u.profileImage = u.profileImage || "/images/default-profile.png";
    if (u.createdAt) {
      u.createdAt = new Date(u.createdAt).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric'
      });
    } else {
      u.createdAt = "N/A";
    }
  });
  res.render("admin/all-users", { user: users });
});


// View ALL STAFF
router.get("/admin/staffs", async (req, res) => {
  const staffs = await db.get().collection("staff").find().toArray();
  // Format the date for each user
  staffs.forEach(u => {
    u.profileImage = u.profileImage || "/images/default-profile.png";
    if (u.createdAt) {
      u.createdAt = new Date(u.createdAt).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric'
      });
    } else {
      u.createdAt = "N/A";
    }
  });
  res.render("admin/all-staff", { staff: staffs });
});

// View ALL Novels
router.get("/admin/books", async (req, res) => {
  const novels = await db.get().collection("novels").find().toArray();
  // Format the date for each user
  novels.forEach(n => {
    if (n.createdAt) {
      n.createdAt = new Date(n.createdAt).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric'
      });
    } else {
      n.createdAt = "N/A";
    }
    n.imageUrl = n.imageUrl || DEFAULT_COVER_URL;
  });
  res.render("admin/all-books", { novels, coverMessage: req.session.coverMessage });
  delete req.session.coverMessage;
});

// Shared defaults are regular public files. Replacing either file updates the
// fallback image used by every user, staff member, and admin page.
router.get("/admin/default-images", (req, res) => {
  res.render("admin/default-images", { message: req.session.defaultImageMessage });
  delete req.session.defaultImageMessage;
});

router.post("/admin/default-images/:type", async (req, res) => {
  const targets = {
    profile: path.join(__dirname, "../public/images/default-profile.png"),
    cover: path.join(__dirname, "../public/images/novel-images/novel_dummy.png")
  };
  try {
    const target = targets[req.params.type];
    const image = req.files?.image;
    if (!target || !image) throw new Error("Choose an image first.");
    if (image.mimetype !== "image/png" || path.extname(image.name).toLowerCase() !== ".png") {
      throw new Error("Default images must be PNG files.");
    }
    if (image.size > 5 * 1024 * 1024) throw new Error("Image must be 5MB or smaller.");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await image.mv(target);
    req.session.defaultImageMessage = "Default image updated for the whole site.";
  } catch (error) {
    req.session.defaultImageMessage = error.message || "Could not update the default image.";
  }
  res.redirect("/admin/default-images");
});

// Replace a missing or dummy cover from the admin book-management page.
router.post("/admin/books/:id/cover", async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      req.session.coverMessage = "Invalid novel.";
      return res.redirect("/admin/books");
    }
    if (!req.files?.cover) {
      req.session.coverMessage = "Choose a JPG, PNG, or WEBP cover first.";
      return res.redirect("/admin/books");
    }

    const coverId = await uploadNovelCover(req.files.cover);
    const result = await db.get().collection("novels").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { imageUrl: `/images/novel-images/${coverId}`, updatedAt: new Date() } }
    );
    req.session.coverMessage = result.matchedCount
      ? "Cover updated successfully."
      : "Novel was not found.";
  } catch (error) {
    console.error("Admin cover upload error:", error);
    req.session.coverMessage = error.message || "Could not upload the cover.";
  }
  return res.redirect("/admin/books");
});


// Ban a user
router.post("/admin/ban-user/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  await db.get().collection("user").updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { banned: true } }
  );
  res.json({ message: "User banned!" });
});

// Kick a user (example: delete user)
router.post("/admin/kick-user/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  await db.get().collection("user").deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ message: "User kicked (deleted)!" });
});

router.post('/admin/appoint-staff', async (req, res) => {
  const { Username } = req.body;
  if (!Username) return res.json({ success: false, message: "Username required." });
  const user = await db.get().collection('user').findOne({ Username });
  if (!user) return res.json({ success: false, message: "User not found." });

  // Check if already staff
  const staffExists = await db.get().collection('staff').findOne({ Username });
  if (staffExists) return res.json({ success: false, message: "Already a staff member." });

  // Copy user to staff collection
  await db.get().collection('staff').insertOne({
    ...user,
    appointedAt: new Date()
  });

  // Delete user from user collection after appointing as staff
  await db.get().collection('user').deleteOne({ _id: user._id });

  res.json({ success: true });
});

// Ban a staff member
router.post("/admin/ban-staff/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  await db.get().collection("staff").updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { banned: true } }
  );
  res.json({ message: "Staff banned!" });
});

// Kick a staff member (delete staff)
router.post("/admin/kick-staff/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  await db.get().collection("staff").deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ message: "Staff kicked (deleted)!" });
});


// Delete a book
router.post("/admin/delete-book/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  await db.get().collection("books").deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ message: "Book deleted!" });
});




function isValidObjectId(id) {
  return ObjectId.isValid(id) && (String)(new ObjectId(id)) === id;
}

// Gift coins to user (modified)
router.post('/admin/gift-coins', async (req, res) => {
  const { userId, coins } = req.body;
  if (!userId || !coins || coins <= 0)
    return res.json({ success: false, message: "Invalid input." });
  if (!isValidObjectId(userId))
    return res.json({ success: false, message: "Invalid user ID." });

  try {
    const userObjectId = new ObjectId(userId);
    const user = await db.get().collection('user').findOne({ _id: userObjectId });
    if (!user) return res.json({ success: false, message: "User not found." });

    const result = await db.get().collection('user').findOneAndUpdate(
      { _id: userObjectId },
      { $inc: { coins: coins } },
      { returnDocument: "after" }
    );

    // Log the transaction
    await logCoinTransaction({
      userType: "user",
      userId,
      type: "admin_gift",
      amount: coins,
      status: "success",
      paymentMethod: "admin"
    });

    res.json({ success: true, coins: (result.value ? result.value.coins : user.coins + coins) });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Internal server error." });
  }
});


router.post('/admin/takeback-coins', async (req, res) => {
  try {
    const { userId, coins } = req.body; // <-- FIX: extract from body
    if (!userId || !coins || coins <= 0)
      return res.json({ success: false, message: "Invalid input." });

    const userObjectId = new ObjectId(userId);
    const user = await db.get().collection('user').findOne({ _id: userObjectId });
    if (!user) return res.json({ success: false, message: "User not found." });
    if ((user.coins || 0) < coins) {
      return res.json({ success: false, message: "User does not have enough coins to take back." });
    }

    const result = await db.get().collection('user').findOneAndUpdate(
      { _id: userObjectId },
      { $inc: { coins: -coins } },
      { returnDocument: "after" }
    );

    // Log transaction
    await logCoinTransaction({
      userType: "user",
      userId,
      type: "admin_takeback",
      amount: coins,
      status: "success",
      paymentMethod: "admin"
    });

    res.json({ success: true, coins: (result.value ? result.value.coins : user.coins - coins) });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Internal server error." });
  }
});

// Gift coins to staff
router.post('/admin/gift-coins-staff', async (req, res) => {
  const { userId, coins } = req.body;
  if (!userId || !coins || coins <= 0)
    return res.json({ success: false, message: "Invalid input." });
  if (!isValidObjectId(userId))
    return res.json({ success: false, message: "Invalid staff ID." });

  try {
    const staffObjectId = new ObjectId(userId);
    const staff = await db.get().collection('staff').findOne({ _id: staffObjectId });
    if (!staff) return res.json({ success: false, message: "Staff not found." });

    const result = await db.get().collection('staff').findOneAndUpdate(
      { _id: staffObjectId },
      { $inc: { coins: coins } },
      { returnDocument: "after" }
    );

    // Log the transaction
    await logCoinTransaction({
      userType: "staff",
      userId,
      type: "admin_gift",
      amount: coins,
      status: "success",
      paymentMethod: "admin"
    });

    res.json({ success: true, coins: (result.value ? result.value.coins : staff.coins + coins) });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Internal server error." });
  }
});


// Take back coins from staff
router.post('/admin/takeback-coins-staff', async (req, res) => {
  const { userId, coins } = req.body;
  if (!userId || !coins || coins <= 0)
    return res.json({ success: false, message: "Invalid input." });
  if (!isValidObjectId(userId))
    return res.json({ success: false, message: "Invalid staff ID." });

  try {
    const staffObjectId = new ObjectId(userId);
    const staff = await db.get().collection('staff').findOne({ _id: staffObjectId });
    if (!staff) return res.json({ success: false, message: "Staff not found." });
    if ((staff.coins || 0) < coins) {
      return res.json({ success: false, message: "Staff does not have enough coins to take back." });
    }

    const result = await db.get().collection('staff').findOneAndUpdate(
      { _id: staffObjectId },
      { $inc: { coins: -coins } },
      { returnDocument: "after" }
    );

    // Log transaction
    await logCoinTransaction({
      userType: "staff",
      userId,
      type: "admin_takeback",
      amount: coins,
      status: "success",
      paymentMethod: "admin"
    });

    res.json({ success: true, coins: (result.value ? result.value.coins : staff.coins - coins) });
  } catch (err) {
    console.error(err);
    res.json({ success: false, message: "Internal server error." });
  }
});


router.get("/admin/coin-transactions", async (req, res) => {
  const transactions = await db.get().collection("coin_transactions")
    .find({})
    .sort({ createdAt: -1 })
    .toArray();

  res.render("admin/coin-transactions", { transactions });
});

// Logout
router.get("/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("readora.sid");
    res.redirect("/admin/login");
  });
});

module.exports = router;

