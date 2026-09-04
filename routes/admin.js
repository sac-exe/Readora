const express = require("express");
const router = express.Router();
const adminhelper = require("../helpers/admin-helper");
const db = require("../config/connection");

// add this import once at top (you use ObjectId elsewhere)
const { ObjectId } = require("mongodb");

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
  });
  res.render("admin/all-books", { novels});
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

